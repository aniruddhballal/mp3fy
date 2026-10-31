import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestNotificationPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { File } from 'expo-file-system';
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { buildQueue, restorePlaybackMode, type PlaybackMode } from '../playback/playbackOrder';
import { fallbackMetadata, pruneArtworkCache } from '../../services/trackMetadata';
import { isFolder, isLibrarySnapshot, isSavedPlayback } from '../../services/libraryValidation';
import type { Folder, RepeatMode, SavedPlayback, Track, TrackMetadata } from '../../types/domain';
import { FOLDERS_KEY, LIBRARY_KEY } from '../library/useLibraryState';
import { PLAYBACK_KEY, SHUFFLE_HISTORY_KEY } from '../playback/usePlaybackPersistence';

type StartupPlayer = {
  currentTime: number;
  clear: () => void;
  add: (source: { uri: string }) => void;
  loop: 'all' | 'single' | 'none';
  skipTo: (index: number) => void;
  seekTo: (seconds: number) => Promise<unknown>;
};

type UseAppStartupOptions = {
  player: StartupPlayer;
  shuffleHistory: MutableRefObject<Map<string, string[]>>;
  pendingRestorePosition: MutableRefObject<number | null>;
  latestPlayback: MutableRefObject<SavedPlayback | null>;
  lastSavedPlayback: MutableRefObject<string | null>;
  restoreTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  rescan: (folders: Folder[]) => Promise<Track[]>;
  rememberShuffle: (folderUri: string, queue: Track[]) => void;
  savePlayback: (playback: SavedPlayback | null) => void;
  loadArtwork: (track: Track) => Promise<void>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setTracks: Dispatch<SetStateAction<Track[]>>;
  setQueue: Dispatch<SetStateAction<Track[]>>;
  setQueueIndex: Dispatch<SetStateAction<number>>;
  setMode: Dispatch<SetStateAction<PlaybackMode>>;
  setRepeatMode: Dispatch<SetStateAction<RepeatMode>>;
  setCurrentTrack: Dispatch<SetStateAction<Track | null>>;
  setCurrentMetadata: Dispatch<SetStateAction<TrackMetadata | null>>;
  setCurrentArtwork: Dispatch<SetStateAction<string | null>>;
  setIsArtworkLoading: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setIsLibraryReady: Dispatch<SetStateAction<boolean>>;
  setIsInitialized: Dispatch<SetStateAction<boolean>>;
  setNotificationsGranted: Dispatch<SetStateAction<boolean>>;
};

export function useAppStartup({ player, shuffleHistory, pendingRestorePosition, latestPlayback, lastSavedPlayback, restoreTimer, rescan, rememberShuffle, savePlayback, loadArtwork, setFolders, setTracks, setQueue, setQueueIndex, setMode, setRepeatMode, setCurrentTrack, setCurrentMetadata, setCurrentArtwork, setIsArtworkLoading, setNotice, setIsLibraryReady, setIsInitialized, setNotificationsGranted }: UseAppStartupOptions) {
  useEffect(() => {
    let mounted = true;
    setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: true }).catch(() => undefined);
    requestNotificationPermissionsAsync().then(({ granted }) => setNotificationsGranted(granted)).catch(() => undefined);
    pruneArtworkCache();
    const restore = async () => {
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
              libraryTracks = await rescan(savedFolders);
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
        }
      }
    };
    void restore();
    return () => {
      mounted = false;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
    };
  }, [lastSavedPlayback, latestPlayback, loadArtwork, pendingRestorePosition, player, rememberShuffle, rescan, restoreTimer, savePlayback, setCurrentArtwork, setCurrentMetadata, setCurrentTrack, setFolders, setIsArtworkLoading, setIsInitialized, setIsLibraryReady, setMode, setNotice, setNotificationsGranted, setQueue, setQueueIndex, setRepeatMode, setTracks, shuffleHistory]);
}
