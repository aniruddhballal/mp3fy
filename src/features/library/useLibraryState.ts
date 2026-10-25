import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { scanFolder, scanFolders } from '../../services/libraryScanner';
import type { Folder, LibrarySnapshot, Track } from '../../types/domain';

export const FOLDERS_KEY = 'mp3fy.selectedFolders.v1';
export const LIBRARY_KEY = 'mp3fy.library.v1';

type UseLibraryStateOptions = {
  isInitialized: boolean;
};

export function useLibraryState({ isInitialized }: UseLibraryStateOptions) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [notice, setNotice] = useState('Select a folder to begin.');
  const [scanningFolderUris, setScanningFolderUris] = useState<Set<string>>(new Set());
  const libraryStorageWrite = useRef<Promise<void>>(Promise.resolve());
  const libraryRevision = useRef(0);
  const libraryRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isInitialized) return;
    const serialized = JSON.stringify({ folders, tracks } satisfies LibrarySnapshot);
    libraryStorageWrite.current = libraryStorageWrite.current.catch(() => undefined)
      .then(() => AsyncStorage.setItem(LIBRARY_KEY, serialized));
  }, [folders, isInitialized, tracks]);

  const rescan = useCallback(async (nextFolders: Folder[]) => {
    const revision = libraryRevision.current;
    setIsScanning(true);
    const scanResult = await scanFolders(nextFolders);
    if (revision === libraryRevision.current) {
      setFolders(scanResult.folders);
      setTracks(scanResult.tracks);
      setNotice(scanResult.tracks.length ? `${scanResult.tracks.length} MP3 file${scanResult.tracks.length === 1 ? '' : 's'} found.` : 'No MP3 files found in the selected folders.');
    }
    setIsScanning(false);
    return scanResult.tracks;
  }, []);

  const addFolder = useCallback(async () => {
    setNotice('Selecting a folder.');
    let scanningUri: string | null = null;
    try {
      const selectedDirectory = await Directory.pickDirectoryAsync();
      const nextFolder: Folder = { name: selectedDirectory.name, uri: selectedDirectory.uri };
      if (folders.some((folder) => folder.uri === nextFolder.uri)) {
        setNotice('That folder is already selected.');
        return;
      }
      const nextFolders = [...folders, nextFolder];
      await AsyncStorage.setItem(FOLDERS_KEY, JSON.stringify(nextFolders));
      libraryRevision.current += 1;
      scanningUri = nextFolder.uri;
      setFolders((existing) => [...existing, nextFolder]);
      setScanningFolderUris((existing) => new Set(existing).add(nextFolder.uri));
      const scanResult = await scanFolder(nextFolder);
      setFolders((existing) => existing.map((folder) => folder.uri === nextFolder.uri ? scanResult.folder : folder));
      setTracks((existing) => [...existing.filter((track) => track.folderUri !== nextFolder.uri), ...scanResult.tracks].sort((a, b) => `${a.folderName}/${a.name}`.localeCompare(`${b.folderName}/${b.name}`)));
      setNotice(`${scanResult.tracks.length} MP3 file${scanResult.tracks.length === 1 ? '' : 's'} found in ${nextFolder.name}.`);
    } catch {
      setNotice('Folder selection was cancelled or unavailable.');
    } finally {
      if (scanningUri) {
        setScanningFolderUris((existing) => {
          const next = new Set(existing);
          next.delete(scanningUri as string);
          return next;
        });
      }
    }
  }, [folders]);

  return {
    folders,
    setFolders,
    tracks,
    setTracks,
    isScanning,
    setIsScanning,
    notice,
    setNotice,
    scanningFolderUris,
    rescan,
    addFolder,
    libraryRevision,
    libraryRefreshTimer,
  };
}
