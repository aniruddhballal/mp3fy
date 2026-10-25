import type { PlaybackMode } from '../features/playback/playbackOrder';

export type Folder = { name: string; uri: string; imageUri?: string | null };
export type Track = { folderName: string; folderUri: string; name: string; uri: string };
export type LibrarySnapshot = { folders: Folder[]; tracks: Track[] };
export type TrackMetadata = { title: string; artist: string; album: string; trackNumber: string };
export type RepeatMode = 'all' | 'one';
export type SavedPlayback = {
  track: Track;
  queueUris: string[];
  currentTime: number;
  mode: PlaybackMode | 'sequential';
  repeatMode: RepeatMode;
  standalone: boolean;
};

export type Screen =
  | { kind: 'folders' }
  | { kind: 'songs'; folderUri: string }
  | { kind: 'player'; returnTo: 'folders' | 'songs' }
  | { kind: 'queue'; returnTo: 'folders' | 'songs' | 'player'; folderUri?: string; playerReturnTo?: 'folders' | 'songs' }
  | { kind: 'wrapped'; returnTo: 'folders' | 'songs' | 'player'; folderUri?: string; playerReturnTo?: 'folders' | 'songs' };
