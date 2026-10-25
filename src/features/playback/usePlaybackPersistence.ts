import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef } from 'react';
import type { SavedPlayback, Track } from '../../types/domain';
import type { PlaybackMode } from './playbackOrder';

export const PLAYBACK_KEY = 'mp3fy.playback.v1';
export const SHUFFLE_HISTORY_KEY = 'mp3fy.shuffleHistory.v1';

type PlaybackPlayerSnapshot = {
  currentIndex: number;
  currentTime: number;
};

type PlaybackStatusSnapshot = {
  currentIndex: number;
  currentTime: number;
};

type UsePlaybackPersistenceOptions = {
  player: PlaybackPlayerSnapshot;
  status: PlaybackStatusSnapshot;
  isInitialized: boolean;
  currentTrack: Track | null;
  folders: Track[] | { uri: string }[];
  queue: Track[];
  mode: PlaybackMode;
  repeatMode: 'all' | 'one';
};

export function usePlaybackPersistence({ player, status, isInitialized, currentTrack, folders, queue, mode, repeatMode }: UsePlaybackPersistenceOptions) {
  const pendingRestorePosition = useRef<number | null>(null);
  const latestPlayback = useRef<SavedPlayback | null>(null);
  const lastSavedPlayback = useRef<string | null>(null);
  const storageWrite = useRef<Promise<void>>(Promise.resolve());
  const shuffleHistory = useRef(new Map<string, string[]>());
  const shuffleHistoryWrite = useRef<Promise<void>>(Promise.resolve());
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return { pendingRestorePosition, latestPlayback, lastSavedPlayback, restoreTimer, shuffleHistory, savePlayback, rememberShuffle };
}
