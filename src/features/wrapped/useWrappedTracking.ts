import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { initializeWrappedBackup, noteWrappedHistoryChanged } from './wrappedBackup';
import { initializeWrappedStore, recordListening } from './wrappedStore';
import { ListeningTracker } from './wrappedTracker';
import { fallbackMetadata } from '../../services/trackMetadata';
import type { Track, TrackMetadata } from '../../types/domain';

type PlaybackObservationSource = {
  currentTime: number;
  playing: boolean;
  isBuffering: boolean;
  duration: number;
  currentIndex: number;
};

type UseWrappedTrackingOptions = {
  player: PlaybackObservationSource;
  queue: Track[];
  currentTrack: Track | null;
  currentMetadataRef: MutableRefObject<TrackMetadata | null>;
  metadataCache: ReadonlyMap<string, TrackMetadata>;
  onHistoryChanged: () => void;
};

export function useWrappedTracking({ player, queue, currentTrack, currentMetadataRef, metadataCache, onHistoryChanged }: UseWrappedTrackingOptions) {
  const trackerRef = useRef<ListeningTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = new ListeningTracker(async (entries) => {
      await recordListening(entries);
      noteWrappedHistoryChanged();
      onHistoryChanged();
    });
  }
  const tracker = trackerRef.current;

  const observePlayback = useCallback((currentTime = player.currentTime, playing = player.playing, buffering = player.isBuffering, duration = player.duration, index = player.currentIndex) => {
    const track = queue[index] ?? currentTrack;
    const metadata = track?.uri === currentTrack?.uri ? currentMetadataRef.current : track ? metadataCache.get(track.uri) : null;
    tracker.observe({
      track: track ? { uri: track.uri, fileName: track.name, title: metadata?.title || fallbackMetadata(track).title, artist: metadata?.artist || fallbackMetadata(track).artist } : null,
      positionSeconds: currentTime,
      durationSeconds: duration,
      playing,
      buffering,
      atMs: Date.now(),
    });
  }, [currentMetadataRef, currentTrack, metadataCache, player, queue, tracker]);

  useEffect(() => {
    void initializeWrappedStore().catch(() => undefined);
    void initializeWrappedBackup().catch(() => undefined);
    const timer = setInterval(() => { void tracker.flush().catch(() => undefined); }, 5000);
    return () => {
      clearInterval(timer);
      void tracker.flush().catch(() => undefined);
    };
  }, [tracker]);

  return { tracker, observePlayback };
}
