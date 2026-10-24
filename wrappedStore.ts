import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

export type ListeningEntry = {
  uri: string;
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
  allTimeMs: number;
  artists: WrappedRank[];
  songs: WrappedRank[];
  longestDay: { period: string; listenedMs: number } | null;
  longestMonth: { period: string; listenedMs: number } | null;
};
export type AvailablePeriods = Record<Exclude<WrappedPeriod, 'all'>, string[]>;

const DAY_HISTORY_DAYS = 70;
let databasePromise: Promise<SQLiteDatabase> | null = null;
let writeQueue = Promise.resolve();

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
          uri TEXT NOT NULL UNIQUE,
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
      `);
      return db;
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function initializeWrappedStore(): Promise<void> {
  await enqueueWrite(async () => {
    const db = await openStore();
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - DAY_HISTORY_DAYS);
    await db.runAsync("DELETE FROM period_stats WHERE grain = 'day' AND period < ?", weekStart(localDay(cutoff)));
  });
}

export async function updateTrackDetails(uri: string, title: string, artist: string): Promise<void> {
  await enqueueWrite(async () => {
    const db = await openStore();
    const displayArtist = normalizeArtist(artist);
    await db.runAsync(`
      INSERT INTO tracks (uri, title, artist, artist_key) VALUES (?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET title = excluded.title, artist = excluded.artist, artist_key = excluded.artist_key
    `, uri, title.trim() || uri, displayArtist, displayArtist.toLocaleLowerCase());
  });
}

export async function recordListening(entries: ListeningEntry[]): Promise<void> {
  const valid = entries.filter((entry) => entry.uri && /^\d{4}-\d{2}-\d{2}$/.test(entry.day)
    && Number.isFinite(entry.listenedMs) && entry.listenedMs >= 0
    && Number.isInteger(entry.plays) && entry.plays >= 0
    && (entry.listenedMs > 0 || entry.plays > 0));
  if (!valid.length) return;
  await enqueueWrite(async () => {
    const db = await openStore();
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const entry of valid) {
        const displayArtist = normalizeArtist(entry.artist);
        await txn.runAsync(`
          INSERT INTO tracks (uri, title, artist, artist_key) VALUES (?, ?, ?, ?)
          ON CONFLICT(uri) DO UPDATE SET title = excluded.title, artist = excluded.artist, artist_key = excluded.artist_key
        `, entry.uri, entry.title.trim() || entry.uri, displayArtist, displayArtist.toLocaleLowerCase());
        const track = await txn.getFirstAsync<{ id: number }>('SELECT id FROM tracks WHERE uri = ?', entry.uri);
        if (!track) throw new Error('Track was not stored');
        const periods: [string, string][] = [
          ['day', entry.day],
          ['month', monthlyKey(entry.day)],
          ['year', yearlyKey(entry.day)],
          ['all', '*'],
        ];
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
        }
      }
    });
  });
}

function periodFilter(period: WrappedPeriod, key: string): { grain: string; start: string; end: string } {
  if (period === 'week') {
    const [year, month, date] = key.split('-').map(Number);
    const end = new Date(year, month - 1, date);
    end.setDate(end.getDate() + 6);
    return { grain: 'day', start: key, end: localDay(end) };
  }
  if (period === 'all') return { grain: 'all', start: '*', end: '*' };
  return { grain: period, start: key, end: key };
}

export async function getWrappedSummary(period: WrappedPeriod, key: string): Promise<WrappedSummary> {
  await writeQueue;
  const db = await openStore();
  const filter = periodFilter(period, key);
  const params: [string, string, string] = [filter.grain, filter.start, filter.end];
  const [total, allTime, artists, songs, longestDay, longestMonth] = await Promise.all([
    db.getFirstAsync<{ listenedMs: number }>(`SELECT COALESCE(SUM(listened_ms), 0) AS listenedMs FROM period_stats WHERE grain = ? AND period BETWEEN ? AND ?`, params),
    db.getFirstAsync<{ listenedMs: number }>("SELECT COALESCE(SUM(listened_ms), 0) AS listenedMs FROM period_stats WHERE grain = 'all'"),
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
    db.getFirstAsync<{ period: string; listenedMs: number }>('SELECT day AS period, listened_ms AS listenedMs FROM day_totals ORDER BY listened_ms DESC, day ASC LIMIT 1'),
    db.getFirstAsync<{ period: string; listenedMs: number }>(`
      SELECT period, SUM(listened_ms) AS listenedMs FROM period_stats WHERE grain = 'month'
      GROUP BY period ORDER BY listenedMs DESC, period ASC LIMIT 1
    `),
  ]);
  return {
    listenedMs: total?.listenedMs ?? 0,
    allTimeMs: allTime?.listenedMs ?? 0,
    artists,
    songs,
    longestDay: longestDay ?? null,
    longestMonth: longestMonth ?? null,
  };
}

export async function getAvailablePeriods(now = new Date()): Promise<AvailablePeriods> {
  await writeQueue;
  const db = await openStore();
  const rows = await db.getAllAsync<{ grain: string; period: string }>(`
    SELECT DISTINCT grain, period FROM period_stats WHERE grain IN ('day', 'month', 'year')
    ORDER BY period DESC
  `);
  const today = localDay(now);
  const available: AvailablePeriods = {
    day: [today],
    week: [weekStart(today)],
    month: [monthlyKey(today)],
    year: [yearlyKey(today)],
  };
  for (const row of rows) {
    if (row.grain === 'day') {
      if (!available.day.includes(row.period)) available.day.push(row.period);
      const week = weekStart(row.period);
      if (!available.week.includes(week)) available.week.push(week);
    } else if (row.grain === 'month' || row.grain === 'year') {
      if (!available[row.grain].includes(row.period)) available[row.grain].push(row.period);
    }
  }
  for (const periods of Object.values(available)) periods.sort().reverse();
  return available;
}
