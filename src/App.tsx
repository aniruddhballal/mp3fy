import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestNotificationPermissionsAsync, setAudioModeAsync, useAudioPlaylist, useAudioPlaylistStatus } from 'expo-audio';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar as SystemStatusBar } from 'react-native';
import { initializeWrappedStore, restoreWrappedBackup, updateTrackDetails } from './features/wrapped/wrappedStore';
import { noteWrappedHistoryChanged, saveWrappedBackupNow } from './features/wrapped/wrappedBackup';
import { useWrappedTracking } from './features/wrapped/useWrappedTracking';
import { WrappedScreen } from './screens/WrappedScreen';
import { QueueScreen, type QueueRow } from './screens/QueueScreen';
import { FoldersScreen, MiniPlayer, SongsScreen } from './screens/LibraryScreens';
import { FolderDialogs } from './components/FolderDialogs';
import { moveUpcoming, upcomingFrom } from './features/playback/queueOrder';
import { buildQueue, restorePlaybackMode, type PlaybackMode } from './features/playback/playbackOrder';
import { APP_VERSION } from './config/appVersion';
import type { Folder, RepeatMode, SavedPlayback, Track, TrackMetadata } from './types/domain';
import { isFolder, isLibrarySnapshot, isSavedPlayback } from './services/libraryValidation';
import { fallbackMetadata, loadEmbeddedTrackDetails, materializeArtwork, pruneArtworkCache, rememberCacheValue } from './services/trackMetadata';
import { activateLockScreen, deactivateLockScreen, updateLockScreen } from './services/mediaControls';
import { styles } from './styles/appStyles';
import { PlayerScreen } from './components/player/PlayerScreen';
import { useScreenNavigation } from './hooks/useScreenNavigation';
import { FOLDERS_KEY, LIBRARY_KEY, useLibraryState } from './features/library/useLibraryState';

const PLAYBACK_KEY = 'mp3fy.playback.v1';
const SHUFFLE_HISTORY_KEY = 'mp3fy.shuffleHistory.v1';
const PLAYBACK_STATUS_UPDATE_INTERVAL_MS = 250;
const MAX_MEMORY_ARTWORK_ENTRIES = 32;
const MAX_MEMORY_METADATA_ENTRIES = 128;

export default function App() {
  return <SafeAreaProvider><Mp3fyApp /></SafeAreaProvider>;
}

