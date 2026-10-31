import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAudioPlaylist, useAudioPlaylistStatus } from 'expo-audio';
import { useFonts } from 'expo-font';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar as SystemStatusBar } from 'react-native';
import { initializeWrappedStore } from './features/wrapped/wrappedStore';
import { chooseWrappedBackupFolder, initializeWrappedBackup, saveWrappedBackupNow } from './features/wrapped/wrappedBackup';
import { useWrappedTracking } from './features/wrapped/useWrappedTracking';
import { WrappedScreen } from './screens/WrappedScreen';
import { QueueScreen, type QueueRow } from './screens/QueueScreen';
import { FoldersScreen, MiniPlayer, SongsScreen } from './screens/LibraryScreens';
import { FolderDialogs } from './components/FolderDialogs';
import { upcomingFrom } from './features/playback/queueOrder';
import { type PlaybackMode } from './features/playback/playbackOrder';
import { APP_VERSION } from './config/appVersion';
import type { Folder, RepeatMode, SavedPlayback, Track, TrackMetadata } from './types/domain';
import { fallbackMetadata } from './services/trackMetadata';
import { activateLockScreen, deactivateLockScreen, updateLockScreen } from './services/mediaControls';
import { styles } from './styles/appStyles';
import { PlayerScreen } from './components/player/PlayerScreen';
import { useScreenNavigation } from './hooks/useScreenNavigation';
import { FOLDERS_KEY, LIBRARY_KEY, useLibraryState } from './features/library/useLibraryState';
import { PLAYBACK_KEY, SHUFFLE_HISTORY_KEY, usePlaybackPersistence } from './features/playback/usePlaybackPersistence';
import { usePlaybackController } from './features/playback/usePlaybackController';
import { useTrackArtwork } from './features/playback/useTrackArtwork';
import { useAppStartup } from './features/app/useAppStartup';

const PLAYBACK_STATUS_UPDATE_INTERVAL_MS = 250;

export default function App() {
  return <SafeAreaProvider><Mp3fyApp /></SafeAreaProvider>;
}

