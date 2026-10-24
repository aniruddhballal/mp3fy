const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const typescript = require('typescript');

class TestDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  async execAsync(sql) { this.db.exec(sql); }
  async runAsync(sql, ...args) { this.db.prepare(sql).run(...(Array.isArray(args[0]) ? args[0] : args)); }
  async getFirstAsync(sql, ...args) { return this.db.prepare(sql).get(...(Array.isArray(args[0]) ? args[0] : args)) ?? null; }
  async getAllAsync(sql, ...args) { return this.db.prepare(sql).all(...(Array.isArray(args[0]) ? args[0] : args)); }
  async withExclusiveTransactionAsync(task) {
    this.db.exec('BEGIN IMMEDIATE');
    try { await task(this); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

const source = fs.readFileSync(path.join(__dirname, '..', 'wrappedStore.ts'), 'utf8');
const javascript = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 } }).outputText;
const hashName = (name) => createHash('sha256').update(name.normalize('NFC').toLowerCase()).digest('hex');

function loadStore(database, Clock = Date) {
  const store = {};
  new Function('require', 'exports', 'Date', javascript)((id) => {
    if (id === 'expo-sqlite') return { openDatabaseAsync: async () => database };
    if (id === 'expo-crypto') return {
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      digestStringAsync: async (_algorithm, value) => createHash('sha256').update(value).digest('hex'),
    };
    throw new Error(`Unexpected import: ${id}`);
  }, store, Clock);
  return store;
}

test('expired rankings vanish while annual and all-time history and milestones survive', async () => {
  const database = new TestDatabase();
  const store = loadStore(database);
  await store.getAvailableYears(); // Create the schema without pruning yet.
  const today = store.localDay(new Date());
  const currentYear = today.slice(0, 4);
  const oldYear = String(Number(currentYear) - 1);
  const oldDay = `${oldYear}-06-15`;
  const oldMonth = oldDay.slice(0, 7);
  const currentMonth = today.slice(0, 7);

  database.db.prepare('INSERT INTO tracks (id, song_key, file_name, title, artist, artist_key) VALUES (1, ?, ?, ?, ?, ?)').run(hashName('old-song.mp3'), 'old-song.mp3', 'Old song', 'Old artist', 'old artist');
  database.db.prepare('INSERT INTO tracks (id, song_key, file_name, title, artist, artist_key) VALUES (2, ?, ?, ?, ?, ?)').run(hashName('new-song.mp3'), 'new-song.mp3', 'New song', 'New artist', 'new artist');
  const insertPeriod = database.db.prepare('INSERT INTO period_stats (grain, period, track_id, listened_ms, plays) VALUES (?, ?, ?, ?, ?)');
  for (const [grain, period] of [['day', oldDay], ['month', oldMonth], ['year', oldYear], ['all', '*']]) insertPeriod.run(grain, period, 1, 60_000, 1);
  for (const [grain, period] of [['day', today], ['month', currentMonth], ['year', currentYear], ['all', '*']]) insertPeriod.run(grain, period, 2, 30_000, 1);
  database.db.prepare('INSERT INTO day_totals (day, listened_ms) VALUES (?, ?)').run(oldDay, 60_000);
  database.db.prepare('INSERT INTO day_totals (day, listened_ms) VALUES (?, ?)').run(today, 30_000);

  await store.initializeWrappedStore();
  assert.equal((await store.getWrappedSummary('week', store.weekStart(today))).listenedMs, 30_000);
  assert.equal((await store.getWrappedSummary('day', oldDay)).listenedMs, 0);
  assert.equal((await store.getWrappedSummary('month', oldMonth)).listenedMs, 0);

  const oldAnnual = await store.getWrappedSummary('year', oldYear);
  assert.equal(oldAnnual.songs[0].name, 'Old song');
  assert.deepEqual({ ...oldAnnual.longestDay }, { period: oldDay, listenedMs: 60_000 });
  assert.deepEqual({ ...oldAnnual.longestMonth }, { period: oldMonth, listenedMs: 60_000 });
  assert.equal((await store.getWrappedSummary('all', '*')).listenedMs, 90_000);
  assert.ok((await store.getAvailableYears()).includes(oldYear));

  await store.recordListening([{ uri: 'new/song.mp3', fileName: 'new-song.mp3', title: 'New song', artist: 'New artist', day: today, listenedMs: 10_000, plays: 0 }]);
  assert.equal((await store.getWrappedSummary('day', today)).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('week', store.weekStart(today))).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('month', currentMonth)).listenedMs, 40_000);

  await store.recordListening([{ uri: 'old/song.mp3', fileName: 'old-song.mp3', title: 'Old song', artist: 'Old artist', day: oldDay, listenedMs: 5_000, plays: 0 }]);
  assert.equal((await store.getWrappedSummary('year', oldYear)).listenedMs, 65_000);
  assert.equal((await store.getWrappedSummary('month', oldMonth)).listenedMs, 0);
  assert.deepEqual({ ...(await store.getWrappedSummary('year', oldYear)).longestMonth }, { period: oldMonth, listenedMs: 65_000 });
  assert.equal((await store.getWrappedSummary('all', '*')).listenedMs, 105_000);
});

