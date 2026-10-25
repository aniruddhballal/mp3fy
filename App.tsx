import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { setAudioModeAsync, useAudioPlaylist, useAudioPlaylistStatus, type AudioPlaylistStatus } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
import { initializeWrappedStore, recordListening, restoreWrappedBackup, updateTrackDetails } from './wrappedStore';
import { initializeWrappedBackup, noteWrappedHistoryChanged, saveWrappedBackupNow } from './wrappedBackup';
import { ListeningTracker } from './wrappedTracker';
import { WrappedScreen } from './WrappedScreen';
import { QueueScreen, type QueueRow } from './QueueScreen';
import { moveUpcoming, upcomingFrom } from './queueOrder';
import { buildQueue, nextPlaybackMode, restorePlaybackMode, titleAndArtistFromFilename, type PlaybackMode } from './playbackOrder';
import { APP_VERSION } from './appVersion';
import { fetchLyrics, type LyricsResult } from './lyrics';

const FOLDERS_KEY = 'mp3fy.selectedFolders.v1';
const LIBRARY_KEY = 'mp3fy.library.v1';
const PLAYBACK_KEY = 'mp3fy.playback.v1';
const SHUFFLE_HISTORY_KEY = 'mp3fy.shuffleHistory.v1';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MARQUEE_FADE_WIDTH = 28;
const PLAYBACK_STATUS_UPDATE_INTERVAL_MS = 1000;
const MAX_METADATA_READ_BYTES = 4 * 1024 * 1024;
const MAX_ARTWORK_CACHE_FILES = 48;
const MAX_ARTWORK_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_MEMORY_ARTWORK_ENTRIES = 32;
const MAX_MEMORY_METADATA_ENTRIES = 128;

type Folder = { name: string; uri: string; imageUri?: string | null };
type Track = { folderName: string; folderUri: string; name: string; uri: string };
type LibrarySnapshot = { folders: Folder[]; tracks: Track[] };
type TrackMetadata = { title: string; artist: string; album: string; trackNumber: string };
type RepeatMode = 'all' | 'one';
type SavedPlayback = {
  track: Track;
  queueUris: string[];
  currentTime: number;
  mode: PlaybackMode | 'sequential';
  repeatMode: RepeatMode;
  standalone: boolean;
};

function isSavedPlayback(value: unknown): value is SavedPlayback {
  if (!value || typeof value !== 'object') return false;
  const saved = value as Partial<SavedPlayback>;
  const track = saved.track;
  return Boolean(track && typeof track.uri === 'string' && typeof track.name === 'string'
    && typeof track.folderUri === 'string' && typeof track.folderName === 'string'
    && Array.isArray(saved.queueUris) && saved.queueUris.every((uri) => typeof uri === 'string')
    && typeof saved.currentTime === 'number' && Number.isFinite(saved.currentTime) && saved.currentTime >= 0
    && (saved.mode === 'folder' || saved.mode === 'title' || saved.mode === 'shuffle' || saved.mode === 'sequential')
    && (saved.repeatMode === 'all' || saved.repeatMode === 'one')
    && typeof saved.standalone === 'boolean');
}

function isFolder(value: unknown): value is Folder {
  if (!value || typeof value !== 'object') return false;
  const folder = value as Partial<Folder>;
  return typeof folder.name === 'string' && typeof folder.uri === 'string'
    && (folder.imageUri === undefined || folder.imageUri === null || typeof folder.imageUri === 'string');
}

function isLibrarySnapshot(value: unknown, selectedFolders: Folder[]): value is LibrarySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<LibrarySnapshot>;
  if (!Array.isArray(snapshot.folders) || !Array.isArray(snapshot.tracks)
    || !snapshot.folders.every(isFolder) || snapshot.folders.length !== selectedFolders.length
    || !snapshot.folders.every((folder, index) => folder.uri === selectedFolders[index].uri && folder.name === selectedFolders[index].name)) return false;
  const selectedUris = new Set(selectedFolders.map((folder) => folder.uri));
  return snapshot.tracks.every((track) => track && typeof track === 'object'
    && typeof track.uri === 'string' && typeof track.name === 'string'
    && typeof track.folderUri === 'string' && typeof track.folderName === 'string'
    && selectedUris.has(track.folderUri));
}
type Screen =
  | { kind: 'folders' }
  | { kind: 'songs'; folderUri: string }
  | { kind: 'player'; returnTo: 'folders' | 'songs' }
  | { kind: 'queue'; returnTo: 'folders' | 'songs' | 'player'; folderUri?: string; playerReturnTo?: 'folders' | 'songs' }
  | { kind: 'wrapped'; returnTo: 'folders' | 'songs' | 'player'; folderUri?: string; playerReturnTo?: 'folders' | 'songs' };

function callOptionalPlayerMethod(player: object, methodName: string, ...args: unknown[]) {
  const method = (player as unknown as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') return;
  try {
    method.apply(player, args);
  } catch {
    // Lock-screen controls are an enhancement; they must never interrupt playback.
  }
}

function collectTracks(rootDirectory: Directory, folder: Folder, tracks: Track[], rootItems?: (Directory | File)[]) {
  const pendingDirectories = [rootDirectory];
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop() as Directory;
    const items = directory === rootDirectory && rootItems ? rootItems : directory.list();
    for (const item of items) {
      if (item instanceof Directory) {
        pendingDirectories.push(item);
      } else if (item instanceof File && item.name.toLowerCase().endsWith('.mp3')) {
        tracks.push({ folderName: folder.name, folderUri: folder.uri, name: item.name, uri: item.uri });
      }
    }
  }
}