function Mp3fyApp() {
  const [iconsLoaded] = useFonts({ ...MaterialCommunityIcons.font });
  const player = useAudioPlaylist({ sources: [], updateInterval: PLAYBACK_STATUS_UPDATE_INTERVAL_MS, loop: 'all' });
  const status = useAudioPlaylistStatus(player);
  const artworkCache = useRef(new Map<string, string | null>()).current;
  const metadataCache = useRef(new Map<string, TrackMetadata>()).current;
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [mode, setMode] = useState<PlaybackMode>('folder');
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all');
  const [progressWidth, setProgressWidth] = useState(0);
  const [folderActions, setFolderActions] = useState<Folder | null>(null);
  const [folderToConfirm, setFolderToConfirm] = useState<Folder | null>(null);
  const [isLibraryReady, setIsLibraryReady] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isWrappedBackupReady, setIsWrappedBackupReady] = useState(false);
  const [isBackupSetupBusy, setIsBackupSetupBusy] = useState(true);
  const [backupSetupMessage, setBackupSetupMessage] = useState('');
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [wrappedRevision, setWrappedRevision] = useState(0);
  const { folders, setFolders, tracks, setTracks, isScanning, notice, setNotice, scanningFolderUris, rescan, addFolder, libraryRevision } = useLibraryState({ isInitialized });
  const { pendingRestorePosition, latestPlayback, lastSavedPlayback, restoreTimer, shuffleHistory, savePlayback, rememberShuffle } = usePlaybackPersistence({ player, status, isInitialized, currentTrack, folders, queue, mode, repeatMode });
  const lockScreenTrackUri = useRef<string | null>(null);
  const currentMetadataRef = useRef<TrackMetadata | null>(null);
  const { tracker, observePlayback } = useWrappedTracking({
    player,
    queue,
    currentTrack,
    currentMetadataRef,
    metadataCache,
    onHistoryChanged: () => setWrappedRevision((revision) => revision + 1),
  });
  const { currentMetadata, setCurrentMetadata, currentArtwork, setCurrentArtwork, isArtworkLoading, setIsArtworkLoading, loadArtwork } = useTrackArtwork({ player, tracker, artworkCache, metadataCache });
  currentMetadataRef.current = currentMetadata;

  const selectWrappedBackupFolder = useCallback(async () => {
    setIsBackupSetupBusy(true);
    setBackupSetupMessage('');
    try {
      const selected = await chooseWrappedBackupFolder();
      if (selected) {
        setIsWrappedBackupReady(true);
        return;
      }
      setBackupSetupMessage('A backup folder is required to continue.');
    } catch {
      setBackupSetupMessage('That folder does not contain a valid mp3fy Wrapped backup, or it is unavailable.');
    } finally {
      setIsBackupSetupBusy(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const setup = async () => {
      try {
        await initializeWrappedStore();
        if (await initializeWrappedBackup()) {
          if (mounted) {
            setIsWrappedBackupReady(true);
            setIsBackupSetupBusy(false);
          }
          return;
        }
      } catch {
        // A fresh folder selection below can recover from a stale permission.
      }
      if (mounted) await selectWrappedBackupFolder();
    };
    void setup();
    return () => { mounted = false; };
  }, [selectWrappedBackupFolder]);

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


  useAppStartup({
    player,
    shuffleHistory,
    pendingRestorePosition,
    latestPlayback,
    lastSavedPlayback,
    restoreTimer,
    rescan,
    rememberShuffle,
    savePlayback,
    loadArtwork,
    setFolders,
    setTracks,
    setQueue,
    setQueueIndex,
    setMode,
    setRepeatMode,
    setCurrentTrack,
    setCurrentMetadata,
    setCurrentArtwork,
    setIsArtworkLoading,
    setNotice,
    setIsLibraryReady,
    setIsInitialized,
    setNotificationsGranted,
  });

  const { playTrack, addSong, playNext, playPrevious, updateQueuePreference, reorderUpcoming, removeUpcoming, clearUpcoming, togglePlayback, seek, displayedStatus, progress } = usePlaybackController({
    player,
    status,
    folders,
    tracks,
    currentTrack,
    queue,
    upcomingTracks,
    mode,
    repeatMode,
    progressWidth,
    tracker,
    observePlayback,
    loadArtwork,
    savePlayback,
    rememberShuffle,
    queueTitleFor,
    pendingRestorePosition,
    latestPlayback,
    restoreTimer,
    shuffleHistory,
    lockScreenTrackUri,
    setQueue,
    setQueueIndex,
    setMode,
    setRepeatMode,
    setCurrentTrack,
    setCurrentMetadata,
    setCurrentArtwork,
    setIsArtworkLoading,
    setNotice,
    setScreen,
  });

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

  if (!iconsLoaded || !isLibraryReady || !isWrappedBackupReady) {
    return (
      <>
        <SystemStatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent={false} />
        <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
          <View style={styles.container}>
            <View style={styles.startupLoading}>
              {!iconsLoaded || !isLibraryReady || isBackupSetupBusy ? <ActivityIndicator color="#000000" /> : null}
              <Text style={styles.title}>{!iconsLoaded ? 'Loading interface...' : isLibraryReady ? 'Choose a Wrapped backup folder' : 'Loading library...'}</Text>
              {iconsLoaded && isLibraryReady ? <Text style={styles.description}>mp3fy keeps one required Wrapped backup file in this folder. Select the same folder after reinstalling to restore your listening history.</Text> : null}
              {iconsLoaded && isLibraryReady && !isBackupSetupBusy ? <Pressable accessibilityRole="button" onPress={() => { void selectWrappedBackupFolder(); }} style={styles.button}><Text style={styles.buttonText}>SELECT BACKUP FOLDER</Text></Pressable> : null}
              {backupSetupMessage ? <Text style={styles.notice}>{backupSetupMessage}</Text> : null}
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
            <WrappedScreen revision={wrappedRevision} onBack={closeWrapped} />
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

