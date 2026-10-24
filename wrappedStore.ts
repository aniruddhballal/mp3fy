import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

export type ListeningEntry = {
  uri: string;
  fileName: string;
  title: string;
  artist: string;
  day: string;
  listenedMs: number;
  plays: number;
};

export type WrappedPeriod = 'day' | 'week' | 'month' | 'year' | 'all';
export type WrappedRank = { name: string; artist: string; listenedMs: number; plays: number };
export type WrappedSummary = {
  listenedMs: number;
  artists: WrappedRank[];
  songs: WrappedRank[];
  longestDay: { period: string; listenedMs: number } | null;
  longestMonth: { period: string; listenedMs: number } | null;
};
let databasePromise: Promise<SQLiteDatabase> | null = null;
let writeQueue = Promise.resolve();
let prunedForDay: string | null = null;

export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function weekStart(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year, month - 1, date);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return localDay(start);
}

function monthlyKey(day: string): string { return day.slice(0, 7); }
function yearlyKey(day: string): string { return day.slice(0, 4); }

function normalizeArtist(artist: string): string {
  return artist.trim() || 'Unknown Artist';
}

function normalizeFileName(fileName: string): string {
  return fileName.normalize('NFC').toLowerCase();
}

async function songKey(fileName: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalizeFileName(fileName));
}

function fileNameFromUri(uri: string): string {
  // Old installations stored only a URI. SAF document IDs can contain encoded slashes.
  const rawPath = uri.split(/[?#]/)[0];
  let path = rawPath;
  try { path = decodeURIComponent(rawPath); } catch { /* Keep a malformed legacy URI as-is. */ }
  path = path.replace(/\\/g, '/');
  return path.split('/').pop() || uri;
}

async function migrateUriTracks(db: SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(tracks)');
  if (columns.some((column) => column.name === 'song_key')) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(`
      CREATE TABLE tracks_by_name (
        id INTEGER PRIMARY KEY,
        song_key TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        artist_key TEXT NOT NULL
      );
      CREATE TABLE period_stats_by_name (
        grain TEXT NOT NULL,
        period TEXT NOT NULL,
        track_id INTEGER NOT NULL REFERENCES tracks_by_name(id),
        listened_ms INTEGER NOT NULL DEFAULT 0,
        plays INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (grain, period, track_id)
      ) WITHOUT ROWID;
    `);
    const oldTracks = await txn.getAllAsync<{ id: number; uri: string; title: string; artist: string; artist_key: string }>(
      'SELECT id, uri, title, artist, artist_key FROM tracks ORDER BY id'
    );
    for (const oldTrack of oldTracks) {
      const fileName = fileNameFromUri(oldTrack.uri);
      const key = await songKey(fileName);
      await txn.runAsync(`
        INSERT INTO tracks_by_name (song_key, file_name, title, artist, artist_key)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(song_key) DO UPDATE SET
          title = excluded.title, artist = excluded.artist, artist_key = excluded.artist_key
      `, key, fileName, oldTrack.title, oldTrack.artist, oldTrack.artist_key);
      const newTrack = await txn.getFirstAsync<{ id: number }>('SELECT id FROM tracks_by_name WHERE song_key = ?', key);
      if (!newTrack) throw new Error('Migrated track was not stored');
      await txn.runAsync(`
        INSERT INTO period_stats_by_name (grain, period, track_id, listened_ms, plays)
        SELECT grain, period, ?, listened_ms, plays FROM period_stats WHERE track_id = ?
        ON CONFLICT(grain, period, track_id) DO UPDATE SET
          listened_ms = listened_ms + excluded.listened_ms,
          plays = plays + excluded.plays
      `, newTrack.id, oldTrack.id);
    }
    await txn.execAsync(`
      DROP TABLE period_stats;
      DROP TABLE tracks;
      ALTER TABLE tracks_by_name RENAME TO tracks;
      ALTER TABLE period_stats_by_name RENAME TO period_stats;
    `);
  });
}

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const write = writeQueue.then(task);
  writeQueue = write.catch(() => undefined);
  return write;
}