const FOLDER_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function isFolderImage(file: File) {
  const name = file.name.toLowerCase();
  return FOLDER_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function folderImagePriority(file: File) {
  const name = file.name.toLowerCase();
  if (name.startsWith('folder.')) return 0;
  if (name.startsWith('cover.')) return 1;
  if (name.startsWith('artwork.')) return 2;
  if (name.startsWith('albumart.') || name.startsWith('album-art.')) return 3;
  if (name.startsWith('thumbnail.')) return 4;
  if (name.startsWith('image.')) return 5;
  return 10;
}

async function scanFolder(folder: Folder): Promise<{ folder: Folder; tracks: Track[] }> {
  try {
    const directory = new Directory(folder.uri);
    const items = directory.list();
    const image = items
      .filter((item): item is File => item instanceof File && isFolderImage(item))
      .sort((a, b) => folderImagePriority(a) - folderImagePriority(b) || a.name.localeCompare(b.name))[0];
    const tracks: Track[] = [];
    collectTracks(directory, folder, tracks, items);
    return { folder: { ...folder, imageUri: image?.uri ?? null }, tracks };
  } catch {
    return { folder: { ...folder, imageUri: null }, tracks: [] };
  }
}

async function scanFolders(folders: Folder[]): Promise<{ folders: Folder[]; tracks: Track[] }> {
  const results: { folder: Folder; tracks: Track[] }[] = [];
  const tracks: Track[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    try {
      const result = await scanFolder(folder);
      results.push(result);
      result.tracks.forEach((track) => {
        if (!seen.has(track.uri)) {
          seen.add(track.uri);
          tracks.push(track);
        }
      });
    } catch {
      results.push({ folder: { ...folder, imageUri: null }, tracks: [] });
    }
  }
  tracks.sort((a, b) => `${a.folderName}/${a.name}`.localeCompare(`${b.folderName}/${b.name}`));
  return { folders: results.map((result) => result.folder), tracks };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function fallbackMetadata(track: Track): TrackMetadata {
  return { ...titleAndArtistFromFilename(track.name), album: '', trackNumber: '' };
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

function decodeId3Text(bytes: Uint8Array, encoding: number): string {
  let end = bytes.length;
  if (encoding === 1 || encoding === 2) {
    while (end >= 2 && bytes[end - 2] === 0 && bytes[end - 1] === 0) end -= 2;
    let littleEndian = encoding === 1;
    let offset = 0;
    if (end >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      littleEndian = true;
      offset = 2;
    } else if (end >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      littleEndian = false;
      offset = 2;
    }
    const codeUnits: number[] = [];
    for (let index = offset; index + 1 < end; index += 2) {
      codeUnits.push(littleEndian ? bytes[index] | (bytes[index + 1] << 8) : (bytes[index] << 8) | bytes[index + 1]);
    }
    return String.fromCharCode(...codeUnits).replace(/\0/g, '').trim();
  }
  end = findZero(bytes, 0);
  const value = bytes.slice(0, end);
  if (!value.length) return '';
  try {
    if (encoding === 3) return new TextDecoder('utf-8').decode(value).replace(/\0/g, '').trim();
  } catch {
    // Fall through to a byte-preserving fallback for runtimes without TextDecoder support.
  }
  return String.fromCharCode(...value).replace(/\0/g, '').trim();
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

function rememberCacheValue<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as string);
}

function pruneArtworkCache() {
  try {
    const directory = new Directory(Paths.cache, 'mp3fy-artwork');
    if (!directory.exists) return;
    const entries = directory.list()
      .filter((item): item is File => item instanceof File)
      .map((file) => {
        const info = file.info();
        return { file, size: info.size ?? 0, modified: info.modificationTime ?? 0 };
      })
      .sort((a, b) => a.modified - b.modified);
    let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    while (entries.length > MAX_ARTWORK_CACHE_FILES || totalBytes > MAX_ARTWORK_CACHE_BYTES) {
      const entry = entries.shift();
      if (!entry) break;
      try {
        entry.file.delete();
        totalBytes -= entry.size;
      } catch {
        // A cache file can disappear while the system is reclaiming app cache.
      }
    }
  } catch {
    // Cache pruning is best effort and must never affect playback.
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

function parseEmbeddedMetadata(bytes: Uint8Array, fallback: TrackMetadata): TrackMetadata {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return fallback;
  const version = bytes[3];
  if (version < 2 || version > 4) return fallback;
  const tagEnd = Math.min(bytes.length, 10 + readSyncSafe(bytes, 6));
  const fields: Record<string, keyof TrackMetadata> = version === 2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'trackNumber' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'trackNumber' };
  const metadata = { ...fallback };
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
    const field = fields[frameId];
    if (field && payloadStart < payloadEnd) {
      const value = decodeId3Text(bytes.slice(payloadStart + 1, payloadEnd), bytes[payloadStart]);
      if (value) metadata[field] = value;
    }
    cursor = payloadEnd;
  }
  return metadata;
}

async function loadEmbeddedTrackDetails(uri: string, fallback: TrackMetadata): Promise<{ artwork: string | null; metadata: TrackMetadata }> {
  try {
    const file = new File(uri);
    const handle = file.open();
    try {
      const sample = handle.readBytes(Math.min(handle.size ?? MAX_METADATA_READ_BYTES, MAX_METADATA_READ_BYTES));
      return { artwork: parseEmbeddedArtwork(sample), metadata: parseEmbeddedMetadata(sample, fallback) };
    } finally {
      handle.close();
    }
  } catch {
    return { artwork: null, metadata: fallback };
  }
}

function ActionButton({ label, onPress, secondary = false, transport = false }: { label: string; onPress: () => void; secondary?: boolean; transport?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, transport && styles.transportMainButton, secondary && styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function SmallButton({ label, onPress, active = false, transport = false }: { label: string; onPress: () => void; active?: boolean; transport?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.smallButton, transport && styles.transportSideButton, active && styles.activeSmallButton, pressed && styles.pressed]}>
      <Text style={[styles.smallButtonText, active && styles.activeSmallButtonText]}>{label}</Text>
    </Pressable>
  );
}

const AlbumArt = memo(function AlbumArt({ uri, size, label, loading = false }: { uri: string | null; size: number; label: string; loading?: boolean }) {
  return uri ? <Image accessibilityLabel={`Album artwork for ${label}`} source={{ uri }} style={{ height: size, width: size }} /> : (
    <View style={[styles.artPlaceholder, { height: size, width: size }]}>
      {loading ? <><ActivityIndicator color="#000000" /><Text style={styles.artLoadingText}>LOADING ARTWORK</Text></> : <Text style={styles.artPlaceholderText}>mp3fy</Text>}
    </View>
  );
});

function MarqueeText({ text, textStyle, style, alignRight = false, fadeColor = '#FFFFFF', fadeTransparentColor = 'rgba(255,255,255,0)' }: { text: string; textStyle: object; style?: object; alignRight?: boolean; fadeColor?: string; fadeTransparentColor?: string }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);

  useEffect(() => {
    setTextWidth(0);
  }, [text]);

  useEffect(() => {
    animation.current?.stop();
    translateX.setValue(0);
    if (containerWidth > 0 && textWidth > containerWidth + 1) {
      const distance = textWidth - containerWidth;
      animation.current = Animated.loop(Animated.sequence([
        Animated.delay(1000),
        Animated.timing(translateX, { duration: Math.max(1400, distance * 28), toValue: -distance, useNativeDriver: true }),
        Animated.delay(800),
        Animated.timing(translateX, { duration: Math.max(1400, distance * 28), toValue: 0, useNativeDriver: true }),
        Animated.delay(1000),
      ]));
      animation.current.start();
    }
    return () => animation.current?.stop();
  }, [containerWidth, text, textWidth, translateX]);

  const marqueeDistance = Math.max(0, textWidth - containerWidth);

  return (
    <View onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)} style={[styles.marqueeViewport, style]}>
      <Animated.View style={[styles.marqueeContent, { transform: [{ translateX }], width: Math.max(containerWidth, textWidth) }]}> 
        <Text numberOfLines={1} ellipsizeMode="clip" style={[textStyle, styles.marqueeText, { textAlign: alignRight && textWidth <= containerWidth ? 'right' : 'left', width: Math.max(containerWidth, textWidth) }]}>{text}</Text>
      </Animated.View>
      {containerWidth > 0 && textWidth > containerWidth + 1 ? <>
        <Animated.View pointerEvents="none" style={[styles.marqueeFade, styles.marqueeFadeLeft, { opacity: translateX.interpolate({ inputRange: [-8, 0], outputRange: [1, 0], extrapolate: 'clamp' }) }]}>
          <LinearGradient colors={[fadeColor, fadeTransparentColor]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.marqueeFadeGradient} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.marqueeFade, styles.marqueeFadeRight, { opacity: translateX.interpolate({ inputRange: [-marqueeDistance, -Math.max(0, marqueeDistance - MARQUEE_FADE_WIDTH)], outputRange: [0, 1], extrapolate: 'clamp' }) }]}>
          <LinearGradient colors={[fadeTransparentColor, fadeColor]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.marqueeFadeGradient} />
        </Animated.View>
      </> : null}
      <Text onTextLayout={(event) => {
        const width = event.nativeEvent.lines.reduce((largest, line) => Math.max(largest, line.width), 0);
        if (width > 0 && width !== textWidth) setTextWidth(Math.ceil(width));
      }} style={[textStyle, styles.marqueeMeasure]}>{text}</Text>
    </View>
  );
}

export default function App() {
  return <SafeAreaProvider><Mp3fyApp /></SafeAreaProvider>;
}

