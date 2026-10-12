import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlaylist, useAudioPlaylistStatus, type AudioPlaylistStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  FlatList,
  Image,
  LayoutChangeEvent,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar as SystemStatusBar } from 'react-native';

const FOLDERS_KEY = 'mp3fy.selectedFolders.v1';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type Folder = { name: string; uri: string };
type Track = { folderName: string; folderUri: string; name: string; uri: string };
type PlaybackMode = 'shuffle' | 'sequential';
type RepeatMode = 'all' | 'one';
type Screen =
  | { kind: 'folders' }
  | { kind: 'songs'; folderUri: string }
  | { kind: 'player'; returnTo: 'folders' | 'songs' };

async function scanDirectory(directory: Directory, folder: Folder): Promise<Track[]> {
  const tracks: Track[] = [];
  for (const item of directory.list()) {
    if (item instanceof Directory) {
      tracks.push(...(await scanDirectory(item, folder)));
    } else if (item instanceof File && item.name.toLowerCase().endsWith('.mp3')) {
      tracks.push({ folderName: folder.name, folderUri: folder.uri, name: item.name, uri: item.uri });
    }
  }
  return tracks;
}

async function scanFolders(folders: Folder[]): Promise<Track[]> {
  const results = await Promise.all(folders.map(async (folder) => {
    try {
      return await scanDirectory(new Directory(folder.uri), folder);
    } catch {
      return [];
    }
  }));
  const seen = new Set<string>();
  return results.flat().filter((track) => {
    if (seen.has(track.uri)) return false;
    seen.add(track.uri);
    return true;
  }).sort((a, b) => `${a.folderName}/${a.name}`.localeCompare(`${b.folderName}/${b.name}`));
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function buildQueue(tracks: Track[], selectedTrack: Track, mode: PlaybackMode) {
  const scopedTracks = tracks.filter((track) => track.folderUri === selectedTrack.folderUri);
  if (mode === 'shuffle') {
    return { queue: [selectedTrack, ...shuffle(scopedTracks.filter((track) => track.uri !== selectedTrack.uri))], index: 0 };
  }
  const queue = [...scopedTracks].sort((a, b) => a.name.localeCompare(b.name));
  return { queue, index: Math.max(0, queue.findIndex((track) => track.uri === selectedTrack.uri)) };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function readSyncSafe(bytes: Uint8Array, start: number): number {
  return (bytes[start] << 21) | (bytes[start + 1] << 14) | (bytes[start + 2] << 7) | bytes[start + 3];
}

function readFrameSize(bytes: Uint8Array, start: number, version: number): number {
  if (version === 4) return readSyncSafe(bytes, start);
  return (bytes[start] * 0x1000000) + (bytes[start + 1] << 16) + (bytes[start + 2] << 8) + bytes[start + 3];
}

function findZero(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 0) return index;
  }
  return bytes.length;
}

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += BASE64[first >> 2];
    output += BASE64[((first & 3) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? BASE64[((second & 15) << 2) | (third >> 6)] : '=';
    output += index + 2 < bytes.length ? BASE64[third & 63] : '=';
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '').replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bitCount = 0;
  let offset = 0;
  for (const character of clean) {
    const digit = BASE64.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset] = (buffer >> bitCount) & 0xff;
      offset += 1;
    }
  }
  return bytes.slice(0, offset);
}

function artworkCacheKey(uri: string): string {
  let hash = 0;
  for (let index = 0; index < uri.length; index += 1) hash = ((hash << 5) - hash + uri.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16);
}

async function materializeArtwork(dataUri: string, trackUri: string): Promise<string | null> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  try {
    const extension = match[1].split('/')[1] || 'jpg';
    const file = new File(Paths.cache, 'mp3fy-artwork', `${artworkCacheKey(trackUri)}.${extension}`);
    if (!file.exists) {
      file.create({ intermediates: true });
      file.write(decodeBase64(match[2]));
    }
    return file.uri;
  } catch {
    return null;
  }
}

