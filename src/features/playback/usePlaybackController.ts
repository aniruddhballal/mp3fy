import { File } from 'expo-file-system';
import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AudioPlaylistStatus } from 'expo-audio';
import { activateLockScreen, updateLockScreen } from '../../services/mediaControls';
import { fallbackMetadata } from '../../services/trackMetadata';
import type { Folder, RepeatMode, SavedPlayback, Screen, Track, TrackMetadata } from '../../types/domain';
import type { ListeningTracker } from '../wrapped/wrappedTracker';
import { buildQueue, nextPlaybackMode, type PlaybackMode } from './playbackOrder';
import { moveUpcoming } from './queueOrder';

type PlaybackPlayer = {
  currentTime: number;
  currentIndex: number;
  playing: boolean;
  trackCount: number;
  loop: 'all' | 'single' | 'none';
  clear: () => void;
  add: (source: { uri: string }) => void;
  skipTo: (index: number) => void;
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  remove: (index: number) => void;
  insert: (source: { uri: string }, index: number) => void;
  seekTo: (seconds: number) => Promise<unknown>;
};

type UsePlaybackControllerOptions = {
  player: PlaybackPlayer;
  status: AudioPlaylistStatus;
  folders: Folder[];
  tracks: Track[];
  currentTrack: Track | null;
  queue: Track[];
  upcomingTracks: Track[];
  mode: PlaybackMode;
  repeatMode: RepeatMode;
  progressWidth: number;
  tracker: ListeningTracker;
  observePlayback: () => void;
  loadArtwork: (track: Track) => Promise<void>;
  savePlayback: (playback: SavedPlayback | null) => void;
  rememberShuffle: (folderUri: string, shuffledQueue: Track[]) => void;
  queueTitleFor: (track: Track) => string;
  pendingRestorePosition: MutableRefObject<number | null>;
  latestPlayback: MutableRefObject<SavedPlayback | null>;
  restoreTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  shuffleHistory: MutableRefObject<Map<string, string[]>>;
  lockScreenTrackUri: MutableRefObject<string | null>;
  setQueue: Dispatch<SetStateAction<Track[]>>;
  setQueueIndex: Dispatch<SetStateAction<number>>;
  setMode: Dispatch<SetStateAction<PlaybackMode>>;
  setRepeatMode: Dispatch<SetStateAction<RepeatMode>>;
  setCurrentTrack: Dispatch<SetStateAction<Track | null>>;
  setCurrentMetadata: Dispatch<SetStateAction<TrackMetadata | null>>;
  setCurrentArtwork: Dispatch<SetStateAction<string | null>>;
  setIsArtworkLoading: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setScreen: Dispatch<SetStateAction<Screen>>;
};

