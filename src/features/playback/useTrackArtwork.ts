import { useCallback, useRef, useState } from 'react';
import { updateTrackDetails } from '../wrapped/wrappedStore';
import type { ListeningTracker } from '../wrapped/wrappedTracker';
import { updateLockScreen } from '../../services/mediaControls';
import { fallbackMetadata, loadEmbeddedTrackDetails, materializeArtwork, rememberCacheValue } from '../../services/trackMetadata';
import type { Track, TrackMetadata } from '../../types/domain';

const MAX_MEMORY_ARTWORK_ENTRIES = 32;
const MAX_MEMORY_METADATA_ENTRIES = 128;

type UseTrackArtworkOptions = {
  player: object;
  tracker: ListeningTracker;
  artworkCache: Map<string, string | null>;
  metadataCache: Map<string, TrackMetadata>;
};

export function useTrackArtwork({ player, tracker, artworkCache, metadataCache }: UseTrackArtworkOptions) {
  const artworkRequest = useRef(0);
  const [currentMetadata, setCurrentMetadata] = useState<TrackMetadata | null>(null);
  const [currentArtwork, setCurrentArtwork] = useState<string | null>(null);
  const [isArtworkLoading, setIsArtworkLoading] = useState(false);

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

  return { currentMetadata, setCurrentMetadata, currentArtwork, setCurrentArtwork, isArtworkLoading, setIsArtworkLoading, loadArtwork };
}