function parseEmbeddedArtwork(bytes: Uint8Array): string | null {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return null;
  const version = bytes[3];
  if (version < 2 || version > 4) return null;
  const tagEnd = Math.min(bytes.length, 10 + readSyncSafe(bytes, 6));
  let cursor = 10;

  while (cursor + (version === 2 ? 6 : 10) <= tagEnd) {
    const idLength = version === 2 ? 3 : 4;
    const frameId = readAscii(bytes, cursor, idLength);
    if (!frameId.trim() || /^\0+$/.test(frameId)) break;
    const frameSize = version === 2
      ? (bytes[cursor + 3] << 16) | (bytes[cursor + 4] << 8) | bytes[cursor + 5]
      : readFrameSize(bytes, cursor + 4, version);
    const headerSize = version === 2 ? 6 : 10;
    const payloadStart = cursor + headerSize;
    const payloadEnd = Math.min(tagEnd, payloadStart + frameSize);
    if (payloadEnd <= payloadStart) break;

    if ((version === 2 && frameId === 'PIC') || (version !== 2 && frameId === 'APIC')) {
      let position = payloadStart;
      const encoding = bytes[position];
      position += 1;
      let mime = 'image/jpeg';
      if (version === 2) {
        const format = readAscii(bytes, position, 3).toLowerCase();
        mime = format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'image/jpeg';
        position += 3;
      } else {
        const mimeEnd = findZero(bytes, position);
        const parsedMime = readAscii(bytes, position, mimeEnd - position);
        if (parsedMime) mime = parsedMime;
        position = mimeEnd + 1;
      }
      position += 1;
      if (encoding === 1 || encoding === 2) {
        position = findZero(bytes, position) + (encoding === 1 ? 2 : 1);
      } else {
        position = findZero(bytes, position) + 1;
      }
      if (position < payloadEnd) return `data:${mime};base64,${encodeBase64(bytes.slice(position, payloadEnd))}`;
    }
    cursor = payloadEnd;
  }
  return null;
}

async function loadEmbeddedArtwork(uri: string): Promise<string | null> {
  try {
    const file = new File(uri);
    const sample = await file.slice(0, 4 * 1024 * 1024).arrayBuffer();
    return parseEmbeddedArtwork(new Uint8Array(sample));
  } catch {
    return null;
  }
}

function ActionButton({ label, onPress, secondary = false }: { label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress, active = false }: { label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.smallButton, active && styles.activeSmallButton, pressed && styles.pressed]}>
      <Text style={[styles.smallButtonText, active && styles.activeSmallButtonText]}>{label}</Text>
    </Pressable>
  );
}

function AlbumArt({ uri, size, label }: { uri: string | null; size: number; label: string }) {
  return uri ? <Image accessibilityLabel={`Album artwork for ${label}`} source={{ uri }} style={{ height: size, width: size }} /> : (
    <View style={[styles.artPlaceholder, { height: size, width: size }]}><Text style={styles.artPlaceholderText}>mp3fy</Text></View>
  );
}

export default function App() {
  return <SafeAreaProvider><Mp3fyApp /></SafeAreaProvider>;
}

