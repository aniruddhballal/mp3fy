export type LyricsQuery = {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
};

export type LyricsLine = {
  /** Start time of this line in milliseconds. */
  timestampMs: number;
  /** Lyric text after the timestamp tag(s). */
  text: string;
};

export type LyricsRecord = {
  id: number | null;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

export type LyricsSuccess =
  | { kind: 'synced'; title: string; artist: string; album: string; lines: LyricsLine[] }
  | { kind: 'plain'; title: string; artist: string; album: string; plainLyrics: string }
  | { kind: 'instrumental'; title: string; artist: string; album: string };

export type LyricsNotFound = {
  kind: 'not-found';
};

export type LyricsFailure = {
  kind: 'error';
  message: string;
};

export type LyricsResult = LyricsSuccess | LyricsNotFound | LyricsFailure;

export const LRCLIB_API_URL = 'https://lrclib.net/api/get';
export const MP3FY_USER_AGENT = 'mp3fy/1.6';

const TIMESTAMP_TAG = /\[(\d+):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
const TIMESTAMP_PREFIX = /^(?:\s*\[\d+:\d{1,2}(?:\.\d{1,3})?\])+/;

function timestampToMilliseconds(minutesText: string, secondsText: string, fractionText = ''): number | null {
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds) || minutes < 0 || seconds < 0 || seconds >= 60) return null;
  const milliseconds = Number(fractionText.padEnd(3, '0').slice(0, 3) || 0);
  if (!Number.isInteger(milliseconds)) return null;
  return (minutes * 60 + seconds) * 1000 + milliseconds;
}

/** Parse timestamped LRC text into stable, chronologically ordered lyric lines. */
export function parseSyncedLyrics(value: string | null | undefined): LyricsLine[] {
  if (typeof value !== 'string' || value.length === 0) return [];

  const parsed: Array<LyricsLine & { sourceOrder: number }> = [];
  let sourceOrder = 0;

  for (const rawLine of value.replace(/\r\n?/g, '\n').split('\n')) {
    const prefix = rawLine.match(TIMESTAMP_PREFIX);
    if (!prefix) continue;

    const text = rawLine.slice(prefix[0].length).trim();
    const timestampText = prefix[0];
    for (const match of timestampText.matchAll(TIMESTAMP_TAG)) {
      const timeMs = timestampToMilliseconds(match[1], match[2], match[3] ?? '');
      if (timeMs === null) continue;
      parsed.push({ timestampMs: timeMs, text, sourceOrder });
      sourceOrder += 1;
    }
  }

  parsed.sort((a, b) => a.timestampMs - b.timestampMs || a.sourceOrder - b.sourceOrder);
  return parsed.map(({ timestampMs, text }) => ({ timestampMs, text }));
}

function errorResult(message: string): LyricsFailure {
  return { kind: 'error', message };
}

function notFound(): LyricsNotFound {
  return { kind: 'not-found' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`);
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number or null`);
  return value;
}

function toLyricsRecord(value: unknown, query: LyricsQuery): LyricsRecord {
  if (!isRecord(value)) throw new Error('LRCLIB returned a non-object response');

  const id = value.id === undefined || value.id === null ? null : value.id;
  if (id !== null && (typeof id !== 'number' || !Number.isFinite(id))) throw new Error('id must be a finite number or null');

  const instrumental = value.instrumental === undefined ? false : value.instrumental;
  if (typeof instrumental !== 'boolean') throw new Error('instrumental must be a boolean');

  const title = value.trackName === undefined ? query.title : value.trackName;
  const artist = value.artistName === undefined ? query.artist : value.artistName;
  if (typeof title !== 'string' || typeof artist !== 'string') throw new Error('trackName and artistName must be strings');

  return {
    id,
    title,
    artist,
    album: nullableString(value.albumName, 'albumName') ?? query.album ?? '',
    duration: nullableNumber(value.duration, 'duration'),
    instrumental,
    plainLyrics: nullableString(value.plainLyrics, 'plainLyrics'),
    syncedLyrics: nullableString(value.syncedLyrics, 'syncedLyrics'),
  };
}

function queryUrl(query: LyricsQuery): string | LyricsFailure {
  if (!query || typeof query.title !== 'string' || query.title.trim() === '') {
    return errorResult('title is required');
  }
  if (typeof query.artist !== 'string' || query.artist.trim() === '') {
    return errorResult('artist is required');
  }
  if (query.duration !== undefined && (!Number.isFinite(query.duration) || query.duration < 0)) {
    return errorResult('duration must be a non-negative finite number');
  }

  const params = new URLSearchParams({
    track_name: query.title,
    artist_name: query.artist,
  });
  if (query.album?.trim()) params.set('album_name', query.album);
  if (query.duration !== undefined) params.set('duration', String(query.duration));
  return `${LRCLIB_API_URL}?${params.toString()}`;
}

function messageFromUnknown(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Fetch lyrics for one track on demand from LRCLIB. This function performs no caching or UI work. */
export async function fetchLyrics(
  query: LyricsQuery,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LyricsResult> {
  const url = queryUrl(query);
  if (typeof url !== 'string') return url;

  if (typeof fetchImpl !== 'function') return errorResult('Fetch is not available');

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': MP3FY_USER_AGENT },
    });
  } catch (error) {
    return errorResult(messageFromUnknown(error, 'Unable to reach LRCLIB'));
  }

  if (response.status === 404) return notFound();
  const isOk = response.ok ?? (response.status >= 200 && response.status < 300);
  if (!isOk) return errorResult(`LRCLIB returned HTTP ${response.status}`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return errorResult(messageFromUnknown(error, 'LRCLIB returned invalid JSON'));
  }

  let record: LyricsRecord;
  try {
    record = toLyricsRecord(payload, query);
  } catch (error) {
    return errorResult(messageFromUnknown(error, 'LRCLIB returned an invalid lyrics record'));
  }

  if (record.instrumental) return { kind: 'instrumental', title: record.title, artist: record.artist, album: record.album };

  if (record.syncedLyrics?.trim()) {
    const lines = parseSyncedLyrics(record.syncedLyrics);
    if (lines.length === 0) return errorResult('LRCLIB returned unusable synced lyrics');
    return { kind: 'synced', title: record.title, artist: record.artist, album: record.album, lines };
  }

  if (record.plainLyrics?.trim()) return { kind: 'plain', title: record.title, artist: record.artist, album: record.album, plainLyrics: record.plainLyrics };
  return notFound();
}