test('day, week and month rankings expire at their boundaries', async () => {
  let now = new Date(2026, 9, 31, 12).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const database = new TestDatabase();
  const store = loadStore(database, ClockDate);
  const track = { uri: 'boundary/song.mp3', fileName: 'song.mp3', title: 'Boundary', artist: 'Artist' };
  await store.recordListening([{ ...track, day: '2026-10-31', listenedMs: 30_000, plays: 1 }]);
  assert.equal((await store.getWrappedSummary('day', '2026-10-31')).listenedMs, 30_000);
  assert.equal((await store.getWrappedSummary('week', '2026-10-26')).listenedMs, 30_000);
  assert.equal((await store.getWrappedSummary('month', '2026-10')).listenedMs, 30_000);

  now = new Date(2026, 10, 1, 12).getTime(); // Sunday: a new month, same week.
  await store.initializeWrappedStore();
  assert.equal((await store.getWrappedSummary('day', '2026-10-31')).listenedMs, 0);
  assert.equal((await store.getWrappedSummary('week', '2026-10-26')).listenedMs, 30_000);
  assert.equal((await store.getWrappedSummary('month', '2026-10')).listenedMs, 0);
  assert.deepEqual({ ...(await store.getWrappedSummary('year', '2026')).longestMonth }, { period: '2026-10', listenedMs: 30_000 });
  await store.recordListening([{ ...track, day: '2026-11-01', listenedMs: 10_000, plays: 0 }]);
  assert.equal((await store.getWrappedSummary('week', '2026-10-26')).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('month', '2026-11')).listenedMs, 10_000);

  now = new Date(2026, 10, 2, 12).getTime(); // Monday: a new week.
  await store.initializeWrappedStore();
  assert.equal((await store.getWrappedSummary('week', '2026-10-26')).listenedMs, 0);
  assert.equal((await store.getWrappedSummary('month', '2026-11')).listenedMs, 10_000);
  assert.equal((await store.getWrappedSummary('year', '2026')).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('all', '*')).listenedMs, 40_000);
});

test('legacy URI histories merge by filename without losing plays or listening time', async () => {
  const database = new TestDatabase();
  database.db.exec(`
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, uri TEXT NOT NULL UNIQUE, title TEXT NOT NULL, artist TEXT NOT NULL, artist_key TEXT NOT NULL);
    CREATE TABLE period_stats (grain TEXT NOT NULL, period TEXT NOT NULL, track_id INTEGER NOT NULL REFERENCES tracks(id), listened_ms INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (grain, period, track_id)) WITHOUT ROWID;
  `);
  const insertTrack = database.db.prepare('INSERT INTO tracks (id, uri, title, artist, artist_key) VALUES (?, ?, ?, ?, ?)');
  insertTrack.run(1, 'content://provider/document/primary%3AMusic%2FPlaylistA%2FSong.mp3', 'Song', 'Artist', 'artist');
  insertTrack.run(2, 'content://provider/document/primary%3AMusic%2FPlaylistB%2FSong.mp3', 'Song', 'Artist', 'artist');
  insertTrack.run(3, 'content://provider/document/primary%3AMusic%2FOther.mp3', 'Song', 'Artist', 'artist');
  const insertPeriod = database.db.prepare('INSERT INTO period_stats (grain, period, track_id, listened_ms, plays) VALUES (?, ?, ?, ?, ?)');
  for (const grain of ['year', 'all']) {
    const period = grain === 'year' ? '2025' : '*';
    insertPeriod.run(grain, period, 1, 60_000, 1);
    insertPeriod.run(grain, period, 2, 90_000, 2);
    insertPeriod.run(grain, period, 3, 30_000, 1);
  }

  const store = loadStore(database);
  await store.initializeWrappedStore();
  const tracks = database.db.prepare('SELECT song_key, file_name FROM tracks ORDER BY file_name').all();
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((track) => track.file_name), ['Other.mp3', 'Song.mp3']);
  assert.equal(tracks.find((track) => track.file_name === 'Song.mp3').song_key, hashName('Song.mp3'));
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM period_stats').get().count, 4);
  assert.equal((await store.getWrappedSummary('year', '2025')).listenedMs, 180_000);
  assert.deepEqual((await store.getWrappedSummary('year', '2025')).songs.map(({ name, plays }) => ({ name, plays })), [
    { name: 'Song', plays: 3 }, { name: 'Song', plays: 1 },
  ]);

  const today = store.localDay(new Date());
  await store.recordListening([{ uri: 'new-folder/song.mp3', fileName: 'song.MP3', title: 'Song', artist: 'Artist', day: today, listenedMs: 30_000, plays: 1 }]);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM tracks').get().count, 2);
  assert.equal((await store.getWrappedSummary('all', '*')).songs[0].plays, 4);
  assert.equal((await store.getWrappedSummary('all', '*')).listenedMs, 210_000);
});

