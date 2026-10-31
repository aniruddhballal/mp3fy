import { Directory, File } from 'expo-file-system';
import type { Folder, Track } from '../types/domain';

const FOLDER_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const SCAN_YIELD_INTERVAL = 32;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function collectTracks(rootDirectory: Directory, folder: Folder, tracks: Track[], rootItems?: (Directory | File)[]) {
  const pendingDirectories = [rootDirectory];
  let processedItems = 0;
  while (pendingDirectories.length) {
    await yieldToEventLoop();
    const directory = pendingDirectories.pop() as Directory;
    const items = directory === rootDirectory && rootItems ? rootItems : directory.list();
    for (const item of items) {
      if (item instanceof Directory) pendingDirectories.push(item);
      else if (item instanceof File && item.name.toLowerCase().endsWith('.mp3')) {
        tracks.push({ folderName: folder.name, folderUri: folder.uri, name: item.name, uri: item.uri });
      }
      processedItems += 1;
      if (processedItems % SCAN_YIELD_INTERVAL === 0) await yieldToEventLoop();
    }
  }
}

function isFolderImage(file: File) {
  const name = file.name.toLowerCase();
  return FOLDER_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function folderImagePriority(file: File) {
  const name = file.name.toLowerCase();
  if (name.startsWith('folder.')) return 0;
  if (name.startsWith('cover.')) return 1;
  if (name.startsWith('artwork.')) return 2;
  if (name.startsWith('albumart.') || name.startsWith('album-art.')) return 3;
  if (name.startsWith('thumbnail.')) return 4;
  if (name.startsWith('image.')) return 5;
  return 10;
}

export async function scanFolder(folder: Folder): Promise<{ folder: Folder; tracks: Track[] }> {
  try {
    await yieldToEventLoop();
    const directory = new Directory(folder.uri);
    const items = directory.list();
    const image = items
      .filter((item): item is File => item instanceof File && isFolderImage(item))
      .sort((a, b) => folderImagePriority(a) - folderImagePriority(b) || a.name.localeCompare(b.name))[0];
    const tracks: Track[] = [];
    await collectTracks(directory, folder, tracks, items);
    return { folder: { ...folder, imageUri: image?.uri ?? null }, tracks };
  } catch {
    return { folder: { ...folder, imageUri: null }, tracks: [] };
  }
}

export async function scanFolders(folders: Folder[]): Promise<{ folders: Folder[]; tracks: Track[] }> {
  const results: { folder: Folder; tracks: Track[] }[] = [];
  const tracks: Track[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const result = await scanFolder(folder);
    results.push(result);
    result.tracks.forEach((track) => {
      if (!seen.has(track.uri)) {
        seen.add(track.uri);
        tracks.push(track);
      }
    });
  }
  tracks.sort((a, b) => `${a.folderName}/${a.name}`.localeCompare(`${b.folderName}/${b.name}`));
  return { folders: results.map((result) => result.folder), tracks };
}
