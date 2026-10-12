import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Directory, File } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  LayoutChangeEvent,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const FOLDERS_KEY = 'mp3fy.selectedFolders.v1';

type Folder = { name: string; uri: string };
type Track = { folderName: string; folderUri: string; name: string; uri: string };
type PlaybackMode = 'shuffle' | 'sequential';
type PlaybackScope = 'folder' | 'library';

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

function buildQueue(tracks: Track[], selectedTrack: Track, mode: PlaybackMode, scope: PlaybackScope) {
  const scopedTracks = scope === 'folder'
    ? tracks.filter((track) => track.folderUri === selectedTrack.folderUri)
    : tracks;
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

function Button({ label, onPress, secondary = false }: { label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const player = useAudioPlayer(null, { updateInterval: 500, keepAudioSessionActive: true });
  const status = useAudioPlayerStatus(player);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [mode, setMode] = useState<PlaybackMode>('shuffle');
  const [scope, setScope] = useState<PlaybackScope>('library');
  const [repeatOne, setRepeatOne] = useState(false);
  const [search, setSearch] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [notice, setNotice] = useState('Select a folder to begin.');
  const [progressWidth, setProgressWidth] = useState(0);

  const visibleTracks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? tracks.filter((track) => `${track.name} ${track.folderName}`.toLowerCase().includes(query)) : tracks;
  }, [search, tracks]);

  const rescan = useCallback(async (nextFolders: Folder[]) => {
    setIsScanning(true);
    const nextTracks = await scanFolders(nextFolders);
    setFolders(nextFolders);
    setTracks(nextTracks);
    setIsScanning(false);
    setNotice(nextTracks.length ? `${nextTracks.length} MP3 file${nextTracks.length === 1 ? '' : 's'} found.` : 'No MP3 files found in the selected folders.');
    return nextTracks;
  }, []);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' }).catch(() => undefined);
    AsyncStorage.getItem(FOLDERS_KEY).then(async (stored) => {
      if (!stored) return;
      try {
        const savedFolders = JSON.parse(stored) as Folder[];
        if (savedFolders.length) await rescan(savedFolders);
      } catch {
        setNotice('Saved folders could not be restored.');
      }
    });
  }, [rescan]);

  useEffect(() => {
    if (!status.didJustFinish || !queue.length || queueIndex < 0) return;
    if (repeatOne) {
      player.seekTo(0).then(() => player.play()).catch(() => undefined);
      return;
    }
    const nextIndex = queueIndex + 1 >= queue.length ? 0 : queueIndex + 1;
    const nextTrack = queue[nextIndex];
    setQueueIndex(nextIndex);
    setCurrentTrack(nextTrack);
    player.replace(nextTrack.uri);
    player.play();
  }, [player, queue, queueIndex, repeatOne, status.didJustFinish]);

  const playQueueItem = useCallback((nextQueue: Track[], nextIndex: number) => {
    const nextTrack = nextQueue[nextIndex];
    if (!nextTrack) return;
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    setCurrentTrack(nextTrack);
    player.replace(nextTrack.uri);
    player.setActiveForLockScreen(true, { title: nextTrack.name, artist: 'mp3fy' });
    player.play();
  }, [player]);

  const playTrack = useCallback((track: Track) => {
    const nextPlayback = buildQueue(tracks, track, mode, scope);
    playQueueItem(nextPlayback.queue, nextPlayback.index);
  }, [mode, playQueueItem, scope, tracks]);

  const playNext = useCallback(() => {
    if (!queue.length) return;
    playQueueItem(queue, queueIndex + 1 >= queue.length ? 0 : queueIndex + 1);
  }, [playQueueItem, queue, queueIndex]);

  const playPrevious = useCallback(() => {
    if (!queue.length) return;
    if (status.currentTime > 3) {
      player.seekTo(0).catch(() => undefined);
      return;
    }
    playQueueItem(queue, queueIndex <= 0 ? queue.length - 1 : queueIndex - 1);
  }, [player, playQueueItem, queue, queueIndex, status.currentTime]);

  const updateQueuePreference = useCallback((nextMode: PlaybackMode, nextScope: PlaybackScope) => {
    setMode(nextMode);
    setScope(nextScope);
    if (!currentTrack) return;
    const nextPlayback = buildQueue(tracks, currentTrack, nextMode, nextScope);
    setQueue(nextPlayback.queue);
    setQueueIndex(nextPlayback.index);
  }, [currentTrack, tracks]);

  const addFolder = useCallback(async () => {
    try {
      const selectedDirectory = await Directory.pickDirectoryAsync();
      const nextFolder: Folder = { name: selectedDirectory.name, uri: selectedDirectory.uri };
      const nextFolders = folders.some((folder) => folder.uri === nextFolder.uri) ? folders : [...folders, nextFolder];
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      const nextTracks = await rescan(nextFolders);
      if (currentTrack && nextTracks.some((track) => track.uri === currentTrack.uri)) {
        const nextPlayback = buildQueue(nextTracks, currentTrack, mode, scope);
        setQueue(nextPlayback.queue);
        setQueueIndex(nextPlayback.index);
      }
    } catch {
      setNotice('Folder selection was cancelled or unavailable.');
    }
  }, [currentTrack, folders, mode, rescan, scope]);

  const removeFolder = useCallback(async (folderUri: string) => {
    const nextFolders = folders.filter((folder) => folder.uri !== folderUri);
    await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
    if (currentTrack?.folderUri === folderUri) {
      player.pause();
      player.replace(null);
      player.setActiveForLockScreen(false);
      setCurrentTrack(null);
      setQueue([]);
      setQueueIndex(-1);
    }
    const nextTracks = await rescan(nextFolders);
    if (currentTrack && nextTracks.some((track) => track.uri === currentTrack.uri)) {
      const nextPlayback = buildQueue(nextTracks, currentTrack, mode, scope);
      setQueue(nextPlayback.queue);
      setQueueIndex(nextPlayback.index);
    }
  }, [currentTrack, folders, mode, player, rescan, scope]);

  const seek = (event: { nativeEvent: { locationX: number } }) => {
    if (!progressWidth || !status.duration) return;
    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / progressWidth));
    player.seekTo(ratio * status.duration).catch(() => undefined);
  };
  const progress = status.duration ? Math.min(1, status.currentTime / status.duration) : 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.container}>
        <View style={styles.header}>
          <View><Text style={styles.wordmark}>mp3fy</Text><Text style={styles.label}>LOCAL MP3 PLAYER</Text></View>
          <Text style={styles.count}>{tracks.length} TRACKS</Text>
        </View>

        {currentTrack ? <View style={styles.playerPanel}>
          <Text style={styles.nowPlayingLabel}>NOW PLAYING</Text>
          <Text numberOfLines={1} style={styles.nowPlayingTitle}>{currentTrack.name}</Text>
          <Text numberOfLines={1} style={styles.nowPlayingFolder}>{currentTrack.folderName}</Text>
          <Pressable accessibilityRole="adjustable" onLayout={(event: LayoutChangeEvent) => setProgressWidth(event.nativeEvent.layout.width)} onPress={seek} style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </Pressable>
          <View style={styles.timeRow}><Text style={styles.timeText}>{formatTime(status.currentTime)}</Text><Text style={styles.timeText}>{formatTime(status.duration)}</Text></View>
          <View style={styles.transportRow}>
            <Button label="|<" onPress={playPrevious} secondary />
            <Button label={status.playing ? 'PAUSE' : 'PLAY'} onPress={() => (status.playing ? player.pause() : player.play())} />
            <Button label=">|" onPress={playNext} secondary />
          </View>
        </View> : null}

        <View style={styles.controlsHeader}><Text style={styles.sectionTitle}>LIBRARY</Text><Button label="ADD FOLDER" onPress={addFolder} secondary /></View>
        <View style={styles.modeRow}>
          <Text style={styles.modeLabel}>PLAYBACK</Text>
          <Pressable onPress={() => updateQueuePreference('shuffle', scope)} style={[styles.modeButton, mode === 'shuffle' && styles.activeMode]}><Text style={[styles.modeText, mode === 'shuffle' && styles.activeModeText]}>SHUFFLE</Text></Pressable>
          <Pressable onPress={() => updateQueuePreference('sequential', scope)} style={[styles.modeButton, mode === 'sequential' && styles.activeMode]}><Text style={[styles.modeText, mode === 'sequential' && styles.activeModeText]}>ORDER</Text></Pressable>
          <Pressable onPress={() => setRepeatOne((value) => !value)} style={[styles.modeButton, repeatOne && styles.activeMode]}><Text style={[styles.modeText, repeatOne && styles.activeModeText]}>REPEAT ONE</Text></Pressable>
        </View>
        <View style={styles.modeRow}>
          <Text style={styles.modeLabel}>QUEUE</Text>
          <Pressable onPress={() => updateQueuePreference(mode, 'library')} style={[styles.modeButton, scope === 'library' && styles.activeMode]}><Text style={[styles.modeText, scope === 'library' && styles.activeModeText]}>ALL FOLDERS</Text></Pressable>
          <Pressable onPress={() => updateQueuePreference(mode, 'folder')} style={[styles.modeButton, scope === 'folder' && styles.activeMode]}><Text style={[styles.modeText, scope === 'folder' && styles.activeModeText]}>CURRENT FOLDER</Text></Pressable>
        </View>
        <TextInput accessibilityLabel="Search MP3 files" onChangeText={setSearch} placeholder="Search files or folders" placeholderTextColor="#666666" style={styles.search} value={search} />

        {folders.length ? <View style={styles.folderList}>{folders.map((folder) => <View key={folder.uri} style={styles.folderRow}><Text numberOfLines={1} style={styles.folderName}>{folder.name}</Text><Pressable onPress={() => removeFolder(folder.uri)}><Text style={styles.removeText}>REMOVE</Text></Pressable></View>)}</View> : null}

        {isScanning ? <View style={styles.emptyState}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning selected folders.</Text></View> : visibleTracks.length ? <FlatList data={visibleTracks} keyExtractor={(item) => item.uri} renderItem={({ item }) => <Pressable onPress={() => playTrack(item)} style={({ pressed }) => [styles.trackRow, pressed && styles.pressed]}><View style={styles.trackCopy}><Text numberOfLines={1} style={styles.trackName}>{item.name}</Text><Text numberOfLines={1} style={styles.trackFolder}>{item.folderName}</Text></View><Text style={styles.playText}>{currentTrack?.uri === item.uri ? 'PLAYING' : 'PLAY'}</Text></Pressable>} contentContainerStyle={styles.trackList} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>{folders.length ? 'No MP3 files found' : 'No folders selected'}</Text><Text style={styles.description}>{folders.length ? 'Add another folder or check that the selected folders contain MP3 files.' : 'Select one or more folders containing MP3 files to build your local library.'}</Text><Text style={styles.notice}>{notice}</Text></View>}

        <View style={styles.footer}><Text style={styles.footerText}>READ-ONLY PLAYBACK</Text><Text style={styles.footerText}>BUILD 02</Text></View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#FFFFFF', flex: 1 },
  container: { backgroundColor: '#FFFFFF', flex: 1, paddingHorizontal: 20, paddingTop: 16 },
  header: { alignItems: 'flex-end', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12 },
  wordmark: { color: '#000000', fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  label: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 },
  count: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  playerPanel: { borderBottomColor: '#000000', borderBottomWidth: 1, paddingBottom: 16, paddingTop: 16 },
  nowPlayingLabel: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  nowPlayingTitle: { color: '#000000', fontSize: 20, fontWeight: '700', marginTop: 5 },
  nowPlayingFolder: { color: '#444444', fontSize: 12, marginTop: 3 },
  progressTrack: { backgroundColor: '#DDDDDD', height: 8, marginTop: 16, overflow: 'hidden' },
  progressFill: { backgroundColor: '#000000', height: 8 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  timeText: { color: '#444444', fontSize: 11 },
  transportRow: { flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 14 },
  button: { alignItems: 'center', backgroundColor: '#000000', minWidth: 88, paddingHorizontal: 14, paddingVertical: 11 },
  secondaryButton: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1 },
  buttonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  secondaryButtonText: { color: '#000000' },
  pressed: { opacity: 0.6 },
  controlsHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 16 },
  sectionTitle: { color: '#000000', fontSize: 13, fontWeight: '700', letterSpacing: 1.3 },
  modeRow: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 10 },
  modeLabel: { color: '#444444', fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginRight: 2 },
  modeButton: { borderColor: '#000000', borderWidth: 1, paddingHorizontal: 7, paddingVertical: 7 },
  activeMode: { backgroundColor: '#000000' },
  modeText: { color: '#000000', fontSize: 9, fontWeight: '700' },
  activeModeText: { color: '#FFFFFF' },
  search: { borderBottomColor: '#000000', borderBottomWidth: 1, color: '#000000', fontSize: 14, marginTop: 14, paddingBottom: 9, paddingHorizontal: 0 },
  folderList: { marginTop: 10 },
  folderRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  folderName: { color: '#000000', flex: 1, fontSize: 12, fontWeight: '700', marginRight: 12 },
  removeText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 0.7 },
  trackList: { paddingBottom: 18, paddingTop: 8 },
  trackRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12 },
  trackCopy: { flex: 1, marginRight: 12 },
  trackName: { color: '#000000', fontSize: 14, fontWeight: '600' },
  trackFolder: { color: '#555555', fontSize: 11, marginTop: 3 },
  playText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  emptyState: { alignItems: 'flex-start', flex: 1, justifyContent: 'center' },
  rule: { backgroundColor: '#000000', height: 4, marginBottom: 20, width: 42 },
  title: { color: '#000000', fontSize: 23, fontWeight: '700' },
  description: { color: '#000000', fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 340 },
  notice: { color: '#444444', fontSize: 12, lineHeight: 18, marginTop: 16 },
  footer: { borderTopColor: '#000000', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, paddingTop: 10 },
  footerText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
});
