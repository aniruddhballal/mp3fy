import AsyncStorage from '@react-native-async-storage/async-storage';
import { readAsStringAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import { exportWrappedBackup, restoreWrappedBackup } from './wrappedStore';

const DESTINATION_KEY = 'mp3fy.wrappedBackupDestination.v2';
const BACKUP_FILE_NAME = 'mp3fy-wrapped.json';
const BACKUP_INTERVAL_MS = 60_000;

type Destination = { directoryUri: string; fileUri: string | null };

let destination: Destination | null = null;
let backupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRevision = 0;
let writtenRevision = 0;
let activeWrite: Promise<void> = Promise.resolve();

function clearBackupTimer() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = null;
}

function fileNameFromUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri.split(/[?#]/)[0]);
    return decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  } catch {
    return uri.replace(/\\/g, '/').split('/').pop() ?? '';
  }
}

async function findBackupFile(directoryUri: string): Promise<string | null> {
  const entries = await StorageAccessFramework.readDirectoryAsync(directoryUri);
  return entries.find((uri) => fileNameFromUri(uri) === BACKUP_FILE_NAME) ?? null;
}

function scheduleTimer() {
  if (!destination || backupTimer || pendingRevision === writtenRevision) return;
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void saveWrappedBackupNow().catch(() => undefined);
  }, BACKUP_INTERVAL_MS);
}

export async function initializeWrappedBackup(): Promise<boolean> {
  const saved = await AsyncStorage.getItem(DESTINATION_KEY);
  if (!saved) return false;
  try {
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object') return false;
    const candidate = parsed as Partial<Destination>;
    if (typeof candidate.directoryUri !== 'string') return false;
    const fileUri = typeof candidate.fileUri === 'string' ? candidate.fileUri : await findBackupFile(candidate.directoryUri).catch(() => null);
    if (fileUri) {
      const exists = await StorageAccessFramework.readDirectoryAsync(candidate.directoryUri)
        .then((entries) => entries.includes(fileUri))
        .catch(() => false);
      if (!exists) return false;
    }
    destination = { directoryUri: candidate.directoryUri, fileUri };
    return true;
  } catch {
    return false;
  }
}

/** Selects the compulsory backup folder and imports its existing JSON, if present. */
export async function chooseWrappedBackupFolder(): Promise<boolean> {
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return false;

  const fileUri = await findBackupFile(permission.directoryUri);
  if (fileUri) {
    const contents = await readAsStringAsync(fileUri);
    await restoreWrappedBackup(contents);
  }

  const next: Destination = { directoryUri: permission.directoryUri, fileUri };
  await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(next));
  destination = next;
  writtenRevision = pendingRevision;
  return true;
}

export function noteWrappedHistoryChanged(): void {
  pendingRevision += 1;
  scheduleTimer();
}

export async function saveWrappedBackupNow(): Promise<boolean> {
  clearBackupTimer();
  if (!destination || pendingRevision === writtenRevision) return Boolean(destination);
  const target = destination;
  const revision = pendingRevision;
  const nextWrite = activeWrite.catch(() => undefined).then(async () => {
    const snapshot = await exportWrappedBackup();
    const fileUri = target.fileUri ?? await findBackupFile(target.directoryUri)
      ?? await StorageAccessFramework.createFileAsync(target.directoryUri, 'mp3fy-wrapped', 'application/json');
    await StorageAccessFramework.writeAsStringAsync(fileUri, snapshot);
    const next: Destination = { directoryUri: target.directoryUri, fileUri };
    destination = next;
    await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(next));
    writtenRevision = Math.max(writtenRevision, revision);
    scheduleTimer();
    return true;
  });
  activeWrite = nextWrite.then(() => undefined, () => undefined);
  return nextWrite.catch((error) => {
    scheduleTimer();
    throw error;
  });
}