function Mp3fyApp() {
  const player = useAudioPlaylist({ sources: [], updateInterval: 500, loop: 'all' });
  const status = useAudioPlaylistStatus(player);
  const artworkCache = useRef(new Map<string, string | null>()).current;
  const artworkMediaCache = useRef(new Map<string, string | null>()).current;
  const artworkRequest = useRef(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [currentArtwork, setCurrentArtwork] = useState<string | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [mode, setMode] = useState<PlaybackMode>('shuffle');
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all');
  const [screen, setScreen] = useState<Screen>({ kind: 'folders' });
  const [isScanning, setIsScanning] = useState(false);
  const [notice, setNotice] = useState('Select a folder to begin.');
  const [progressWidth, setProgressWidth] = useState(0);
  const [folderActions, setFolderActions] = useState<Folder | null>(null);
  const [folderToConfirm, setFolderToConfirm] = useState<Folder | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const folderCounts = useMemo(() => folders.map((folder) => ({
    folder,
    count: tracks.filter((track) => track.folderUri === folder.uri).length,
  })), [folders, tracks]);

  const selectedFolder = useMemo(() => {
    if (screen.kind !== 'songs') return null;
    return folders.find((folder) => folder.uri === screen.folderUri) ?? null;
  }, [folders, screen]);

  const selectedFolderTracks = useMemo(() => {
    if (!selectedFolder) return [];
    return tracks.filter((track) => track.folderUri === selectedFolder.uri).sort((a, b) => a.name.localeCompare(b.name));
  }, [selectedFolder, tracks]);

  const rescan = useCallback(async (nextFolders: Folder[]) => {
    setFolders(nextFolders);
    setIsScanning(true);
    const nextTracks = await scanFolders(nextFolders);
    setTracks(nextTracks);
    setIsScanning(false);
    setNotice(nextTracks.length ? `${nextTracks.length} MP3 file${nextTracks.length === 1 ? '' : 's'} found.` : 'No MP3 files found in the selected folders.');
    return nextTracks;
  }, []);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: true }).catch(() => undefined);
    AsyncStorage.getItem(FOLDERS_KEY).then(async (stored) => {
      if (!stored) return;
      try {
        const savedFolders = JSON.parse(stored) as Folder[];
        if (savedFolders.length) await rescan(savedFolders);
      } catch {
        setNotice('Saved folders could not be restored.');
      }
    }).finally(() => setIsInitialized(true));
  }, [rescan]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (currentTrack && nextState !== 'unknown') {
        player.setActiveForLockScreen(true, { title: currentTrack.name, artist: 'mp3fy', artworkUrl: artworkMediaCache.get(currentTrack.uri) ?? undefined });
      }
    });
    return () => subscription.remove();
  }, [artworkMediaCache, currentTrack, player]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (folderActions || folderToConfirm) {
        setFolderActions(null);
        setFolderToConfirm(null);
        return true;
      }
      if (screen.kind === 'player') {
        setScreen(screen.returnTo === 'songs' && currentTrack ? { kind: 'songs', folderUri: currentTrack.folderUri } : { kind: 'folders' });
        return true;
      }
      if (screen.kind === 'songs') {
        setScreen({ kind: 'folders' });
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [currentTrack, folderActions, folderToConfirm, screen]);

  const loadArtwork = useCallback(async (track: Track) => {
    const request = ++artworkRequest.current;
    const applyArtwork = async (dataUri: string | null) => {
      const mediaArtwork = dataUri
        ? artworkMediaCache.get(track.uri) ?? await materializeArtwork(dataUri, track.uri)
        : null;
      if (mediaArtwork) artworkMediaCache.set(track.uri, mediaArtwork);
      if (request !== artworkRequest.current) return;
      setCurrentArtwork(mediaArtwork ?? dataUri);
      player.updateLockScreenMetadata({ title: track.name, artist: 'mp3fy', artworkUrl: mediaArtwork ?? undefined });
    };

    if (artworkCache.has(track.uri)) {
      await applyArtwork(artworkCache.get(track.uri) ?? null);
      return;
    }
    const artwork = await loadEmbeddedArtwork(track.uri);
    artworkCache.set(track.uri, artwork);
    await applyArtwork(artwork);
  }, [artworkCache, artworkMediaCache, player]);

  const startPlayback = useCallback((nextQueue: Track[], nextIndex: number) => {
    const nextTrack = nextQueue[nextIndex];
    if (!nextTrack) return;
    player.clear();
    nextQueue.forEach((track) => player.add({ uri: track.uri }));
    player.loop = repeatMode === 'one' ? 'single' : 'all';
    player.skipTo(nextIndex);
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    setCurrentTrack(nextTrack);
    setCurrentArtwork(null);
    player.setActiveForLockScreen(true, { title: nextTrack.name, artist: 'mp3fy' });
    player.play();
    void loadArtwork(nextTrack);
  }, [loadArtwork, player, repeatMode]);

  useEffect(() => {
    if (!queue.length || status.currentIndex < 0 || status.currentIndex >= queue.length) return;
    const nextTrack = queue[status.currentIndex];
    setQueueIndex(status.currentIndex);
    if (currentTrack?.uri === nextTrack.uri) return;
    setCurrentTrack(nextTrack);
    setCurrentArtwork(null);
    player.updateLockScreenMetadata({ title: nextTrack.name, artist: 'mp3fy' });
    void loadArtwork(nextTrack);
  }, [currentTrack?.uri, loadArtwork, player, queue, status.currentIndex]);

  useEffect(() => {
    player.loop = repeatMode === 'one' ? 'single' : 'all';
  }, [player, repeatMode]);

  const playTrack = useCallback((track: Track) => {
    const nextPlayback = buildQueue(tracks, track, mode);
    startPlayback(nextPlayback.queue, nextPlayback.index);
    setScreen({ kind: 'player', returnTo: 'songs' });
  }, [mode, startPlayback, tracks]);

  const playNext = useCallback(() => {
    if (queue.length) player.next();
  }, [player, queue.length]);

  const playPrevious = useCallback(() => {
    if (!queue.length) return;
    if (status.currentTime > 3) {
      player.seekTo(0).catch(() => undefined);
      return;
    }
      player.previous();
  }, [player, queue, queueIndex, status.currentTime]);

  const updateQueuePreference = useCallback((nextMode: PlaybackMode) => {
    setMode(nextMode);
    if (!currentTrack) return;
    const nextPlayback = buildQueue(tracks, currentTrack, nextMode);
    startPlayback(nextPlayback.queue, nextPlayback.index);
  }, [currentTrack, startPlayback, tracks]);

  const addFolder = useCallback(async () => {
    setIsScanning(true);
    setNotice('Selecting a folder.');
    try {
      const selectedDirectory = await Directory.pickDirectoryAsync();
      const nextFolder: Folder = { name: selectedDirectory.name, uri: selectedDirectory.uri };
      const nextFolders = folders.some((folder) => folder.uri === nextFolder.uri) ? folders : [...folders, nextFolder];
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      const nextTracks = await rescan(nextFolders);
      if (currentTrack && nextTracks.some((track) => track.uri === currentTrack.uri)) {
        const nextPlayback = buildQueue(nextTracks, currentTrack, mode);
        startPlayback(nextPlayback.queue, nextPlayback.index);
      }
    } catch {
      setNotice('Folder selection was cancelled or unavailable.');
    } finally {
      setIsScanning(false);
    }
  }, [currentTrack, folders, mode, rescan, startPlayback]);

  const removeFolder = useCallback(async (folder: Folder) => {
    setIsScanning(true);
    setNotice('Removing folder and rescanning.');
    try {
      const nextFolders = folders.filter((item) => item.uri !== folder.uri);
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      setFolders(nextFolders);
      setTracks((existing) => existing.filter((track) => track.folderUri !== folder.uri));
      if (screen.kind === 'songs' && screen.folderUri === folder.uri) setScreen({ kind: 'folders' });
      if (currentTrack?.folderUri === folder.uri) {
        player.pause();
        player.clear();
        player.setActiveForLockScreen(false);
        setCurrentTrack(null);
        setCurrentArtwork(null);
        setQueue([]);
        setQueueIndex(-1);
        setScreen({ kind: 'folders' });
      }
      const nextTracks = await scanFolders(nextFolders);
      setTracks(nextTracks);
      if (currentTrack && currentTrack.folderUri !== folder.uri) {
        const nextPlayback = buildQueue(nextTracks, currentTrack, mode);
        startPlayback(nextPlayback.queue, nextPlayback.index);
      }
    } catch {
      setNotice('The folder could not be removed.');
    } finally {
      setIsScanning(false);
    }
  }, [currentTrack, folders, mode, player, screen, startPlayback]);

  const openFolder = (folder: Folder) => setScreen({ kind: 'songs', folderUri: folder.uri });
  const seek = (event: { nativeEvent: { locationX: number } }) => {
    if (!progressWidth || !status.duration) return;
    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / progressWidth));
    player.seekTo(ratio * status.duration).catch(() => undefined);
  };
  const progress = status.duration ? Math.min(1, status.currentTime / status.duration) : 0;

  const openPlayerFromMini = () => {
    if (currentTrack) setScreen({ kind: 'player', returnTo: screen.kind === 'songs' ? 'songs' : 'folders' });
  };

  if (!isInitialized) {
    return (
      <>
        <SystemStatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent={false} />
        <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
          <View style={styles.container}>
            <View style={styles.startupLoading}>
              <ActivityIndicator color="#000000" />
              <Text style={styles.notice}>Loading library.</Text>
            </View>
          </View>
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <SystemStatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent={false} />
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <View style={styles.container}>
          {screen.kind === 'folders' ? (
            <FoldersScreen folders={folderCounts} tracksCount={tracks.length} isScanning={isScanning} notice={notice} onAddFolder={addFolder} onOpenFolder={openFolder} onLongPressFolder={setFolderActions} />
          ) : screen.kind === 'songs' && selectedFolder ? (
            <SongsScreen folder={selectedFolder} tracks={selectedFolderTracks} currentTrack={currentTrack} isScanning={isScanning} onBack={() => setScreen({ kind: 'folders' })} onPlayTrack={playTrack} />
          ) : currentTrack ? (
            <PlayerScreen track={currentTrack} artwork={currentArtwork} status={status} progress={progress} progressWidth={progressWidth} mode={mode} repeatMode={repeatMode} onBack={() => setScreen(screen.kind === 'player' && screen.returnTo === 'songs' ? { kind: 'songs', folderUri: currentTrack.folderUri } : { kind: 'folders' })} onSeek={seek} onProgressLayout={(event) => setProgressWidth(event.nativeEvent.layout.width)} onPrevious={playPrevious} onNext={playNext} onTogglePlay={() => (status.playing ? player.pause() : player.play())} onModeChange={updateQueuePreference} onRepeatChange={setRepeatMode} />
          ) : null}

          {screen.kind !== 'player' && currentTrack ? <MiniPlayer track={currentTrack} artwork={currentArtwork} playing={status.playing} onOpen={openPlayerFromMini} onTogglePlay={() => (status.playing ? player.pause() : player.play())} onNext={playNext} /> : null}
        </View>
      </SafeAreaView>

      <Modal animationType="fade" transparent visible={Boolean(folderActions)} onRequestClose={() => setFolderActions(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle} numberOfLines={2}>{folderActions?.name}</Text>
            <ActionButton label="OPEN FOLDER" onPress={() => { if (folderActions) openFolder(folderActions); setFolderActions(null); }} />
            <ActionButton label="REMOVE FOLDER" onPress={() => { setFolderToConfirm(folderActions); setFolderActions(null); }} secondary />
            <ActionButton label="CANCEL" onPress={() => setFolderActions(null)} secondary />
          </View>
        </View>
      </Modal>

      <Modal animationType="fade" transparent visible={Boolean(folderToConfirm)} onRequestClose={() => setFolderToConfirm(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove this folder?</Text>
            <Text style={styles.modalDescription}>{folderToConfirm?.name}</Text>
            <ActionButton label="REMOVE FOLDER" onPress={() => { if (folderToConfirm) void removeFolder(folderToConfirm); setFolderToConfirm(null); }} />
            <ActionButton label="CANCEL" onPress={() => setFolderToConfirm(null)} secondary />
          </View>
        </View>
      </Modal>
    </>
  );
}

function ScreenHeader({ title, subtitle, onBack, right }: { title: string; subtitle: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerMain}>
        {onBack ? <Pressable accessibilityRole="button" onPress={onBack} style={styles.backButton}><Text style={styles.backText}>&lt; BACK</Text></Pressable> : <Text style={styles.wordmark}>mp3fy</Text>}
        <Text style={styles.label}>{subtitle}</Text>
      </View>
      {right ?? null}
    </View>
  );
}

function FoldersScreen({ folders, tracksCount, isScanning, notice, onAddFolder, onOpenFolder, onLongPressFolder }: { folders: { folder: Folder; count: number }[]; tracksCount: number; isScanning: boolean; notice: string; onAddFolder: () => void; onOpenFolder: (folder: Folder) => void; onLongPressFolder: (folder: Folder) => void }) {
  return (
    <View style={styles.screen}>
      <ScreenHeader title="mp3fy" subtitle="LOCAL MP3 PLAYER" right={<Text style={styles.count}>{folders.length} FOLDERS</Text>} />
      <View style={styles.screenTitleRow}><View><Text style={styles.screenTitle}>FOLDERS</Text><Text style={styles.screenSubtitle}>{tracksCount} tracks available</Text></View><ActionButton label="ADD FOLDER" onPress={onAddFolder} secondary /></View>
      <Text style={styles.helperText}>Tap a folder to open it. Long press for folder actions.</Text>
      {isScanning ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning selected folders.</Text></View> : folders.length ? <FlatList data={folders} keyExtractor={({ folder }) => folder.uri} renderItem={({ item }) => <Pressable delayLongPress={450} onLongPress={() => onLongPressFolder(item.folder)} onPress={() => onOpenFolder(item.folder)} style={({ pressed }) => [styles.folderCard, pressed && styles.pressed]}><View style={styles.folderIcon}><Text style={styles.folderIconText}>DIR</Text></View><View style={styles.folderCopy}><Text style={styles.folderTitle} numberOfLines={1}>{item.folder.name}</Text><Text style={styles.folderMeta}>{item.count} MP3 FILES</Text></View><Text style={styles.chevron}>&gt;</Text></Pressable>} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No folders selected</Text><Text style={styles.description}>Add a folder containing your MP3 files. Only the folders you choose will be scanned.</Text><Text style={styles.notice}>{notice}</Text></View>}
      <View style={styles.footer}><Text style={styles.footerText}>READ-ONLY PLAYBACK</Text><Text style={styles.footerText}>1.3.1</Text></View>
    </View>
  );
}

function SongsScreen({ folder, tracks, currentTrack, isScanning, onBack, onPlayTrack }: { folder: Folder; tracks: Track[]; currentTrack: Track | null; isScanning: boolean; onBack: () => void; onPlayTrack: (track: Track) => void }) {
  const [search, setSearch] = useState('');
  const visibleTracks = useMemo(() => tracks.filter((track) => track.name.toLowerCase().includes(search.trim().toLowerCase())), [search, tracks]);
  return (
    <View style={styles.screen}>
      <ScreenHeader title={folder.name} subtitle="FOLDER" onBack={onBack} right={<Text style={styles.count}>{tracks.length} TRACKS</Text>} />
      <View style={styles.pageHeading}><Text numberOfLines={2} style={styles.screenTitle}>{folder.name}</Text><Text style={styles.screenSubtitle}>Songs in this folder</Text></View>
      <TextInput accessibilityLabel="Search songs in folder" onChangeText={setSearch} placeholder="Search songs" placeholderTextColor="#666666" style={styles.search} value={search} />
      {isScanning ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning folder.</Text></View> : visibleTracks.length ? <FlatList data={visibleTracks} keyExtractor={(item) => item.uri} renderItem={({ item }) => {
        const isPlaying = currentTrack?.uri === item.uri;
        return <Pressable onPress={() => onPlayTrack(item)} style={({ pressed }) => [styles.trackRow, isPlaying && styles.activeTrackRow, pressed && styles.pressed]}><View style={[styles.trackIndicator, isPlaying && styles.activeTrackIndicator]} /><View style={styles.trackCopy}><Text numberOfLines={1} style={styles.trackName}>{item.name}</Text><Text style={styles.trackFolder}>{isPlaying ? 'PLAYING' : 'MP3 FILE'}</Text></View><Text style={styles.playText}>{isPlaying ? 'PLAYING' : 'PLAY'}</Text></Pressable>;
      }} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No MP3 files</Text><Text style={styles.description}>This folder does not currently contain any MP3 files.</Text></View>}
    </View>
  );
}

function MiniPlayer({ track, artwork, playing, onOpen, onTogglePlay, onNext }: { track: Track; artwork: string | null; playing: boolean; onOpen: () => void; onTogglePlay: () => void; onNext: () => void }) {
  return <View style={styles.miniPlayer}><Pressable onPress={onOpen} style={styles.miniMain}><AlbumArt label={track.name} size={52} uri={artwork} /><View style={styles.miniCopy}><Text style={styles.miniLabel}>NOW PLAYING</Text><Text numberOfLines={1} style={styles.miniTitle}>{track.name}</Text><Text numberOfLines={1} style={styles.miniFolder}>{track.folderName}</Text></View></Pressable><Pressable accessibilityRole="button" onPress={onTogglePlay} style={styles.miniButton}><Text style={styles.miniButtonText}>{playing ? '||' : '>'}</Text></Pressable><Pressable accessibilityRole="button" onPress={onNext} style={styles.miniButton}><Text style={styles.miniButtonText}>&gt;|</Text></Pressable></View>;
}

function IconButton({ icon, accessibilityLabel, onPress, active = false }: { icon: string; accessibilityLabel: string; onPress: () => void; active?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.iconButton, active && styles.activeIconButton, pressed && styles.pressed]}><Text style={[styles.iconButtonText, active && styles.activeIconButtonText]}>{icon}</Text></Pressable>;
}

function PlayerScreen({ track, artwork, status, progress, progressWidth, mode, repeatMode, onBack, onSeek, onProgressLayout, onPrevious, onNext, onTogglePlay, onModeChange, onRepeatChange }: { track: Track; artwork: string | null; status: AudioPlaylistStatus; progress: number; progressWidth: number; mode: PlaybackMode; repeatMode: RepeatMode; onBack: () => void; onSeek: (event: { nativeEvent: { locationX: number } }) => void; onProgressLayout: (event: LayoutChangeEvent) => void; onPrevious: () => void; onNext: () => void; onTogglePlay: () => void; onModeChange: (mode: PlaybackMode) => void; onRepeatChange: (mode: RepeatMode) => void }) {
  return (
    <ScrollView contentContainerStyle={styles.playerScreen} showsVerticalScrollIndicator={false}>
      <ScreenHeader title="PLAYER" subtitle="NOW PLAYING" onBack={onBack} />
      <View style={styles.playerArt}><AlbumArt label={track.name} size={300} uri={artwork} /></View>
      <Text style={styles.playerTitle} numberOfLines={2}>{track.name}</Text>
      <Text style={styles.playerFolder}>{track.folderName}</Text>
      <Pressable accessibilityRole="adjustable" onLayout={onProgressLayout} onPress={onSeek} style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></Pressable>
      <View style={styles.timeRow}><Text style={styles.timeText}>{formatTime(status.currentTime)}</Text><Text style={styles.timeText}>{formatTime(status.duration)}</Text></View>
      <View style={styles.transportRow}><IconButton icon={mode === 'shuffle' ? '⤨' : '⇄'} accessibilityLabel={mode === 'shuffle' ? 'Shuffle on. Switch to regular order' : 'Shuffle off. Switch to shuffle'} active={mode === 'shuffle'} onPress={() => onModeChange(mode === 'shuffle' ? 'sequential' : 'shuffle')} /><SmallButton label="|<" onPress={onPrevious} /><ActionButton label={status.playing ? 'PAUSE' : 'PLAY'} onPress={onTogglePlay} /><SmallButton label="|>" onPress={onNext} /><IconButton icon={repeatMode === 'one' ? '↻1' : '↻'} accessibilityLabel={repeatMode === 'one' ? 'Repeat current song. Switch to repeat folder' : 'Repeat folder. Switch to repeat current song'} active={repeatMode === 'one'} onPress={() => onRepeatChange(repeatMode === 'one' ? 'all' : 'one')} /></View>
      <Text style={styles.playerNote}>Tap the back button to minimise the player. Playback continues while you browse.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#FFFFFF', flex: 1 },
  container: { backgroundColor: '#FFFFFF', flex: 1, paddingHorizontal: 20 },
  screen: { flex: 1 },
  header: { alignItems: 'flex-end', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, paddingTop: 10 },
  headerMain: { flex: 1 },
  wordmark: { color: '#000000', fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  label: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 },
  count: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginLeft: 10 },
  backButton: { paddingBottom: 4, paddingTop: 4 },
  backText: { color: '#000000', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  screenTitleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 20 },
  pageHeading: { paddingTop: 20 },
  screenTitle: { color: '#000000', fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  screenSubtitle: { color: '#555555', fontSize: 12, marginTop: 5 },
  helperText: { color: '#555555', fontSize: 12, lineHeight: 18, marginTop: 14 },
  button: { alignItems: 'center', backgroundColor: '#000000', minWidth: 112, paddingHorizontal: 14, paddingVertical: 12 },
  secondaryButton: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1 },
  buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  secondaryButtonText: { color: '#000000' },
  smallButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 10 },
  activeSmallButton: { backgroundColor: '#000000' },
  smallButtonText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  activeSmallButtonText: { color: '#FFFFFF' },
  pressed: { opacity: 0.6 },
  folderCard: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', paddingVertical: 16 },
  folderIcon: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  folderIconText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  folderCopy: { flex: 1, marginLeft: 14 },
  folderTitle: { color: '#000000', fontSize: 16, fontWeight: '700' },
  folderMeta: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 0.7, marginTop: 5 },
  chevron: { color: '#000000', fontSize: 20, paddingLeft: 14 },
  listContent: { paddingBottom: 18, paddingTop: 10 },
  trackRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
  activeTrackRow: { backgroundColor: '#F2F2F2' },
  trackIndicator: { backgroundColor: 'transparent', height: 38, marginRight: 10, width: 4 },
  activeTrackIndicator: { backgroundColor: '#000000' },
  trackCopy: { flex: 1, marginRight: 12 },
  trackName: { color: '#000000', fontSize: 15, fontWeight: '600' },
  trackFolder: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginTop: 5 },
  playText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  search: { borderBottomColor: '#000000', borderBottomWidth: 1, color: '#000000', fontSize: 15, marginTop: 18, paddingBottom: 9, paddingHorizontal: 0 },
  loading: { alignItems: 'flex-start', flex: 1, justifyContent: 'center' },
  startupLoading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'flex-start', flex: 1, justifyContent: 'center' },
  rule: { backgroundColor: '#000000', height: 4, marginBottom: 20, width: 42 },
  title: { color: '#000000', fontSize: 24, fontWeight: '700' },
  description: { color: '#000000', fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 340 },
  notice: { color: '#444444', fontSize: 12, lineHeight: 18, marginTop: 16 },
  footer: { borderTopColor: '#000000', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 10, paddingTop: 10 },
  footerText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  miniPlayer: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, flexDirection: 'row', marginBottom: 10, padding: 6 },
  miniMain: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
  miniCopy: { flex: 1, marginLeft: 10, minWidth: 0 },
  miniLabel: { color: '#555555', fontSize: 8, fontWeight: '700', letterSpacing: 1 },
  miniTitle: { color: '#000000', fontSize: 12, fontWeight: '700', marginTop: 3 },
  miniFolder: { color: '#555555', fontSize: 10, marginTop: 2 },
  miniButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 },
  miniButtonText: { color: '#000000', fontSize: 15, fontWeight: '700' },
  artPlaceholder: { alignItems: 'center', backgroundColor: '#EEEEEE', borderColor: '#000000', borderWidth: 1, justifyContent: 'center' },
  artPlaceholderText: { color: '#000000', fontSize: 22, fontWeight: '700', letterSpacing: -1 },
  playerScreen: { paddingBottom: 28 },
  playerArt: { alignItems: 'center', paddingTop: 26 },
  playerTitle: { color: '#000000', fontSize: 23, fontWeight: '700', lineHeight: 29, marginTop: 24 },
  playerFolder: { color: '#555555', fontSize: 14, marginTop: 6 },
  progressTrack: { backgroundColor: '#DDDDDD', height: 8, marginTop: 22, overflow: 'hidden' },
  progressFill: { backgroundColor: '#000000', height: 8 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  timeText: { color: '#444444', fontSize: 11 },
  transportRow: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'center', marginTop: 18 },
  iconButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  activeIconButton: { backgroundColor: '#000000' },
  iconButtonText: { color: '#000000', fontSize: 20, fontWeight: '700' },
  activeIconButtonText: { color: '#FFFFFF' },
  preferenceHeading: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginTop: 24 },
  preferenceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
  playerNote: { color: '#555555', fontSize: 12, lineHeight: 18, marginTop: 26 },
  modalBackdrop: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1, padding: 20, width: '100%' },
  modalTitle: { color: '#000000', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  modalDescription: { color: '#555555', fontSize: 13, marginBottom: 18 },
});