function Mp3fyApp() {
  const player = useAudioPlaylist({ sources: [], updateInterval: PLAYBACK_STATUS_UPDATE_INTERVAL_MS, loop: 'all' });
  const status = useAudioPlaylistStatus(player);
  const artworkCache = useRef(new Map<string, string | null>()).current;
  const metadataCache = useRef(new Map<string, TrackMetadata>()).current;
  const artworkRequest = useRef(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [currentMetadata, setCurrentMetadata] = useState<TrackMetadata | null>(null);
  const [currentArtwork, setCurrentArtwork] = useState<string | null>(null);
  const [isArtworkLoading, setIsArtworkLoading] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [mode, setMode] = useState<PlaybackMode>('folder');
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all');
  const [screen, setScreen] = useState<Screen>({ kind: 'folders' });
  const [isScanning, setIsScanning] = useState(false);
  const [notice, setNotice] = useState('Select a folder to begin.');
  const [progressWidth, setProgressWidth] = useState(0);
  const [folderActions, setFolderActions] = useState<Folder | null>(null);
  const [folderToConfirm, setFolderToConfirm] = useState<Folder | null>(null);
  const [scanningFolderUris, setScanningFolderUris] = useState<Set<string>>(new Set());
  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [wrappedRevision, setWrappedRevision] = useState(0);
  const pendingRestorePosition = useRef<number | null>(null);
  const latestPlayback = useRef<SavedPlayback | null>(null);
  const lastSavedPlayback = useRef<string | null>(null);
  const storageWrite = useRef<Promise<void>>(Promise.resolve());
  const shuffleHistory = useRef(new Map<string, string[]>());
  const shuffleHistoryWrite = useRef<Promise<void>>(Promise.resolve());
  const libraryStorageWrite = useRef<Promise<void>>(Promise.resolve());
  const libraryRevision = useRef(0);
  const libraryRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeningTracker = useRef<ListeningTracker | null>(null);
  if (!listeningTracker.current) {
    listeningTracker.current = new ListeningTracker(async (entries) => {
      await recordListening(entries);
      noteWrappedHistoryChanged();
      setWrappedRevision((revision) => revision + 1);
    });
  }
  const tracker = listeningTracker.current;

  const savePlayback = useCallback((playback: SavedPlayback | null) => {
    const serialized = playback ? JSON.stringify(playback) : null;
    if (serialized === lastSavedPlayback.current) return;
    lastSavedPlayback.current = serialized;
    storageWrite.current = storageWrite.current.catch(() => undefined).then(() => serialized
      ? AsyncStorage.setItem(PLAYBACK_KEY, serialized)
      : AsyncStorage.removeItem(PLAYBACK_KEY));
  }, []);

  const rememberShuffle = useCallback((folderUri: string, shuffledQueue: Track[]) => {
    shuffleHistory.current.set(folderUri, shuffledQueue.map((track) => track.uri));
    const serialized = JSON.stringify([...shuffleHistory.current.entries()]);
    shuffleHistoryWrite.current = shuffleHistoryWrite.current.catch(() => undefined)
      .then(() => AsyncStorage.setItem(SHUFFLE_HISTORY_KEY, serialized));
  }, []);

  const queueTitleFor = useCallback((track: Track) => track.uri === currentTrack?.uri
    ? currentMetadata?.title ?? metadataCache.get(track.uri)?.title ?? fallbackMetadata(track).title
    : metadataCache.get(track.uri)?.title ?? fallbackMetadata(track).title, [currentMetadata, currentTrack?.uri, metadataCache]);

  const trackCounts = useMemo(() => {
    const counts = new Map<string, number>();
    tracks.forEach((track) => counts.set(track.folderUri, (counts.get(track.folderUri) ?? 0) + 1));
    return counts;
  }, [tracks]);

  const folderCounts = useMemo(() => folders.map((folder) => ({
    folder,
    count: trackCounts.get(folder.uri) ?? 0,
  })), [folders, trackCounts]);

  const selectedFolder = useMemo(() => {
    if (screen.kind !== 'songs') return null;
    return folders.find((folder) => folder.uri === screen.folderUri) ?? null;
  }, [folders, screen]);

  const selectedFolderTracks = useMemo(() => {
    if (!selectedFolder) return [];
    return tracks.filter((track) => track.folderUri === selectedFolder.uri);
  }, [selectedFolder, tracks]);

  const upcomingTracks = useMemo(() => currentTrack
    ? upcomingFrom(queue, queue.findIndex((track) => track.uri === currentTrack.uri))
    : [], [currentTrack, queue]);
  const queueCurrentRow = useMemo<QueueRow | null>(() => {
    if (!currentTrack) return null;
    const metadata = currentMetadata ?? metadataCache.get(currentTrack.uri) ?? fallbackMetadata(currentTrack);
    return { uri: currentTrack.uri, title: metadata.title, artist: metadata.artist };
  }, [currentMetadata, currentTrack, metadataCache]);
  const upcomingRows = useMemo<QueueRow[]>(() => upcomingTracks.map((track) => {
    const metadata = metadataCache.get(track.uri) ?? fallbackMetadata(track);
    return { uri: track.uri, title: metadata.title, artist: metadata.artist };
  }), [currentMetadata, metadataCache, upcomingTracks]);

  useEffect(() => {
    if (!isInitialized) return;
    const serialized = JSON.stringify({ folders, tracks } satisfies LibrarySnapshot);
    libraryStorageWrite.current = libraryStorageWrite.current.catch(() => undefined)
      .then(() => AsyncStorage.setItem(LIBRARY_KEY, serialized));
  }, [folders, tracks, isInitialized]);

  const rescan = useCallback(async (nextFolders: Folder[]) => {
    const revision = libraryRevision.current;
    setIsScanning(true);
    const scanResult = await scanFolders(nextFolders);
    if (revision === libraryRevision.current) {
      setFolders(scanResult.folders);
      setTracks(scanResult.tracks);
      setNotice(scanResult.tracks.length ? `${scanResult.tracks.length} MP3 file${scanResult.tracks.length === 1 ? '' : 's'} found.` : 'No MP3 files found in the selected folders.');
    }
    setIsScanning(false);
    return scanResult.tracks;
  }, []);

  const observePlayback = useCallback((currentTime = player.currentTime, playing = player.playing, buffering = player.isBuffering, duration = player.duration, index = player.currentIndex) => {
    const track = queue[index] ?? currentTrack;
    const metadata = track?.uri === currentTrack?.uri ? currentMetadata : track ? metadataCache.get(track.uri) : null;
    tracker.observe({
      track: track ? { uri: track.uri, fileName: track.name, title: metadata?.title || fallbackMetadata(track).title, artist: metadata?.artist || fallbackMetadata(track).artist } : null,
      positionSeconds: currentTime,
      durationSeconds: duration,
      playing,
      buffering,
      atMs: Date.now(),
    });
  }, [currentMetadata, currentTrack, metadataCache, player, queue, tracker]);

  useEffect(() => {
    void initializeWrappedStore().catch(() => undefined);
    void initializeWrappedBackup().catch(() => undefined);
    const timer = setInterval(() => { void tracker.flush().catch(() => undefined); }, 5000);
    return () => {
      clearInterval(timer);
      void tracker.flush().catch(() => undefined);
    };
  }, [tracker]);

  useEffect(() => {
    if (player.currentIndex !== status.currentIndex) return;
    observePlayback(status.currentTime, status.playing, status.isBuffering, status.duration, status.currentIndex);
  }, [observePlayback, player, status.currentIndex, status.currentTime, status.duration, status.isBuffering, status.playing]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        observePlayback();
        void tracker.flush().then(() => saveWrappedBackupNow()).catch(() => undefined);
        const playback = latestPlayback.current;
        if (playback) savePlayback({ ...playback, currentTime: pendingRestorePosition.current ?? Math.max(0, Math.floor(player.currentTime)) });
      } else if (nextState === 'active') {
        void initializeWrappedStore().catch(() => undefined);
      }
      if (currentTrack && nextState !== 'unknown') {
        const metadata = currentMetadata ?? fallbackMetadata(currentTrack);
        callOptionalPlayerMethod(player, 'setActiveForLockScreen', true, { title: metadata.title, artist: metadata.artist || 'mp3fy', artworkUrl: artworkCache.get(currentTrack.uri) ?? undefined });
      }
    });
    return () => subscription.remove();
  }, [artworkCache, currentMetadata, currentTrack, observePlayback, player, savePlayback, tracker]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (folderActions || folderToConfirm) {
        setFolderActions(null);
        setFolderToConfirm(null);
        return true;
      }
      if (screen.kind === 'wrapped') {
        if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
        else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
        else setScreen({ kind: 'folders' });
        return true;
      }
      if (screen.kind === 'queue') {
        if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
        else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
        else setScreen({ kind: 'folders' });
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
  }, [currentTrack, folderActions, folderToConfirm, folders, screen]);

  const loadArtwork = useCallback(async (track: Track) => {
    const request = ++artworkRequest.current;
    setIsArtworkLoading(true);
    const applyArtwork = (mediaArtwork: string | null, metadata: TrackMetadata) => {
      if (request !== artworkRequest.current) return;
      setCurrentMetadata(metadata);
      setCurrentArtwork(mediaArtwork);
      setIsArtworkLoading(false);
      callOptionalPlayerMethod(player, 'updateLockScreenMetadata', { title: metadata.title, artist: metadata.artist || 'mp3fy', artworkUrl: mediaArtwork ?? undefined });
    };

    const cachedMetadata = metadataCache.get(track.uri);
    if (artworkCache.has(track.uri) && cachedMetadata) {
      rememberCacheValue(artworkCache, track.uri, artworkCache.get(track.uri) ?? null, MAX_MEMORY_ARTWORK_ENTRIES);
      rememberCacheValue(metadataCache, track.uri, cachedMetadata, MAX_MEMORY_METADATA_ENTRIES);
      tracker.updateMetadata({ uri: track.uri, fileName: track.name, title: cachedMetadata.title, artist: cachedMetadata.artist });
      void updateTrackDetails(track.name, cachedMetadata.title, cachedMetadata.artist).catch(() => undefined);
      applyArtwork(artworkCache.get(track.uri) ?? null, cachedMetadata);
      return;
    }
    const details = await loadEmbeddedTrackDetails(track.uri, fallbackMetadata(track));
    const mediaArtwork = details.artwork ? await materializeArtwork(details.artwork, track.uri) : null;
    rememberCacheValue(artworkCache, track.uri, mediaArtwork, MAX_MEMORY_ARTWORK_ENTRIES);
    rememberCacheValue(metadataCache, track.uri, details.metadata, MAX_MEMORY_METADATA_ENTRIES);
    tracker.updateMetadata({ uri: track.uri, fileName: track.name, title: details.metadata.title, artist: details.metadata.artist });
    void updateTrackDetails(track.name, details.metadata.title, details.metadata.artist).catch(() => undefined);
    applyArtwork(mediaArtwork, details.metadata);
  }, [artworkCache, metadataCache, player, tracker]);

  useEffect(() => {
    let mounted = true;
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: true }).catch(() => undefined);
    pruneArtworkCache();
    const restore = async () => {
      let refreshFolders: Folder[] | null = null;
      try {
        const values = await AsyncStorage.multiGet([FOLDERS_KEY, PLAYBACK_KEY, LIBRARY_KEY, SHUFFLE_HISTORY_KEY]);
        const storedFolders = values[0][1];
        const storedPlayback = values[1][1];
        const storedLibrary = values[2][1];
        const storedShuffleHistory = values[3][1];
        if (storedShuffleHistory) {
          try {
            const entries: unknown = JSON.parse(storedShuffleHistory);
            if (Array.isArray(entries)) entries.forEach((entry) => {
              if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1]) && entry[1].every((uri: unknown) => typeof uri === 'string')) shuffleHistory.current.set(entry[0], entry[1]);
            });
          } catch { /* A damaged shuffle history can be rebuilt. */ }
        }
        let libraryTracks: Track[] = [];
        if (storedFolders) {
          try {
            const savedFolders: unknown = JSON.parse(storedFolders);
            if (!Array.isArray(savedFolders) || !savedFolders.every(isFolder)) throw new Error('Invalid folders');
            setFolders(savedFolders);
            let snapshot: unknown = null;
            try { snapshot = storedLibrary ? JSON.parse(storedLibrary) : null; } catch { /* Rebuild a damaged snapshot. */ }
            if (isLibrarySnapshot(snapshot, savedFolders)) {
              setFolders(snapshot.folders);
              setTracks(snapshot.tracks);
              setIsLibraryReady(true);
              libraryTracks = snapshot.tracks;
              refreshFolders = savedFolders;
            } else {
              libraryTracks = await rescan(savedFolders);
            }
          } catch {
            setNotice('Saved folders could not be restored.');
          }
        }
        if (!mounted || !storedPlayback) return;
        lastSavedPlayback.current = storedPlayback;
        let saved: unknown;
        try {
          saved = JSON.parse(storedPlayback);
        } catch {
          savePlayback(null);
          return;
        }
        if (!isSavedPlayback(saved)) {
          savePlayback(null);
          return;
        }
        const restoredMode = restorePlaybackMode(saved.mode);
        const knownTracks = new Map(libraryTracks.map((track) => [track.uri, track]));
        if (saved.standalone && !knownTracks.has(saved.track.uri)) {
          try {
            if (new File(saved.track.uri).exists) knownTracks.set(saved.track.uri, saved.track);
          } catch {
            // The selected song may have moved or its access may have been revoked.
          }
        }
        const selectedTrack = knownTracks.get(saved.track.uri);
        if (!selectedTrack) {
          savePlayback(null);
          setNotice('The last song is no longer available. Select it again to continue.');
          return;
        }
        const restoredQueue = saved.queueUris.map((uri) => knownTracks.get(uri)).filter((track): track is Track => Boolean(track));
        const nextQueue = restoredQueue.some((track) => track.uri === selectedTrack.uri)
          ? restoredQueue
          : buildQueue(libraryTracks.length ? libraryTracks : [selectedTrack], selectedTrack, restoredMode, shuffleHistory.current.get(selectedTrack.folderUri)).queue;
        if (restoredMode === 'shuffle') rememberShuffle(selectedTrack.folderUri, nextQueue);
        const nextIndex = nextQueue.findIndex((track) => track.uri === selectedTrack.uri);
        player.clear();
        nextQueue.forEach((track) => player.add({ uri: track.uri }));
        player.loop = saved.repeatMode === 'one' ? 'single' : 'all';
        player.skipTo(nextIndex);
        setQueue(nextQueue);
        setQueueIndex(nextIndex);
        setMode(restoredMode);
        setRepeatMode(saved.repeatMode);
        setCurrentTrack(selectedTrack);
        setCurrentMetadata(fallbackMetadata(selectedTrack));
        setCurrentArtwork(null);
        setIsArtworkLoading(true);
        pendingRestorePosition.current = saved.currentTime;
        void loadArtwork(selectedTrack);
        try {
          await player.seekTo(saved.currentTime);
        } catch {
          pendingRestorePosition.current = null;
        }
        restoreTimer.current = setTimeout(() => {
          if (pendingRestorePosition.current === null) return;
          pendingRestorePosition.current = null;
          const playback = latestPlayback.current;
          if (playback) savePlayback({ ...playback, currentTime: Math.max(0, Math.floor(player.currentTime)) });
        }, 5000);
      } catch {
        setNotice('Saved playback could not be restored.');
      } finally {
        if (mounted) {
          setIsLibraryReady(true);
          setIsInitialized(true);
          if (refreshFolders) {
            const foldersToRefresh = refreshFolders;
            libraryRefreshTimer.current = setTimeout(() => {
              if (mounted) void rescan(foldersToRefresh);
            }, 500);
          }
        }
      }
    };
    void restore();
    return () => {
      mounted = false;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      if (libraryRefreshTimer.current) clearTimeout(libraryRefreshTimer.current);
    };
  }, [loadArtwork, player, rememberShuffle, rescan, savePlayback]);

  useEffect(() => {
    if (!isInitialized) return;
    if (!currentTrack) {
      latestPlayback.current = null;
      savePlayback(null);
      return;
    }
    if (player.currentIndex !== status.currentIndex) return;
    if (queue.length && status.currentIndex >= 0 && status.currentIndex < queue.length
      && queue[status.currentIndex].uri !== currentTrack.uri) return;
    const pendingPosition = pendingRestorePosition.current;
    if (pendingPosition !== null && Math.abs(status.currentTime - pendingPosition) <= 1.5) {
      pendingRestorePosition.current = null;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
    }
    const playback: SavedPlayback = {
      track: currentTrack,
      queueUris: queue.map((track) => track.uri),
      currentTime: pendingRestorePosition.current ?? Math.max(0, Math.floor(status.currentTime)),
      mode,
      repeatMode,
      standalone: !folders.some((folder) => folder.uri === currentTrack.folderUri),
    };
    latestPlayback.current = playback;
    if (pendingRestorePosition.current === null) savePlayback(playback);
  }, [currentTrack, folders, isInitialized, mode, player, queue, repeatMode, savePlayback, status.currentIndex, status.currentTime]);

  const startPlayback = useCallback((nextQueue: Track[], nextIndex: number, nextRepeatMode: RepeatMode = repeatMode, nextMode: PlaybackMode = mode) => {
    const nextTrack = nextQueue[nextIndex];
    if (!nextTrack) return;
    observePlayback();
    tracker.restart();
    void tracker.flush().catch(() => undefined);
    pendingRestorePosition.current = 0;
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    player.clear();
    nextQueue.forEach((track) => player.add({ uri: track.uri }));
    player.loop = nextRepeatMode === 'one' ? 'single' : 'all';
    player.skipTo(nextIndex);
    const playback: SavedPlayback = {
      track: nextTrack,
      queueUris: nextQueue.map((track) => track.uri),
      currentTime: 0,
      mode: nextMode,
      repeatMode: nextRepeatMode,
      standalone: !folders.some((folder) => folder.uri === nextTrack.folderUri),
    };
    latestPlayback.current = playback;
    savePlayback(playback);
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    setCurrentTrack(nextTrack);
    const nextMetadata = fallbackMetadata(nextTrack);
    setCurrentMetadata(nextMetadata);
    setCurrentArtwork(null);
    setIsArtworkLoading(true);
    callOptionalPlayerMethod(player, 'setActiveForLockScreen', true, { title: nextMetadata.title, artist: nextMetadata.artist || 'mp3fy' });
    player.play();
    restoreTimer.current = setTimeout(() => {
      if (pendingRestorePosition.current === null) return;
      pendingRestorePosition.current = null;
      const current = latestPlayback.current;
      if (current) savePlayback({ ...current, currentTime: Math.max(0, Math.floor(player.currentTime)) });
    }, 5000);
    void loadArtwork(nextTrack);
  }, [folders, loadArtwork, mode, observePlayback, player, repeatMode, savePlayback, tracker]);

  const replaceQueueWithoutInterrupt = useCallback((nextQueue: Track[], nextIndex: number, nextMode = mode, nextRepeatMode = repeatMode) => {
    const activeNativeIndex = player.currentIndex;
    const activeQueueIndex = queue.findIndex((track) => track.uri === currentTrack?.uri);
    if (!currentTrack || activeNativeIndex < 0 || activeNativeIndex >= player.trackCount || activeQueueIndex < 0) return false;

    // Keep the active native item in place while removing and inserting the
    // surrounding items. This avoids clear(), skipTo(), seekTo(), and play().
    for (let index = player.trackCount - 1; index >= 0; index -= 1) {
      if (index !== activeNativeIndex) player.remove(index);
    }
    nextQueue.slice(0, nextIndex).forEach((track, index) => player.insert({ uri: track.uri }, index));
    const nextTrackIndex = nextIndex;
    nextQueue.slice(nextIndex + 1).forEach((track, index) => player.insert({ uri: track.uri }, nextTrackIndex + 1 + index));
    player.loop = nextRepeatMode === 'one' ? 'single' : 'all';
    setQueue(nextQueue);
    setQueueIndex(nextIndex);
    const playback = latestPlayback.current;
    if (playback) {
      const updated = { ...playback, queueUris: nextQueue.map((track) => track.uri), currentTime: pendingRestorePosition.current ?? Math.max(0, Math.floor(player.currentTime)), mode: nextMode, repeatMode: nextRepeatMode };
      latestPlayback.current = updated;
      savePlayback(updated);
    }
    return true;
  }, [currentTrack, mode, player, queue, repeatMode, savePlayback]);

  useEffect(() => {
    if (!queue.length || status.currentIndex < 0 || status.currentIndex >= queue.length) return;
    if (player.currentIndex !== status.currentIndex) return;
    const nextTrack = queue[status.currentIndex];
    setQueueIndex(status.currentIndex);
    if (currentTrack?.uri === nextTrack.uri) return;
    setCurrentTrack(nextTrack);
    setCurrentArtwork(null);
    setIsArtworkLoading(true);
    const nextMetadata = fallbackMetadata(nextTrack);
    setCurrentMetadata(nextMetadata);
    callOptionalPlayerMethod(player, 'updateLockScreenMetadata', { title: nextMetadata.title, artist: nextMetadata.artist || 'mp3fy' });
    void loadArtwork(nextTrack);
  }, [currentTrack?.uri, loadArtwork, player, queue, status.currentIndex]);

  useEffect(() => {
    player.loop = repeatMode === 'one' ? 'single' : 'all';
  }, [player, repeatMode]);

  const playTrack = useCallback((track: Track) => {
    const nextPlayback = buildQueue(tracks, track, 'folder');
    setMode('folder');
    startPlayback(nextPlayback.queue, nextPlayback.index, repeatMode, 'folder');
    setScreen({ kind: 'player', returnTo: 'songs' });
  }, [repeatMode, startPlayback, tracks]);

  const addSong = useCallback(async () => {
    setNotice('Selecting a song.');
    try {
      const selection = await File.pickFileAsync({ mimeTypes: ['audio/mpeg', 'audio/*'] });
      if (selection.canceled) {
        setNotice('Song selection cancelled.');
        return;
      }
      const selectedFile = selection.result;
      if (!selectedFile.name.toLowerCase().endsWith('.mp3')) {
        setNotice('Please select an MP3 file.');
        return;
      }

      const parentDirectory = selectedFile.parentDirectory;
      const selectedTrack: Track = {
        folderName: parentDirectory.name || 'Selected song',
        folderUri: parentDirectory.uri,
        name: selectedFile.name,
        uri: selectedFile.uri,
      };
      setRepeatMode('one');
      startPlayback([selectedTrack], 0, 'one');
      setScreen({ kind: 'player', returnTo: 'folders' });
      setNotice(`${selectedFile.name} selected.`);
    } catch {
      setNotice('Song selection was cancelled or unavailable.');
    }
  }, [startPlayback]);

  const playNext = useCallback(() => {
    if (queue.length) {
      observePlayback();
      tracker.restart();
      void tracker.flush().catch(() => undefined);
      pendingRestorePosition.current = null;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      player.next();
    }
  }, [observePlayback, player, queue.length, tracker]);

  const playPrevious = useCallback(() => {
    if (!queue.length) return;
    observePlayback();
    tracker.restart();
    void tracker.flush().catch(() => undefined);
    pendingRestorePosition.current = null;
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    if (status.currentTime > 3) {
      player.seekTo(0).catch(() => undefined);
      return;
    }
    player.previous();
  }, [observePlayback, player, queue, queueIndex, status.currentTime, tracker]);

  const updateQueuePreference = useCallback((nextMode: PlaybackMode) => {
    if (!currentTrack) {
      setMode(nextMode);
      return;
    }
    const nextPlayback = buildQueue(tracks, currentTrack, nextMode, shuffleHistory.current.get(currentTrack.folderUri), Math.random, queueTitleFor);
    if (replaceQueueWithoutInterrupt(nextPlayback.queue, nextPlayback.index, nextMode)) {
      setMode(nextMode);
      if (nextMode === 'shuffle') rememberShuffle(currentTrack.folderUri, nextPlayback.queue);
    }
  }, [currentTrack, queueTitleFor, rememberShuffle, replaceQueueWithoutInterrupt, tracks]);

  const reorderUpcoming = useCallback((from: number, to: number) => {
    if (!currentTrack || from < 0 || to < 0 || from >= upcomingTracks.length || to >= upcomingTracks.length) return;
    replaceQueueWithoutInterrupt([currentTrack, ...moveUpcoming(upcomingTracks, from, to)], 0);
  }, [currentTrack, replaceQueueWithoutInterrupt, upcomingTracks]);

  const removeUpcoming = useCallback((uri: string) => {
    if (!currentTrack || !upcomingTracks.some((track) => track.uri === uri)) return;
    const nextUpcoming = upcomingTracks.filter((track) => track.uri !== uri);
    const nextRepeatMode = nextUpcoming.length ? repeatMode : 'one';
    if (replaceQueueWithoutInterrupt([currentTrack, ...nextUpcoming], 0, mode, nextRepeatMode) && !nextUpcoming.length) setRepeatMode('one');
  }, [currentTrack, mode, repeatMode, replaceQueueWithoutInterrupt, upcomingTracks]);

  const clearUpcoming = useCallback(() => {
    if (!currentTrack || !upcomingTracks.length) return;
    if (replaceQueueWithoutInterrupt([currentTrack], 0, mode, 'one')) setRepeatMode('one');
  }, [currentTrack, mode, replaceQueueWithoutInterrupt, upcomingTracks.length]);

  const addFolder = useCallback(async () => {
    setNotice('Selecting a folder.');
    let scanningUri: string | null = null;
    try {
      const selectedDirectory = await Directory.pickDirectoryAsync();
      const nextFolder: Folder = { name: selectedDirectory.name, uri: selectedDirectory.uri };
      if (folders.some((folder) => folder.uri === nextFolder.uri)) {
        setNotice('That folder is already selected.');
        return;
      }
      const nextFolders = [...folders, nextFolder];
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      libraryRevision.current += 1;
      scanningUri = nextFolder.uri;
      setFolders((existing) => [...existing, nextFolder]);
      setScanningFolderUris((existing) => new Set(existing).add(nextFolder.uri));
      const scanResult = await scanFolder(nextFolder);
      setFolders((existing) => existing.map((folder) => folder.uri === nextFolder.uri ? scanResult.folder : folder));
      setTracks((existing) => [...existing.filter((track) => track.folderUri !== nextFolder.uri), ...scanResult.tracks].sort((a, b) => `${a.folderName}/${a.name}`.localeCompare(`${b.folderName}/${b.name}`)));
      setNotice(`${scanResult.tracks.length} MP3 file${scanResult.tracks.length === 1 ? '' : 's'} found in ${nextFolder.name}.`);
    } catch {
      setNotice('Folder selection was cancelled or unavailable.');
    } finally {
      if (scanningUri) {
        setScanningFolderUris((existing) => {
          const next = new Set(existing);
          next.delete(scanningUri as string);
          return next;
        });
      }
    }
  }, [folders]);

  const removeFolder = useCallback(async (folder: Folder) => {
    setNotice(`Removing ${folder.name}.`);
    try {
      const nextFolders = folders.filter((item) => item.uri !== folder.uri);
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      libraryRevision.current += 1;
      setFolders(nextFolders);
      setTracks((existing) => existing.filter((track) => track.folderUri !== folder.uri));
      if (screen.kind === 'songs' && screen.folderUri === folder.uri) setScreen({ kind: 'folders' });
      if (currentTrack?.folderUri === folder.uri) {
        observePlayback();
        tracker.restart();
        void tracker.flush().catch(() => undefined);
        pendingRestorePosition.current = null;
        if (restoreTimer.current) clearTimeout(restoreTimer.current);
        latestPlayback.current = null;
        savePlayback(null);
        player.pause();
        player.clear();
        callOptionalPlayerMethod(player, 'setActiveForLockScreen', false);
        setCurrentTrack(null);
        setCurrentArtwork(null);
        setQueue([]);
        setQueueIndex(-1);
        setScreen({ kind: 'folders' });
      }
      setNotice(`${folder.name} removed.`);
    } catch {
      setNotice('The folder could not be removed.');
    }
  }, [currentTrack, folders, observePlayback, player, savePlayback, screen, tracker]);

  const openFolder = useCallback((folder: Folder) => setScreen({ kind: 'songs', folderUri: folder.uri }), []);
  const togglePlayback = useCallback(() => {
    observePlayback();
    pendingRestorePosition.current = null;
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    if (status.playing) {
      player.pause();
      void tracker.flush().catch(() => undefined);
      const playback = latestPlayback.current;
      if (playback) savePlayback({ ...playback, currentTime: Math.max(0, Math.floor(player.currentTime)) });
    } else player.play();
  }, [observePlayback, player, savePlayback, status.playing, tracker]);
  const seek = (event: { nativeEvent: { locationX: number } }) => {
    if (!progressWidth || !status.duration) return;
    observePlayback();
    pendingRestorePosition.current = null;
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    const ratio = Math.max(0, Math.min(1, event.nativeEvent.locationX / progressWidth));
    const nextTime = ratio * status.duration;
    tracker.markSeek(nextTime);
    void tracker.flush().catch(() => undefined);
    player.seekTo(nextTime).then(() => {
      const playback = latestPlayback.current;
      if (playback) savePlayback({ ...playback, currentTime: Math.floor(nextTime) });
    }).catch(() => tracker.cancelSeek());
  };
  const displayedStatus = pendingRestorePosition.current === null
    ? status
    : { ...status, currentTime: pendingRestorePosition.current };
  const progress = displayedStatus.duration ? Math.min(1, displayedStatus.currentTime / displayedStatus.duration) : 0;

  const openPlayerFromMini = useCallback(() => {
    if (currentTrack) setScreen({ kind: 'player', returnTo: screen.kind === 'songs' ? 'songs' : 'folders' });
  }, [currentTrack, screen.kind]);

  const openQueue = useCallback(() => {
    if (!currentTrack || screen.kind === 'queue' || screen.kind === 'wrapped') return;
    setScreen({ kind: 'queue', returnTo: screen.kind, folderUri: screen.kind === 'songs' ? screen.folderUri : undefined, playerReturnTo: screen.kind === 'player' ? screen.returnTo : undefined });
  }, [currentTrack, screen]);
  const closeQueue = useCallback(() => {
    if (screen.kind !== 'queue') return;
    if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
    else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
    else setScreen({ kind: 'folders' });
  }, [currentTrack, folders, screen]);

  const openWrapped = useCallback(() => {
    observePlayback();
    void tracker.flush().catch(() => undefined);
    setScreen({ kind: 'wrapped', returnTo: screen.kind === 'wrapped' ? 'folders' : screen.kind === 'queue' ? screen.returnTo : screen.kind, folderUri: screen.kind === 'songs' ? screen.folderUri : screen.kind === 'queue' ? screen.folderUri : undefined, playerReturnTo: screen.kind === 'player' ? screen.returnTo : screen.kind === 'queue' ? screen.playerReturnTo : undefined });
  }, [observePlayback, screen, tracker]);

  const prepareWrappedBackup = useCallback(async () => {
    observePlayback();
    await tracker.flush();
  }, [observePlayback, tracker]);

  const restoreWrappedHistory = useCallback(async (contents: string) => {
    observePlayback();
    player.pause();
    await tracker.flush();
    await restoreWrappedBackup(contents);
    tracker.restart();
    setWrappedRevision((revision) => revision + 1);
    noteWrappedHistoryChanged();
    void saveWrappedBackupNow().catch(() => undefined);
  }, [observePlayback, player, tracker]);

  const closeWrapped = useCallback(() => {
    if (screen.kind !== 'wrapped') return;
    if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
    else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
    else setScreen({ kind: 'folders' });
  }, [currentTrack, folders, screen]);

  if (!isLibraryReady) {
    return (
      <>
        <SystemStatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent={false} />
        <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
          <View style={styles.container}>
            <View style={styles.startupLoading}>
              <ActivityIndicator color="#000000" />
              <Text style={styles.notice}>Loading library...</Text>
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
            <FoldersScreen folders={folderCounts} tracksCount={tracks.length} hasQueue={Boolean(currentTrack)} isScanning={isScanning} scanningFolderUris={scanningFolderUris} notice={notice} onAddFolder={addFolder} onAddSong={addSong} onOpenFolder={openFolder} onLongPressFolder={setFolderActions} onOpenWrapped={openWrapped} onOpenQueue={openQueue} />
          ) : screen.kind === 'songs' && selectedFolder ? (
            <SongsScreen folder={selectedFolder} tracks={selectedFolderTracks} currentTrack={currentTrack} currentMetadata={currentMetadata} metadataCache={metadataCache} isScanning={isScanning} onPlayTrack={playTrack} onOpenQueue={openQueue} />
          ) : screen.kind === 'wrapped' ? (
            <WrappedScreen revision={wrappedRevision} onBack={closeWrapped} onPrepareBackup={prepareWrappedBackup} onRestoreBackup={restoreWrappedHistory} />
          ) : screen.kind === 'queue' && queueCurrentRow ? (
            <QueueScreen current={queueCurrentRow} upcoming={upcomingRows} playing={status.playing} onBack={closeQueue} onMove={reorderUpcoming} onRemove={removeUpcoming} onClear={clearUpcoming} />
          ) : currentTrack ? (
            <PlayerScreen track={currentTrack} metadata={currentMetadata ?? fallbackMetadata(currentTrack)} artwork={currentArtwork} artworkLoading={isArtworkLoading} status={displayedStatus} progress={progress} progressWidth={progressWidth} mode={mode} repeatMode={repeatMode} onSeek={seek} onProgressLayout={(event) => setProgressWidth(event.nativeEvent.layout.width)} onPrevious={playPrevious} onNext={playNext} onTogglePlay={togglePlayback} onModeChange={updateQueuePreference} onRepeatChange={setRepeatMode} onOpenQueue={openQueue} />
          ) : null}

          {screen.kind !== 'player' && screen.kind !== 'queue' && currentTrack ? <MiniPlayer track={currentTrack} metadata={currentMetadata ?? fallbackMetadata(currentTrack)} artwork={currentArtwork} artworkLoading={isArtworkLoading} playing={status.playing} onOpen={openPlayerFromMini} onTogglePlay={togglePlayback} onNext={playNext} /> : null}
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

