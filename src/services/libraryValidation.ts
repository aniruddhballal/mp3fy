import type { Folder, LibrarySnapshot, SavedPlayback } from '../types/domain';

export function isSavedPlayback(value: unknown): value is SavedPlayback {
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

export function isFolder(value: unknown): value is Folder {
  if (!value || typeof value !== 'object') return false;
  const folder = value as Partial<Folder>;
  return typeof folder.name === 'string' && typeof folder.uri === 'string'
    && (folder.imageUri === undefined || folder.imageUri === null || typeof folder.imageUri === 'string');
}

export function isLibrarySnapshot(value: unknown, selectedFolders: Folder[]): value is LibrarySnapshot {
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
