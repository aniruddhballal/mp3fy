import AsyncStorage from '@react-native-async-storage/async-storage';
import { readAsStringAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import { exportWrappedBackup, restoreWrappedBackup } from './wrappedStore';

const DESTINATION_KEY = 'mp3fy.wrappedBackupDestination.v2';
const VERIFIED_KEY = 'mp3fy.wrappedBackupVerifiedAt.v1';
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

function documentUriForFile(directoryUri: string, fileName: string): string | null {
  const cleanUri = directoryUri.split(/[?#]/)[0];
  const treeMarker = '/tree/';
  const markerIndex = cleanUri.indexOf(treeMarker);
  if (markerIndex < 0) return null;
  const documentId = cleanUri.slice(markerIndex + treeMarker.length);
  if (!documentId) return null;
  return `${cleanUri.slice(0, markerIndex)}/document/${documentId}%2F${encodeURIComponent(fileName)}`;
}

/**
 * Resolve the existing backup even when a provider rejects listing the tree.
 * Android SAF document URIs remain valid independently of directory enumeration.
 */
async function findExistingBackupFile(directoryUri: string): Promise<string | null> {
  try {
    return await findBackupFile(directoryUri);
  } catch (error) {
    const candidate = documentUriForFile(directoryUri, BACKUP_FILE_NAME);
    if (!candidate) throw error;
    try {
      const contents = await readAsStringAsync(candidate);
      if (typeof contents !== 'string') throw new Error('Backup file does not exist');
      return candidate;
    } catch {
      throw error;
    }
  }
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
    const fileUri = typeof candidate.fileUri === 'string' ? candidate.fileUri : await findExistingBackupFile(candidate.directoryUri);
    if (fileUri) await readAsStringAsync(fileUri);
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

  const fileUri = await findExistingBackupFile(permission.directoryUri);
  if (fileUri) {
    const contents = await readAsStringAsync(fileUri);
    await restoreWrappedBackup(contents);
  }

  const next: Destination = { directoryUri: permission.directoryUri, fileUri };
  await AsyncStorage.removeItem(VERIFIED_KEY);
  await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(next));
  destination = next;
  writtenRevision = pendingRevision;
  return true;
}

export function noteWrappedHistoryChanged(): void {
  pendingRevision += 1;
  scheduleTimer();
}

export async function getLastVerifiedWrappedBackup(): Promise<string | null> {
  const timestamp = await AsyncStorage.getItem(VERIFIED_KEY);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

export async function saveWrappedBackupNow(): Promise<boolean> {
  clearBackupTimer();
  if (!destination || pendingRevision === writtenRevision) return Boolean(destination);
  const target = destination;
  const revision = pendingRevision;
  const nextWrite = activeWrite.catch(() => undefined).then(async () => {
    const snapshot = await exportWrappedBackup();
    const fileUri = target.fileUri ?? await findExistingBackupFile(target.directoryUri)
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

/** Write and read back a fresh snapshot, even when the automatic backup appears current. */
export async function saveAndVerifyWrappedBackup(): Promise<string> {
  clearBackupTimer();
  const nextWrite = activeWrite.catch(() => undefined).then(async () => {
    clearBackupTimer();
    if (!destination) throw new Error('No backup folder selected');
    const target = destination;
    const revision = pendingRevision;
    const snapshot = await exportWrappedBackup();
    // Prefer the persisted file URI. Some Android storage providers can keep an
    // already-authorized document readable/writable while rejecting a fresh
    // directory enumeration for the same tree URI.
    const fileUri = target.fileUri ?? await findExistingBackupFile(target.directoryUri)
      ?? await StorageAccessFramework.createFileAsync(target.directoryUri, 'mp3fy-wrapped', 'application/json');
    // A failed or partial overwrite must not leave an old verification on the next visit.
    await AsyncStorage.removeItem(VERIFIED_KEY);
    await StorageAccessFramework.writeAsStringAsync(fileUri, snapshot);
    if (await readAsStringAsync(fileUri) !== snapshot) throw new Error('Backup verification failed');
    const saved: unknown = JSON.parse(snapshot);
    if (!saved || typeof saved !== 'object' || typeof (saved as { createdAt?: unknown }).createdAt !== 'string') throw new Error('Invalid backup timestamp');
    const timestamp = (saved as { createdAt: string }).createdAt;
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid backup timestamp');
    await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify({ directoryUri: target.directoryUri, fileUri } satisfies Destination));
    await AsyncStorage.setItem(VERIFIED_KEY, timestamp);
    destination = { directoryUri: target.directoryUri, fileUri };
    writtenRevision = Math.max(writtenRevision, revision);
    scheduleTimer();
    return timestamp;
  });
  activeWrite = nextWrite.then(() => undefined, () => undefined);
  return nextWrite.catch((error) => {
    scheduleTimer();
    throw error;
  });
}