function ScreenHeader({ right }: { right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerMain}>
        <Text style={styles.wordmark}>mp3fy</Text>
        <Text style={styles.label}>{APP_VERSION}</Text>
      </View>
      {right ?? null}
    </View>
  );
}

function WrappedButton({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Open Wrapped" onPress={onPress} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="timer-sand" size={21} color="#000000" /></Pressable>;
}

function QueueButton({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Open queue" onPress={onPress} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="playlist-music" size={22} color="#000000" /></Pressable>;
}

function FolderArtwork({ uri }: { uri?: string | null }) {
  return uri ? <Image source={{ uri }} style={styles.folderArtwork} /> : <View style={styles.folderArtworkPlaceholder}><Text style={styles.folderArtworkPlaceholderText}>DIR</Text></View>;
}

const FoldersScreen = memo(function FoldersScreen({ folders, tracksCount, hasQueue, isScanning, scanningFolderUris, notice, onAddFolder, onAddSong, onOpenFolder, onLongPressFolder, onOpenWrapped, onOpenQueue }: { folders: { folder: Folder; count: number }[]; tracksCount: number; hasQueue: boolean; isScanning: boolean; scanningFolderUris: ReadonlySet<string>; notice: string; onAddFolder: () => void; onAddSong: () => void; onOpenFolder: (folder: Folder) => void; onLongPressFolder: (folder: Folder) => void; onOpenWrapped: () => void; onOpenQueue: () => void }) {
  return (
    <View style={styles.screen}>
      <ScreenHeader right={<View style={styles.headerActions}><Text style={styles.count}>{folders.length} FOLDERS • {tracksCount} TRACKS</Text><View style={styles.homeHeaderActions}><Pressable accessibilityRole="button" accessibilityLabel="Add song" accessibilityHint="Choose an MP3 file" onPress={onAddSong} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="music-note-plus" size={22} color="#000000" /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Add folder" accessibilityHint="Choose a folder of MP3 files" onPress={onAddFolder} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="folder-plus-outline" size={22} color="#000000" /></Pressable>{hasQueue ? <QueueButton onPress={onOpenQueue} /> : null}<WrappedButton onPress={onOpenWrapped} /></View></View>} />
      {isScanning && !folders.length ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning selected folders...</Text></View> : folders.length ? <FlatList data={folders} keyExtractor={({ folder }) => folder.uri} renderItem={({ item }) => <Pressable delayLongPress={450} onLongPress={() => onLongPressFolder(item.folder)} onPress={() => onOpenFolder(item.folder)} style={({ pressed }) => [styles.folderCard, pressed && styles.pressed]}><FolderArtwork uri={item.folder.imageUri} /><View style={styles.folderCopy}><Text style={styles.folderTitle} numberOfLines={1}>{item.folder.name}</Text><View style={styles.folderMetaRow}><Text style={styles.folderMeta}>{item.count}</Text>{scanningFolderUris.has(item.folder.uri) ? <ActivityIndicator color="#000000" size="small" /> : null}</View></View><Text style={styles.chevron}>&gt;</Text></Pressable>} contentContainerStyle={styles.listContent} initialNumToRender={8} maxToRenderPerBatch={8} removeClippedSubviews windowSize={5} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No folders selected</Text><Text style={styles.description}>Add a folder containing your MP3 files. Only the folders you choose will be scanned.</Text><Text style={styles.notice}>{notice}</Text></View>}
    </View>
  );
});

const SongsScreen = memo(function SongsScreen({ folder, tracks, currentTrack, currentMetadata, metadataCache, isScanning, onPlayTrack, onOpenQueue }: { folder: Folder; tracks: Track[]; currentTrack: Track | null; currentMetadata: TrackMetadata | null; metadataCache: ReadonlyMap<string, TrackMetadata>; isScanning: boolean; onPlayTrack: (track: Track) => void; onOpenQueue: () => void }) {
  const [search, setSearch] = useState('');
  const visibleTracks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tracks.map((track) => ({
      track,
      metadata: track.uri === currentTrack?.uri && currentMetadata
        ? currentMetadata
        : metadataCache.get(track.uri) ?? fallbackMetadata(track),
    })).filter(({ track, metadata }) => !query || `${metadata.title} ${metadata.artist} ${track.name}`.toLowerCase().includes(query))
      .sort((a, b) => a.metadata.title.localeCompare(b.metadata.title) || a.track.name.localeCompare(b.track.name));
  }, [currentMetadata, currentTrack, metadataCache, search, tracks]);
  return (
    <View style={styles.screen}>
      <ScreenHeader right={<View style={styles.headerActions}><Text style={styles.count}>{tracks.length} TRACKS</Text><View style={styles.playerHeaderButtons}>{currentTrack ? <QueueButton onPress={onOpenQueue} /> : null}</View></View>} />
      <View style={styles.pageHeading}><Text numberOfLines={2} style={styles.screenTitle}>{folder.name}</Text></View>
      <TextInput accessibilityLabel="Search songs in folder" onChangeText={setSearch} placeholder="Search songs" placeholderTextColor="#666666" style={styles.search} value={search} />
      {isScanning ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning folder.</Text></View> : visibleTracks.length ? <FlatList data={visibleTracks} keyExtractor={({ track }) => track.uri} initialNumToRender={16} maxToRenderPerBatch={12} removeClippedSubviews windowSize={7} renderItem={({ item: { track, metadata } }) => {
        const isPlaying = currentTrack?.uri === track.uri;
        return <Pressable onPress={() => onPlayTrack(track)} style={({ pressed }) => [styles.trackRow, isPlaying && styles.activeTrackRow, pressed && styles.pressed]}><View style={[styles.trackIndicator, isPlaying && styles.activeTrackIndicator]} /><View style={styles.trackCopy}>{isPlaying ? <MarqueeText style={styles.trackNameViewport} text={metadata.title} textStyle={styles.trackName} fadeColor="#F2F2F2" fadeTransparentColor="rgba(242,242,242,0)" /> : <Text ellipsizeMode="tail" numberOfLines={1} style={styles.trackName}>{metadata.title}</Text>}{metadata.artist ? <Text ellipsizeMode="tail" numberOfLines={1} style={styles.trackArtist}>{metadata.artist}</Text> : null}</View></Pressable>;
      }} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No MP3 files</Text><Text style={styles.description}>This folder does not currently contain any MP3 files.</Text></View>}
    </View>
  );
});

const MiniPlayer = memo(function MiniPlayer({ track, metadata, artwork, artworkLoading, playing, onOpen, onTogglePlay, onNext }: { track: Track; metadata: TrackMetadata; artwork: string | null; artworkLoading: boolean; playing: boolean; onOpen: () => void; onTogglePlay: () => void; onNext: () => void }) {
  return <View style={styles.miniPlayer}><Pressable onPress={onOpen} style={styles.miniMain}><AlbumArt label={metadata.title} size={52} uri={artwork} loading={artworkLoading} /><View style={styles.miniCopy}><Text style={styles.miniLabel}>NOW PLAYING</Text><MarqueeText style={styles.miniTitleViewport} text={metadata.title} textStyle={styles.miniTitle} /><MarqueeText style={styles.miniArtistViewport} text={metadata.artist || track.folderName} textStyle={styles.miniFolder} /></View></Pressable><Pressable accessibilityRole="button" onPress={onTogglePlay} style={styles.miniButton}><Text style={styles.miniButtonText}>{playing ? '||' : '>'}</Text></Pressable><Pressable accessibilityRole="button" onPress={onNext} style={styles.miniButton}><Text style={styles.miniButtonText}>&gt;|</Text></Pressable></View>;
});

type TransportIconKind = 'shuffle' | 'repeatAll' | 'repeatOne';

function TransportGlyph({ kind, active }: { kind: TransportIconKind; active: boolean }) {
  const color = active ? '#FFFFFF' : '#000000';
  if (kind === 'repeatAll' || kind === 'repeatOne') {
    // The ring is identical in both states; repeat-one just adds a small raised "1" (like an exponent) in the free space to its right.
    return <View style={styles.repeatFrame}><Text style={[styles.glyphText, styles.repeatRing, { color }]}>{'\u21bb'}</Text>{kind === 'repeatOne' ? <Text style={[styles.repeatOneNumber, { color }]}>1</Text> : null}</View>;
  }
  const bar = (left: number, top: number, width: number) => <View style={[styles.glyphBar, { backgroundColor: color, left, top, width }]} />;
  const head = (top: number) => <View style={[styles.glyphArrowHead, { borderLeftColor: color, top }]} />;
  // Two lines that cross over each other, both ending in arrows.
  return <View style={styles.smallIconFrame}>{bar(0, 5, 5)}{bar(0, 13, 5)}<View style={[styles.glyphBar, { backgroundColor: color, left: 3.3, top: 9, width: 11.3, transform: [{ rotate: '45deg' }] }]} /><View style={[styles.glyphBar, { backgroundColor: color, left: 3.3, top: 9, width: 11.3, transform: [{ rotate: '-45deg' }] }]} />{bar(13, 5, 3)}{bar(13, 13, 3)}{head(3)}{head(11)}</View>;
}

function IconButton({ icon, accessibilityLabel, onPress, active = false, transport = false }: { icon: TransportIconKind; accessibilityLabel: string; onPress: () => void; active?: boolean; transport?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.iconButton, transport && styles.transportSideButton, active && styles.activeIconButton, pressed && styles.pressed]}><TransportGlyph kind={icon} active={active} /></Pressable>;
}

