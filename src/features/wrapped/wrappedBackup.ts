import AsyncStorage from '@react-native-async-storage/async-storage';
import { getInfoAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import { exportWrappedBackup } from './wrappedStore';

const DESTINATION_KEY = 'mp3fy.wrappedBackupDestination.v1';
const BACKUP_INTERVAL_MS = 60_000;

type Destination = { primaryUri: string; reserveUri: string };

let destination: Destination | null = null;
let backupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRevision = 0;
let writtenRevision = 0;
let activeWrite: Promise<void> = Promise.resolve();

function clearBackupTimer() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = null;
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
    if (typeof candidate.primaryUri !== 'string' || typeof candidate.reserveUri !== 'string') return false;
    const [primary, reserve] = await Promise.all([
      getInfoAsync(candidate.primaryUri).catch(() => ({ exists: false })),
      getInfoAsync(candidate.reserveUri).catch(() => ({ exists: false })),
    ]);
    if (!primary.exists && !reserve.exists) return false;
    destination = candidate as Destination;
    return true;
  } catch {
    return false;
  }
}

export function isWrappedBackupEnabled(): boolean {
  return destination !== null;
}

export async function chooseWrappedBackupFolder(): Promise<boolean> {
  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return false;
  const revision = pendingRevision;
  const snapshot = await exportWrappedBackup();
  const reserveUri = await StorageAccessFramework.createFileAsync(permission.directoryUri, 'mp3fy-wrapped-previous', 'application/json');
  await StorageAccessFramework.writeAsStringAsync(reserveUri, snapshot);
  const primaryUri = await StorageAccessFramework.createFileAsync(permission.directoryUri, 'mp3fy-wrapped', 'application/json');
  await StorageAccessFramework.writeAsStringAsync(primaryUri, snapshot);
  const next = { primaryUri, reserveUri };
  await AsyncStorage.setItem(DESTINATION_KEY, JSON.stringify(next));
  destination = next;
  writtenRevision = Math.max(writtenRevision, revision);
  scheduleTimer();
  return true;
}

export function noteWrappedHistoryChanged(): void {
  pendingRevision += 1;
  scheduleTimer();
}

export async function saveWrappedBackupNow(): Promise<boolean> {
  clearBackupTimer();
  if (!destination) return false;
  const target = destination;
  const revision = pendingRevision;
  const nextWrite = activeWrite.catch(() => undefined).then(async () => {
    const snapshot = await exportWrappedBackup();
    let successes = 0;
    let failure: unknown = null;
    for (const uri of [target.reserveUri, target.primaryUri]) {
      try {
        await StorageAccessFramework.writeAsStringAsync(uri, snapshot);
        successes += 1;
      } catch (error) {
        failure = error;
      }
    }
    if (!successes) throw failure || new Error('Could not save Wrapped backup');
    if (successes === 2) writtenRevision = Math.max(writtenRevision, revision);
    else pendingRevision = Math.max(pendingRevision, writtenRevision + 1);
    scheduleTimer();
    return true;
  });
  activeWrite = nextWrite.then(() => undefined, () => undefined);
  return nextWrite.catch((error) => {
    scheduleTimer();
    throw error;
  });
}