test('matching filenames in different folders accumulate under one hashed song ID', async () => {
  const database = new TestDatabase();
  const store = loadStore(database);
  const today = store.localDay(new Date());
  const first = { uri: 'folder-a/Track.mp3', fileName: 'Track.mp3', title: 'Track', artist: 'Artist', day: today, listenedMs: 30_000, plays: 1 };
  await store.recordListening([first, { ...first, uri: 'folder-b/track.mp3', fileName: 'track.mp3', listenedMs: 45_000 }]);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM tracks').get().count, 1);
  const track = database.db.prepare('SELECT song_key FROM tracks').get();
  assert.equal(track.song_key, hashName('Track.mp3'));
  assert.equal((await store.getWrappedSummary('day', today)).songs[0].plays, 2);
  assert.equal((await store.getWrappedSummary('all', '*')).songs[0].listenedMs, 75_000);
});

test('Wrapped backup restores annual, current, all-time and milestone totals', async () => {
  const original = loadStore(new TestDatabase());
  const today = original.localDay(new Date());
  const oldYear = String(Number(today.slice(0, 4)) - 1);
  await original.recordListening([
    { uri: 'a/one.mp3', fileName: 'one.mp3', title: 'One', artist: 'Artist', day: today, listenedMs: 45_000, plays: 1 },
    { uri: 'b/two.mp3', fileName: 'two.mp3', title: 'Two', artist: 'Other', day: `${oldYear}-05-12`, listenedMs: 65_000, plays: 2 },
  ]);
  const backup = await original.exportWrappedBackup();
  assert.equal(JSON.parse(backup).format, 'mp3fy-wrapped');
  const restored = loadStore(new TestDatabase());
  await restored.restoreWrappedBackup(backup);
  assert.deepEqual(await restored.getWrappedSummary('all', '*'), await original.getWrappedSummary('all', '*'));
  assert.deepEqual(await restored.getWrappedSummary('year', oldYear), await original.getWrappedSummary('year', oldYear));
  assert.deepEqual(await restored.getWrappedSummary('day', today), await original.getWrappedSummary('day', today));
  assert.deepEqual(await restored.getAvailableYears(), await original.getAvailableYears());
  assert.equal(await restored.hasWrappedHistory(), true);
});

test('invalid Wrapped backup cannot replace existing history', async () => {
  const store = loadStore(new TestDatabase());
  const today = store.localDay(new Date());
  await store.recordListening([{ uri: 'song.mp3', fileName: 'song.mp3', title: 'Song', artist: 'Artist', day: today, listenedMs: 30_000, plays: 1 }]);
  const backup = JSON.parse(await store.exportWrappedBackup());
  backup.tracks[0].songKey = 'wrong';
  await assert.rejects(store.restoreWrappedBackup(JSON.stringify(backup)), /Invalid Wrapped track/);
  assert.equal((await store.getWrappedSummary('all', '*')).listenedMs, 30_000);
});