function PlaybackOrderButton({ mode, onPress }: { mode: PlaybackMode; onPress: () => void }) {
  const shuffled = mode === 'shuffle';
  const accessibilityLabel = mode === 'folder' ? 'Folder filename order. Switch to song title order' : mode === 'title' ? 'Song title order. Switch to shuffle' : 'Shuffle. Switch to folder filename order';
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [styles.iconButton, styles.transportSideButton, shuffled && styles.activeIconButton, pressed && styles.pressed]}>{shuffled ? <TransportGlyph kind="shuffle" active /> : <Text style={styles.orderModeText}>{mode === 'folder' ? 'A-Z' : 'a-z'}</Text>}</Pressable>;
}

function PlayerScreen({ track, metadata, artwork, artworkLoading, status, progress, progressWidth, mode, repeatMode, onSeek, onProgressLayout, onPrevious, onNext, onTogglePlay, onModeChange, onRepeatChange, onOpenQueue }: { track: Track; metadata: TrackMetadata; artwork: string | null; artworkLoading: boolean; status: AudioPlaylistStatus; progress: number; progressWidth: number; mode: PlaybackMode; repeatMode: RepeatMode; onSeek: (event: { nativeEvent: { locationX: number } }) => void; onProgressLayout: (event: LayoutChangeEvent) => void; onPrevious: () => void; onNext: () => void; onTogglePlay: () => void; onModeChange: (mode: PlaybackMode) => void; onRepeatChange: (mode: RepeatMode) => void; onOpenQueue: () => void }) {
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsResult, setLyricsResult] = useState<LyricsResult | null>(null);
  const lyricsRequest = useRef(0);

  const requestLyrics = useCallback(() => {
    if (lyricsLoading) return;
    const requestId = ++lyricsRequest.current;
    setLyricsLoading(true);
    setLyricsResult(null);
    void fetchLyrics({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album || undefined,
      duration: Number.isFinite(status.duration) && status.duration >= 1 && status.duration <= 3600 ? status.duration : undefined,
    }).then((result) => {
      if (requestId !== lyricsRequest.current) return;
      setLyricsResult(result);
      setLyricsLoading(false);
    });
  }, [lyricsLoading, metadata.album, metadata.artist, metadata.title, status.duration]);

  const openLyrics = useCallback(() => {
    setLyricsOpen(true);
    if (!lyricsResult && !lyricsLoading) requestLyrics();
  }, [lyricsLoading, lyricsResult, requestLyrics]);

  useEffect(() => {
    lyricsRequest.current += 1;
    setLyricsOpen(false);
    setLyricsLoading(false);
    setLyricsResult(null);
    return () => { lyricsRequest.current += 1; };
  }, [track.uri]);

  return (
    <ScrollView contentContainerStyle={styles.playerScreen} showsVerticalScrollIndicator={false}>
      <ScreenHeader right={<View style={styles.playerHeaderActions}><MarqueeText alignRight style={styles.playerHeaderFolderViewport} text={track.folderName} textStyle={styles.playerHeaderFolderText} /></View>} />
      <View style={styles.playerArt}><AlbumArt label={metadata.title} size={280} uri={artwork} loading={artworkLoading} /></View>
      <View style={styles.playerTitleRow}><MarqueeText style={styles.playerTitleViewport} text={metadata.title} textStyle={styles.playerTitle} /><View style={styles.playerTitleActions}><Pressable accessibilityRole="button" accessibilityLabel="Show lyrics" onPress={openLyrics} style={({ pressed }) => [styles.lyricsButton, pressed && styles.pressed]}><Text style={styles.lyricsButtonText}>LYRICS</Text></Pressable><QueueButton onPress={onOpenQueue} /></View></View>
      {metadata.artist ? <MarqueeText style={styles.playerArtistViewport} text={metadata.artist} textStyle={styles.playerArtist} /> : null}
      {metadata.album || metadata.trackNumber ? <View style={styles.metadataDetails}>
        {metadata.album ? <MarqueeText style={styles.metadataAlbumViewport} text={metadata.album} textStyle={styles.metadataItem} /> : null}
        {metadata.trackNumber ? <Text style={styles.metadataItem} numberOfLines={1}>#{metadata.trackNumber}</Text> : null}
      </View> : null}
      <Pressable accessibilityRole="adjustable" onLayout={onProgressLayout} onPress={onSeek} style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></Pressable>
      <View style={styles.timeRow}><Text style={styles.timeText}>{formatTime(status.currentTime)}</Text><Text style={styles.timeText}>{formatTime(status.duration)}</Text></View>
      <View style={styles.transportRow}><PlaybackOrderButton mode={mode} onPress={() => onModeChange(nextPlaybackMode(mode))} /><SmallButton label="|<" transport onPress={onPrevious} /><ActionButton label={status.playing ? 'PAUSE' : 'PLAY'} transport onPress={onTogglePlay} /><SmallButton label="|>" transport onPress={onNext} /><IconButton icon={repeatMode === 'one' ? 'repeatOne' : 'repeatAll'} transport accessibilityLabel={repeatMode === 'one' ? 'Repeat current song. Switch to repeat folder' : 'Repeat folder. Switch to repeat current song'} active={repeatMode === 'one'} onPress={() => onRepeatChange(repeatMode === 'one' ? 'all' : 'one')} /></View>
      <LyricsModal visible={lyricsOpen} title={metadata.title} artist={metadata.artist} result={lyricsResult} loading={lyricsLoading} currentTime={status.currentTime} onClose={() => setLyricsOpen(false)} onRetry={requestLyrics} />
    </ScrollView>
  );
}