async function openStore(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await openDatabaseAsync('mp3fy-wrapped.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS tracks (
          id INTEGER PRIMARY KEY,
          song_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          title TEXT NOT NULL,
          artist TEXT NOT NULL,
          artist_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS period_stats (
          grain TEXT NOT NULL,
          period TEXT NOT NULL,
          track_id INTEGER NOT NULL REFERENCES tracks(id),
          listened_ms INTEGER NOT NULL DEFAULT 0,
          plays INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (grain, period, track_id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS day_totals (
          day TEXT PRIMARY KEY,
          listened_ms INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS month_totals (
          month TEXT PRIMARY KEY,
          listened_ms INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
      `);
      await migrateUriTracks(db);
      return db;
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function pruneExpiredRankings(db: SQLiteDatabase): Promise<void> {
  const today = localDay(new Date());
  if (prunedForDay === today) return;
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Existing installations may have older monthly rankings. Preserve their
    // duration totals before removing the per-track rows.
    await txn.runAsync(`
      INSERT OR IGNORE INTO month_totals (month, listened_ms)
      SELECT period, SUM(listened_ms) FROM period_stats WHERE grain = 'month' GROUP BY period
    `);
    // The previous release calculated weeks from daily rows. Carry the
    // current week into its own aggregate before expiring older days.
    await txn.runAsync(`
      INSERT OR IGNORE INTO period_stats (grain, period, track_id, listened_ms, plays)
      SELECT 'week', ?, track_id, SUM(listened_ms), SUM(plays)
      FROM period_stats WHERE grain = 'day' AND period BETWEEN ? AND ? GROUP BY track_id
    `, weekStart(today), weekStart(today), today);
    await txn.runAsync("DELETE FROM period_stats WHERE grain = 'day' AND period < ?", today);
    await txn.runAsync("DELETE FROM period_stats WHERE grain = 'week' AND period < ?", weekStart(today));
    await txn.runAsync("DELETE FROM period_stats WHERE grain = 'month' AND period < ?", monthlyKey(today));
  });
  prunedForDay = today;
}

export async function initializeWrappedStore(): Promise<void> {
  await enqueueWrite(async () => pruneExpiredRankings(await openStore()));
}

export async function updateTrackDetails(fileName: string, title: string, artist: string): Promise<void> {
  await enqueueWrite(async () => {
    const db = await openStore();
    const displayArtist = normalizeArtist(artist);
    const key = await songKey(fileName);
    await db.runAsync(`
      INSERT INTO tracks (song_key, file_name, title, artist, artist_key) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(song_key) DO UPDATE SET title = excluded.title, artist = excluded.artist, artist_key = excluded.artist_key
    `, key, fileName, title.trim() || fileName, displayArtist, displayArtist.toLocaleLowerCase());
  });
}

export async function recordListening(entries: ListeningEntry[]): Promise<void> {
  const valid = entries.filter((entry) => entry.uri && entry.fileName?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(entry.day)
    && Number.isFinite(entry.listenedMs) && entry.listenedMs >= 0
    && Number.isInteger(entry.plays) && entry.plays >= 0
    && (entry.listenedMs > 0 || entry.plays > 0));
  if (!valid.length) return;
  await enqueueWrite(async () => {
    const db = await openStore();
    await pruneExpiredRankings(db);
    await db.withExclusiveTransactionAsync(async (txn) => {
      const today = localDay(new Date());
      const currentWeek = weekStart(today);
      const currentMonth = monthlyKey(today);
      for (const entry of valid) {
        const displayArtist = normalizeArtist(entry.artist);
        const key = await songKey(entry.fileName);
        await txn.runAsync(`
          INSERT INTO tracks (song_key, file_name, title, artist, artist_key) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(song_key) DO UPDATE SET title = excluded.title, artist = excluded.artist, artist_key = excluded.artist_key
        `, key, entry.fileName, entry.title.trim() || entry.fileName, displayArtist, displayArtist.toLocaleLowerCase());
        const track = await txn.getFirstAsync<{ id: number }>('SELECT id FROM tracks WHERE song_key = ?', key);
        if (!track) throw new Error('Track was not stored');
        const periods: [string, string][] = [['year', yearlyKey(entry.day)], ['all', '*']];
        if (entry.day === today) periods.push(['day', today]);
        if (weekStart(entry.day) === currentWeek) periods.push(['week', currentWeek]);
        if (monthlyKey(entry.day) === currentMonth) periods.push(['month', currentMonth]);
        for (const [grain, period] of periods) {
          await txn.runAsync(`
            INSERT INTO period_stats (grain, period, track_id, listened_ms, plays) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(grain, period, track_id) DO UPDATE SET
              listened_ms = listened_ms + excluded.listened_ms,
              plays = plays + excluded.plays
          `, grain, period, track.id, Math.round(entry.listenedMs), entry.plays);
        }
        if (entry.listenedMs > 0) {
          await txn.runAsync(`
            INSERT INTO day_totals (day, listened_ms) VALUES (?, ?)
            ON CONFLICT(day) DO UPDATE SET listened_ms = listened_ms + excluded.listened_ms
          `, entry.day, Math.round(entry.listenedMs));
          await txn.runAsync(`
            INSERT INTO month_totals (month, listened_ms) VALUES (?, ?)
            ON CONFLICT(month) DO UPDATE SET listened_ms = listened_ms + excluded.listened_ms
          `, monthlyKey(entry.day), Math.round(entry.listenedMs));
        }
      }
    });
  });
}

function periodFilter(period: WrappedPeriod, key: string): { grain: string; start: string; end: string } {
  if (period === 'all') return { grain: 'all', start: '*', end: '*' };
  return { grain: period, start: key, end: key };
}

export async function getWrappedSummary(period: WrappedPeriod, key: string): Promise<WrappedSummary> {
  if (prunedForDay !== localDay(new Date())) await initializeWrappedStore();
  await writeQueue;
  const db = await openStore();
  const filter = periodFilter(period, key);
  const params: [string, string, string] = [filter.grain, filter.start, filter.end];
  const [total, artists, songs, longestDay, longestMonth] = await Promise.all([
    db.getFirstAsync<{ listenedMs: number }>(`SELECT COALESCE(SUM(listened_ms), 0) AS listenedMs FROM period_stats WHERE grain = ? AND period BETWEEN ? AND ?`, params),
    db.getAllAsync<WrappedRank>(`
      SELECT MIN(t.artist) AS name, '' AS artist, SUM(p.listened_ms) AS listenedMs, SUM(p.plays) AS plays
      FROM period_stats p JOIN tracks t ON t.id = p.track_id
      WHERE p.grain = ? AND p.period BETWEEN ? AND ?
      GROUP BY t.artist_key HAVING SUM(p.listened_ms) > 0
      ORDER BY listenedMs DESC, plays DESC, name COLLATE NOCASE LIMIT 5
    `, params),
    db.getAllAsync<WrappedRank>(`
      SELECT t.title AS name, t.artist AS artist, SUM(p.listened_ms) AS listenedMs, SUM(p.plays) AS plays
      FROM period_stats p JOIN tracks t ON t.id = p.track_id
      WHERE p.grain = ? AND p.period BETWEEN ? AND ?
      GROUP BY t.id HAVING SUM(p.plays) > 0
      ORDER BY plays DESC, listenedMs DESC, name COLLATE NOCASE LIMIT 5
    `, params),
    period === 'year' ? db.getFirstAsync<{ period: string; listenedMs: number }>(`
      SELECT day AS period, listened_ms AS listenedMs FROM day_totals
      WHERE day BETWEEN ? AND ? ORDER BY listened_ms DESC, day ASC LIMIT 1
    `, `${key}-01-01`, `${key}-12-31`) : Promise.resolve(null),
    period === 'year' ? db.getFirstAsync<{ period: string; listenedMs: number }>(`
      SELECT month AS period, listened_ms AS listenedMs FROM month_totals
      WHERE month BETWEEN ? AND ? ORDER BY listened_ms DESC, month ASC LIMIT 1
    `, `${key}-01`, `${key}-12`) : Promise.resolve(null),
  ]);
  return {
    listenedMs: total?.listenedMs ?? 0,
    artists,
    songs,
    longestDay: longestDay ?? null,
    longestMonth: longestMonth ?? null,
  };
}

export async function getAvailableYears(now = new Date()): Promise<string[]> {
  await writeQueue;
  const db = await openStore();
  const rows = await db.getAllAsync<{ period: string }>("SELECT DISTINCT period FROM period_stats WHERE grain = 'year' ORDER BY period DESC");
  return Array.from(new Set([String(now.getFullYear()), ...rows.map((row) => row.period)])).sort().reverse();
}
