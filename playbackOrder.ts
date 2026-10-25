export type PlaybackMode = 'folder' | 'title' | 'shuffle';

type OrderedTrack = { uri: string; folderUri: string; name: string };

export function nextPlaybackMode(mode: PlaybackMode): PlaybackMode {
  return mode === 'folder' ? 'title' : mode === 'title' ? 'shuffle' : 'folder';
}

export function restorePlaybackMode(mode: PlaybackMode | 'sequential'): PlaybackMode {
  return mode === 'sequential' ? 'title' : mode;
}

export function titleAndArtistFromFilename(name: string): { title: string; artist: string } {
  const baseName = name.replace(/\.mp3$/i, '').trim();
  const separator = baseName.indexOf(' - ');
  if (separator > 0) return { title: baseName.slice(separator + 3).trim() || baseName, artist: baseName.slice(0, separator).trim() };
  return { title: baseName, artist: '' };
}

export function buildQueue<T extends OrderedTrack>(tracks: readonly T[], selectedTrack: T, mode: PlaybackMode, previousShuffleUris: readonly string[] = [], random = Math.random, titleFor = (track: T) => titleAndArtistFromFilename(track.name).title): { queue: T[]; index: number } {
  const scopedTracks = tracks.filter((track) => track.folderUri === selectedTrack.folderUri);
  if (!scopedTracks.some((track) => track.uri === selectedTrack.uri)) scopedTracks.push(selectedTrack);
  if (mode === 'shuffle') {
    const remaining = scopedTracks.filter((track) => track.uri !== selectedTrack.uri);
    for (let index = remaining.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [remaining[index], remaining[swapIndex]] = [remaining[swapIndex], remaining[index]];
    }
    const previousIndex = previousShuffleUris.indexOf(selectedTrack.uri);
    const previousUpcoming = previousIndex < 0 ? [] : [...previousShuffleUris.slice(previousIndex + 1), ...previousShuffleUris.slice(0, previousIndex)];
    if (remaining.length > 1 && remaining.every((track, index) => track.uri === previousUpcoming[index])) {
      [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
    }
    return { queue: [selectedTrack, ...remaining], index: 0 };
  }
  const queue = scopedTracks.sort((a, b) => mode === 'folder'
    ? a.name.localeCompare(b.name)
    : titleFor(a).localeCompare(titleFor(b)) || a.name.localeCompare(b.name));
  return { queue, index: Math.max(0, queue.findIndex((track) => track.uri === selectedTrack.uri)) };
}