function LyricsModal({ visible, title, artist, result, loading, currentTime, onClose, onRetry }: { visible: boolean; title: string; artist: string; result: LyricsResult | null; loading: boolean; currentTime: number; onClose: () => void; onRetry: () => void }) {
  const scrollRef = useRef<ScrollView>(null);
  const lineOffsets = useRef<Record<number, number>>({});
  const previousActiveLine = useRef(-2);
  const syncedLines = result?.kind === 'synced' ? result.lines : [];
  const activeLine = useMemo(() => {
    if (result?.kind !== 'synced') return -1;
    let active = -1;
    result.lines.forEach((line, index) => { if (line.timestampMs / 1000 <= currentTime) active = index; });
    return active;
  }, [currentTime, result]);

  useEffect(() => {
    lineOffsets.current = {};
    previousActiveLine.current = -2;
  }, [result]);

  useEffect(() => {
    if (activeLine < 0 || activeLine === previousActiveLine.current) return;
    previousActiveLine.current = activeLine;
    const offset = lineOffsets.current[activeLine];
    if (offset !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, offset - 120), animated: true });
  }, [activeLine]);

  return <Modal animationType="slide" visible={visible} onRequestClose={onClose}>
    <View style={styles.lyricsModal}>
      <View style={styles.lyricsHeader}><View><Text style={styles.wordmark}>mp3fy</Text><Text style={styles.label}>LYRICS</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close lyrics" onPress={onClose} style={styles.headerIconButton}><MaterialCommunityIcons name="close" size={23} color="#000000" /></Pressable></View>
      <View style={styles.lyricsTrack}><Text numberOfLines={1} style={styles.lyricsTitle}>{title}</Text>{artist ? <Text numberOfLines={1} style={styles.lyricsArtist}>{artist}</Text> : null}</View>
      {loading ? <View style={styles.lyricsMessage}><ActivityIndicator color="#000000" /><Text style={styles.lyricsMessageText}>Loading lyrics...</Text></View> : result?.kind === 'error' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>Lyrics unavailable</Text><Text style={styles.lyricsMessageText}>{result.message}</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.lyricsRetry}><Text style={styles.lyricsRetryText}>TRY AGAIN</Text></Pressable></View> : result?.kind === 'not-found' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>No lyrics found</Text><Text style={styles.lyricsMessageText}>LRCLIB does not have lyrics for this song.</Text></View> : result?.kind === 'instrumental' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>Instrumental track</Text><Text style={styles.lyricsMessageText}>There are no lyrics for this song.</Text></View> : result?.kind === 'plain' ? <ScrollView contentContainerStyle={styles.lyricsContent} showsVerticalScrollIndicator={false}>{result.plainLyrics.split(/\r?\n/).map((line, index) => <Text key={`${index}-${line}`} style={styles.plainLyricLine}>{line || ' '}</Text>)}</ScrollView> : result?.kind === 'synced' ? <ScrollView ref={scrollRef} contentContainerStyle={styles.lyricsContent} showsVerticalScrollIndicator={false}>{syncedLines.map((line, index) => <View key={`${index}-${line.timestampMs}`} onLayout={(event) => { lineOffsets.current[index] = event.nativeEvent.layout.y; }} style={styles.syncedLyricRow}><Text style={[styles.syncedLyricText, index === activeLine && styles.activeSyncedLyricText]}>{line.text || ' '}</Text></View>)}</ScrollView> : null}
    </View>
  </Modal>;
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
  headerActions: { alignItems: 'flex-end', gap: 7 },
  homeHeaderActions: { flexDirection: 'row', gap: 6, marginLeft: 8 },
  headerIconButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 36, justifyContent: 'center', width: 36 },
  pageHeading: { paddingTop: 20 },
  screenTitle: { color: '#000000', fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  helperText: { color: '#555555', fontSize: 12, lineHeight: 18, marginTop: 14 },
  button: { alignItems: 'center', backgroundColor: '#000000', height: 48, justifyContent: 'center', minWidth: 112, paddingHorizontal: 14 },
  secondaryButton: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1 },
  buttonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  secondaryButtonText: { color: '#000000' },
  smallButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 48, justifyContent: 'center', paddingHorizontal: 0, width: 48 },
  activeSmallButton: { backgroundColor: '#000000' },
  smallButtonText: { color: '#000000', fontSize: 16, fontWeight: '700', letterSpacing: 0.6 },
  activeSmallButtonText: { color: '#FFFFFF' },
  pressed: { opacity: 0.6 },
  folderCard: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', paddingVertical: 16 },
  folderArtwork: { height: 54, width: 54 },
  folderArtworkPlaceholder: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1, height: 54, justifyContent: 'center', width: 54 },
  folderArtworkPlaceholderText: { color: '#000000', fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  folderCopy: { flex: 1, marginLeft: 14 },
  folderTitle: { color: '#000000', fontSize: 16, fontWeight: '700' },
  folderMetaRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  folderMeta: { color: '#555555', fontSize: 14, fontWeight: '700', marginTop: 5 },
  chevron: { color: '#000000', fontSize: 20, paddingLeft: 14 },
  listContent: { paddingBottom: 18, paddingTop: 10 },
  trackRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
  activeTrackRow: { backgroundColor: '#F2F2F2' },
  trackIndicator: { backgroundColor: 'transparent', height: 38, marginRight: 10, width: 4 },
  activeTrackIndicator: { backgroundColor: '#000000' },
  trackCopy: { flex: 1, marginRight: 12 },
  trackNameViewport: { minWidth: 0 },
  trackName: { color: '#000000', fontSize: 15, fontWeight: '600' },
  trackArtist: { color: '#666666', fontSize: 12, marginTop: 4 },
  search: { borderBottomColor: '#000000', borderBottomWidth: 1, color: '#000000', fontSize: 15, marginTop: 18, paddingBottom: 9, paddingHorizontal: 0 },
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  startupLoading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'flex-start', flex: 1, justifyContent: 'center' },
  rule: { backgroundColor: '#000000', height: 4, marginBottom: 20, width: 42 },
  title: { color: '#000000', fontSize: 24, fontWeight: '700' },
  description: { color: '#000000', fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 340 },
  notice: { color: '#444444', fontSize: 12, lineHeight: 18, marginTop: 16 },
  miniPlayer: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, flexDirection: 'row', marginBottom: 10, padding: 6 },
  miniMain: { alignItems: 'center', flex: 1, flexDirection: 'row', minWidth: 0 },
  miniCopy: { flex: 1, marginLeft: 10, minWidth: 0 },
  miniLabel: { color: '#555555', fontSize: 8, fontWeight: '700', letterSpacing: 1 },
  miniTitle: { color: '#000000', fontSize: 12, fontWeight: '700', marginTop: 3 },
  miniFolder: { color: '#555555', fontSize: 10, marginTop: 2 },
  miniTitleViewport: { marginTop: 3 },
  miniArtistViewport: { marginTop: 2 },
  miniButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 42 },
  miniButtonText: { color: '#000000', fontSize: 15, fontWeight: '700' },
  artPlaceholder: { alignItems: 'center', backgroundColor: '#EEEEEE', justifyContent: 'center' },
  artPlaceholderText: { color: '#000000', fontSize: 22, fontWeight: '700', letterSpacing: -1 },
  artLoadingText: { color: '#444444', fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginTop: 10 },
  playerScreen: { flexGrow: 1, justifyContent: 'center', paddingBottom: 28, paddingTop: 18 },
  playerHeaderFolderViewport: { alignSelf: 'flex-start', flexShrink: 1, marginLeft: 12, marginTop: 8, maxWidth: 170, minWidth: 0, width: 170 },
  playerHeaderActions: { alignItems: 'flex-end' },
  playerHeaderButtons: { flexDirection: 'row', gap: 6 },
  playerHeaderFolderText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  playerArt: { alignItems: 'center', paddingTop: 18 },
  playerTitleRow: { alignItems: 'center', flexDirection: 'row', gap: 12, marginTop: 16 },
  playerTitleActions: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  playerTitle: { color: '#000000', fontSize: 23, fontWeight: '700', lineHeight: 29 },
  playerArtist: { color: '#555555', fontSize: 14, marginTop: 4 },
  playerTitleViewport: { flex: 1, minWidth: 0 },
  playerArtistViewport: { marginTop: 0 },
  metadataDetails: { flexDirection: 'row', gap: 14, marginTop: 4 },
  metadataAlbumViewport: { flex: 1, minWidth: 0 },
  metadataItem: { color: '#555555', flexShrink: 1, fontSize: 11 },
  lyricsButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 36, justifyContent: 'center', paddingHorizontal: 10 },
  lyricsButtonText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  lyricsModal: { backgroundColor: '#FFFFFF', flex: 1, paddingHorizontal: 20 },
  lyricsHeader: { alignItems: 'flex-end', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, paddingTop: 10 },
  lyricsTrack: { paddingTop: 20 },
  lyricsTitle: { color: '#000000', fontSize: 23, fontWeight: '700' },
  lyricsArtist: { color: '#555555', fontSize: 13, marginTop: 4 },
  lyricsContent: { paddingBottom: 36, paddingTop: 24 },
  lyricsMessage: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  lyricsMessageTitle: { color: '#000000', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  lyricsMessageText: { color: '#555555', fontSize: 13, lineHeight: 20, marginTop: 10, textAlign: 'center' },
  lyricsRetry: { borderColor: '#000000', borderWidth: 1, marginTop: 20, paddingHorizontal: 18, paddingVertical: 12 },
  lyricsRetryText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.7 },
  plainLyricLine: { color: '#222222', fontSize: 18, lineHeight: 29, marginBottom: 12 },
  syncedLyricRow: { paddingVertical: 9 },
  syncedLyricText: { color: '#999999', fontSize: 18, fontWeight: '600', lineHeight: 25 },
  activeSyncedLyricText: { color: '#000000', fontSize: 22, fontWeight: '700', lineHeight: 29 },
  progressTrack: { backgroundColor: '#DDDDDD', height: 8, marginTop: 16, overflow: 'hidden' },
  progressFill: { backgroundColor: '#000000', height: 8 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  timeText: { color: '#444444', fontSize: 11 },
  transportRow: { alignItems: 'center', flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 18, width: '100%' },
  iconButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 48, justifyContent: 'center', width: 48 },
  transportSideButton: { flex: 1, minWidth: 0, width: 'auto' },
  transportMainButton: { flex: 2.25, minWidth: 0, paddingHorizontal: 0 },
  activeIconButton: { backgroundColor: '#000000' },
  orderModeText: { color: '#000000', fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },
  iconFrame: { alignItems: 'center', height: 32, justifyContent: 'center', width: 32 },
  glyphText: { fontSize: 27, fontWeight: '400', includeFontPadding: false, lineHeight: 28, textAlign: 'center', width: 32 },
  smallIconFrame: { height: 18, width: 20 },
  repeatFrame: { alignItems: 'center', height: 32, justifyContent: 'center', width: 40 },
  repeatRing: { transform: [{ translateY: -3 }] },
  repeatOneNumber: { fontSize: 10, fontWeight: '700', includeFontPadding: false, left: 31, lineHeight: 11, position: 'absolute', top: 3 },
  glyphBar: { height: 2, position: 'absolute' },
  glyphArrowHead: { borderBottomColor: 'transparent', borderBottomWidth: 3, borderLeftWidth: 5, borderTopColor: 'transparent', borderTopWidth: 3, height: 0, left: 15, position: 'absolute', width: 0 },
  marqueeViewport: { overflow: 'hidden' },
  marqueeContent: { alignSelf: 'flex-start', flexDirection: 'row' },
  marqueeFade: { bottom: 0, position: 'absolute', top: 0, width: MARQUEE_FADE_WIDTH },
  marqueeFadeLeft: { left: 0 },
  marqueeFadeRight: { right: 0 },
  marqueeFadeGradient: { flex: 1 },
  marqueeMeasure: { left: 0, opacity: 0, position: 'absolute', top: 0, width: 10000 },
  marqueeText: { flexShrink: 0 },
  preferenceHeading: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1, marginTop: 24 },
  preferenceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
  modalBackdrop: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', flex: 1, justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: '#FFFFFF', borderColor: '#000000', borderWidth: 1, padding: 20, width: '100%' },
  modalTitle: { color: '#000000', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  modalDescription: { color: '#555555', fontSize: 13, marginBottom: 18 },
});