export function usePlaybackController({ player, status, folders, tracks, currentTrack, queue, upcomingTracks, mode, repeatMode, progressWidth, tracker, observePlayback, loadArtwork, savePlayback, rememberShuffle, queueTitleFor, pendingRestorePosition, latestPlayback, restoreTimer, shuffleHistory, lockScreenTrackUri, setQueue, setQueueIndex, setMode, setRepeatMode, setCurrentTrack, setCurrentMetadata, setCurrentArtwork, setIsArtworkLoading, setNotice, setScreen }: UsePlaybackControllerOptions) {
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
  }, [folders, loadArtwork, mode, observePlayback, player, repeatMode, savePlayback, setCurrentArtwork, setCurrentMetadata, setCurrentTrack, setIsArtworkLoading, setQueue, setQueueIndex, tracker]);

  const replaceQueueWithoutInterrupt = useCallback((nextQueue: Track[], nextIndex: number, nextMode = mode, nextRepeatMode = repeatMode) => {
    const activeNativeIndex = player.currentIndex;
    const activeQueueIndex = queue.findIndex((track) => track.uri === currentTrack?.uri);
    if (!currentTrack || activeNativeIndex < 0 || activeNativeIndex >= player.trackCount || activeQueueIndex < 0) return false;
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
  }, [currentTrack, mode, pendingRestorePosition, player, queue, repeatMode, savePlayback, setQueue, setQueueIndex]);

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
  }, [currentTrack?.uri, loadArtwork, player, queue, setCurrentArtwork, setCurrentMetadata, setCurrentTrack, setIsArtworkLoading, setQueueIndex, status.currentIndex]);

  useEffect(() => {
    player.loop = repeatMode === 'one' ? 'single' : 'all';
  }, [player, repeatMode]);

  const playTrack = useCallback((track: Track) => {
    const nextPlayback = buildQueue(tracks, track, 'folder');
    setMode('folder');
    startPlayback(nextPlayback.queue, nextPlayback.index, repeatMode, 'folder');
    setScreen({ kind: 'player', returnTo: 'songs' });
  }, [repeatMode, setMode, setScreen, startPlayback, tracks]);

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
      const selectedTrack: Track = { folderName: parentDirectory.name || 'Selected song', folderUri: parentDirectory.uri, name: selectedFile.name, uri: selectedFile.uri };
      setRepeatMode('one');
      startPlayback([selectedTrack], 0, 'one');
      setScreen({ kind: 'player', returnTo: 'folders' });
      setNotice(`${selectedFile.name} selected.`);
    } catch {
      setNotice('Song selection was cancelled or unavailable.');
    }
  }, [setNotice, setRepeatMode, setScreen, startPlayback]);

  const playNext = useCallback(() => {
    if (!queue.length) return;
    observePlayback();
    tracker.restart();
    void tracker.flush().catch(() => undefined);
    pendingRestorePosition.current = null;
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    player.next();
  }, [observePlayback, pendingRestorePosition, player, queue.length, restoreTimer, tracker]);

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
  }, [observePlayback, pendingRestorePosition, player, queue.length, restoreTimer, status.currentTime, tracker]);

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
  }, [currentTrack, queueTitleFor, rememberShuffle, replaceQueueWithoutInterrupt, setMode, shuffleHistory, tracks]);

  const reorderUpcoming = useCallback((from: number, to: number) => {
    if (!currentTrack || from < 0 || to < 0 || from >= upcomingTracks.length || to >= upcomingTracks.length) return;
    replaceQueueWithoutInterrupt([currentTrack, ...moveUpcoming(upcomingTracks, from, to)], 0);
  }, [currentTrack, replaceQueueWithoutInterrupt, upcomingTracks]);

  const removeUpcoming = useCallback((uri: string) => {
    if (!currentTrack || !upcomingTracks.some((track) => track.uri === uri)) return;
    const nextUpcoming = upcomingTracks.filter((track) => track.uri !== uri);
    const nextRepeatMode = nextUpcoming.length ? repeatMode : 'one';
    if (replaceQueueWithoutInterrupt([currentTrack, ...nextUpcoming], 0, mode, nextRepeatMode) && !nextUpcoming.length) setRepeatMode('one');
  }, [currentTrack, mode, repeatMode, replaceQueueWithoutInterrupt, setRepeatMode, upcomingTracks]);

  const clearUpcoming = useCallback(() => {
    if (!currentTrack || !upcomingTracks.length) return;
    if (replaceQueueWithoutInterrupt([currentTrack], 0, mode, 'one')) setRepeatMode('one');
  }, [currentTrack, mode, replaceQueueWithoutInterrupt, setRepeatMode, upcomingTracks.length]);

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
  }, [latestPlayback, observePlayback, pendingRestorePosition, player, restoreTimer, savePlayback, status.playing, tracker]);

  const seek = useCallback((event: { nativeEvent: { locationX: number } }) => {
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
  }, [latestPlayback, observePlayback, pendingRestorePosition, player, progressWidth, restoreTimer, savePlayback, status.duration, tracker]);

  const displayedStatus = pendingRestorePosition.current === null ? status : { ...status, currentTime: pendingRestorePosition.current };
  const progress = displayedStatus.duration ? Math.min(1, displayedStatus.currentTime / displayedStatus.duration) : 0;

  return { startPlayback, playTrack, addSong, playNext, playPrevious, updateQueuePreference, reorderUpcoming, removeUpcoming, clearUpcoming, togglePlayback, seek, displayedStatus, progress };
}
