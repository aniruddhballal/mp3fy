const assert = require('node:assert/strict');
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

function loadStore(database, Clock = Date) {
  const store = {};
  new Function('require', 'exports', 'Date', javascript)((id) => {
    if (id === 'expo-sqlite') return { openDatabaseAsync: async () => database };
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

  database.db.prepare('INSERT INTO tracks (id, uri, title, artist, artist_key) VALUES (1, ?, ?, ?, ?)').run('old/song.mp3', 'Old song', 'Old artist', 'old artist');
  database.db.prepare('INSERT INTO tracks (id, uri, title, artist, artist_key) VALUES (2, ?, ?, ?, ?)').run('new/song.mp3', 'New song', 'New artist', 'new artist');
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

  await store.recordListening([{ uri: 'new/song.mp3', title: 'New song', artist: 'New artist', day: today, listenedMs: 10_000, plays: 0 }]);
  assert.equal((await store.getWrappedSummary('day', today)).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('week', store.weekStart(today))).listenedMs, 40_000);
  assert.equal((await store.getWrappedSummary('month', currentMonth)).listenedMs, 40_000);

  await store.recordListening([{ uri: 'old/song.mp3', title: 'Old song', artist: 'Old artist', day: oldDay, listenedMs: 5_000, plays: 0 }]);
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
  const track = { uri: 'boundary/song.mp3', title: 'Boundary', artist: 'Artist' };
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
