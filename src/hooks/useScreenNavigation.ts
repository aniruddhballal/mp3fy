import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { BackHandler } from 'react-native';
import type { Folder, Screen, Track } from '../types/domain';

type UseScreenNavigationOptions = {
  currentTrack: Track | null;
  folders: Folder[];
  folderActions: Folder | null;
  folderToConfirm: Folder | null;
  observePlayback: () => void;
  flushListening: () => Promise<void>;
  onCloseFolderActions: () => void;
  onCloseFolderConfirmation: () => void;
};

type ScreenNavigation = {
  screen: Screen;
  setScreen: Dispatch<SetStateAction<Screen>>;
  openFolder: (folder: Folder) => void;
  openPlayerFromMini: () => void;
  openQueue: () => void;
  closeQueue: () => void;
  openWrapped: () => void;
  closeWrapped: () => void;
};

export function useScreenNavigation({ currentTrack, folders, folderActions, folderToConfirm, observePlayback, flushListening, onCloseFolderActions, onCloseFolderConfirmation }: UseScreenNavigationOptions): ScreenNavigation {
  const [screen, setScreen] = useState<Screen>({ kind: 'folders' });

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (folderActions || folderToConfirm) {
        onCloseFolderActions();
        onCloseFolderConfirmation();
        return true;
      }
      if (screen.kind === 'wrapped' || screen.kind === 'queue') {
        if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
        else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
        else setScreen({ kind: 'folders' });
        return true;
      }
      if (screen.kind === 'player') {
        setScreen(screen.returnTo === 'songs' && currentTrack ? { kind: 'songs', folderUri: currentTrack.folderUri } : { kind: 'folders' });
        return true;
      }
      if (screen.kind === 'songs') {
        setScreen({ kind: 'folders' });
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [currentTrack, folderActions, folderToConfirm, folders, onCloseFolderActions, onCloseFolderConfirmation, screen]);

  const openFolder = useCallback((folder: Folder) => setScreen({ kind: 'songs', folderUri: folder.uri }), []);

  const openPlayerFromMini = useCallback(() => {
    if (currentTrack) setScreen({ kind: 'player', returnTo: screen.kind === 'songs' ? 'songs' : 'folders' });
  }, [currentTrack, screen.kind]);

  const openQueue = useCallback(() => {
    if (!currentTrack || screen.kind === 'queue' || screen.kind === 'wrapped') return;
    setScreen({ kind: 'queue', returnTo: screen.kind, folderUri: screen.kind === 'songs' ? screen.folderUri : undefined, playerReturnTo: screen.kind === 'player' ? screen.returnTo : undefined });
  }, [currentTrack, screen]);

  const closeQueue = useCallback(() => {
    if (screen.kind !== 'queue') return;
    if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
    else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
    else setScreen({ kind: 'folders' });
  }, [currentTrack, folders, screen]);

  const openWrapped = useCallback(() => {
    observePlayback();
    void flushListening().catch(() => undefined);
    setScreen({ kind: 'wrapped', returnTo: screen.kind === 'wrapped' ? 'folders' : screen.kind === 'queue' ? screen.returnTo : screen.kind, folderUri: screen.kind === 'songs' ? screen.folderUri : screen.kind === 'queue' ? screen.folderUri : undefined, playerReturnTo: screen.kind === 'player' ? screen.returnTo : screen.kind === 'queue' ? screen.playerReturnTo : undefined });
  }, [flushListening, observePlayback, screen]);

  const closeWrapped = useCallback(() => {
    if (screen.kind !== 'wrapped') return;
    if (screen.returnTo === 'player' && currentTrack) setScreen({ kind: 'player', returnTo: screen.playerReturnTo ?? 'folders' });
    else if (screen.returnTo === 'songs' && screen.folderUri && folders.some((folder) => folder.uri === screen.folderUri)) setScreen({ kind: 'songs', folderUri: screen.folderUri });
    else setScreen({ kind: 'folders' });
  }, [currentTrack, folders, screen]);

  return { screen, setScreen, openFolder, openPlayerFromMini, openQueue, closeQueue, openWrapped, closeWrapped };
}