function Mp3fyApp() {
  const player = useAudioPlaylist({ sources: [], updateInterval: PLAYBACK_STATUS_UPDATE_INTERVAL_MS, loop: 'all' });
  const status = useAudioPlaylistStatus(player);
  const artworkCache = useRef(new Map<string, string | null>()).current;
  const metadataCache = useRef(new Map<string, TrackMetadata>()).current;
  const artworkRequest = useRef(0);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [currentMetadata, setCurrentMetadata] = useState<TrackMetadata | null>(null);
  const [currentArtwork, setCurrentArtwork] = useState<string | null>(null);
  const [isArtworkLoading, setIsArtworkLoading] = useState(false);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [mode, setMode] = useState<PlaybackMode>('folder');
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all');
  const [progressWidth, setProgressWidth] = useState(0);
  const [folderActions, setFolderActions] = useState<Folder | null>(null);
  const [folderToConfirm, setFolderToConfirm] = useState<Folder | null>(null);
  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [wrappedRevision, setWrappedRevision] = useState(0);
  const { folders, setFolders, tracks, setTracks, isScanning, notice, setNotice, scanningFolderUris, rescan, addFolder, libraryRevision, libraryRefreshTimer } = useLibraryState({ isInitialized });
  const lockScreenTrackUri = useRef<string | null>(null);
  const pendingRestorePosition = useRef<number | null>(null);
  const latestPlayback = useRef<SavedPlayback | null>(null);
  const lastSavedPlayback = useRef<string | null>(null);
  const storageWrite = useRef<Promise<void>>(Promise.resolve());
  const shuffleHistory = useRef(new Map<string, string[]>());
  const shuffleHistoryWrite = useRef<Promise<void>>(Promise.resolve());
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { tracker, observePlayback } = useWrappedTracking({
    player,
    queue,
    currentTrack,
    currentMetadata,
    metadataCache,
    onHistoryChanged: () => setWrappedRevision((revision) => revision + 1),
  });

  const { screen, setScreen, openFolder, openPlayerFromMini, openQueue, closeQueue, openWrapped, closeWrapped } = useScreenNavigation({
    currentTrack,
    folders,
    folderActions,
    folderToConfirm,
    observePlayback,
    flushListening: () => tracker.flush(),
    onCloseFolderActions: () => setFolderActions(null),
    onCloseFolderConfirmation: () => setFolderToConfirm(null),
  });

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
      if (currentTrack && nextState !== 'unknown' && lockScreenTrackUri.current === null) {
        const metadata = currentMetadata ?? fallbackMetadata(currentTrack);
        lockScreenTrackUri.current = currentTrack.uri;
        activateLockScreen(player, { title: metadata.title, artist: metadata.artist || 'mp3fy', albumTitle: metadata.album || undefined, artworkUrl: artworkCache.get(currentTrack.uri) ?? undefined });
      }
    });
    return () => subscription.remove();
  }, [artworkCache, currentMetadata, currentTrack, notificationsGranted, observePlayback, player, savePlayback, tracker]);

  useEffect(() => {
    if (!currentTrack) return;
    const metadata = currentMetadata ?? fallbackMetadata(currentTrack);
    if (lockScreenTrackUri.current === null) {
      lockScreenTrackUri.current = currentTrack.uri;
      activateLockScreen(player, { title: metadata.title, artist: metadata.artist || 'mp3fy', albumTitle: metadata.album || undefined, artworkUrl: artworkCache.get(currentTrack.uri) ?? undefined });
    } else if (lockScreenTrackUri.current !== currentTrack.uri) {
      lockScreenTrackUri.current = currentTrack.uri;
      updateLockScreen(player, { title: metadata.title, artist: metadata.artist || 'mp3fy', albumTitle: metadata.album || undefined, artworkUrl: artworkCache.get(currentTrack.uri) ?? undefined });
    }
  }, [artworkCache, currentMetadata, currentTrack?.uri, player]);


  const loadArtwork = useCallback(async (track: Track) => {
    const request = ++artworkRequest.current;
    setIsArtworkLoading(true);
    const applyArtwork = (mediaArtwork: string | null, metadata: TrackMetadata) => {
      if (request !== artworkRequest.current) return;
      setCurrentMetadata(metadata);
      setCurrentArtwork(mediaArtwork);
      setIsArtworkLoading(false);
      updateLockScreen(player, { title: metadata.title, artist: metadata.artist || 'mp3fy', albumTitle: metadata.album || undefined, artworkUrl: mediaArtwork ?? undefined });
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
    requestNotificationPermissionsAsync().then(({ granted }) => setNotificationsGranted(granted)).catch(() => undefined);
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
    lockScreenTrackUri.current = nextTrack.uri;
    activateLockScreen(player, { title: nextMetadata.title, artist: nextMetadata.artist || 'mp3fy', albumTitle: nextMetadata.album || undefined });
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
    updateLockScreen(player, { title: nextMetadata.title, artist: nextMetadata.artist || 'mp3fy', albumTitle: nextMetadata.album || undefined });
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
        lockScreenTrackUri.current = null;
        deactivateLockScreen(player);
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

      <FolderDialogs
        folderActions={folderActions}
        folderToConfirm={folderToConfirm}
        onCloseActions={() => setFolderActions(null)}
        onOpenFolder={openFolder}
        onRequestRemove={setFolderToConfirm}
        onRemoveFolder={removeFolder}
        onCloseConfirmation={() => setFolderToConfirm(null)}
      />
    </>
  );
}

