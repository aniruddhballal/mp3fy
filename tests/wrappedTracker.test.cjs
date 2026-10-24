const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

// Run the pure playback counter without loading Expo's native SQLite module.
const source = fs.readFileSync(path.join(__dirname, '..', 'wrappedTracker.ts'), 'utf8');
const javascript = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 } }).outputText;
const exported = {};
const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
new Function('require', 'exports', javascript)((id) => {
  if (id === './wrappedStore') return { localDay };
  throw new Error(`Unexpected import: ${id}`);
}, exported);
const { ListeningTracker } = exported;

function sample(atMs, positionSeconds, track, playing = true, durationSeconds = 240) {
  return { atMs, positionSeconds, track, playing, buffering: false, durationSeconds };
}

test('counts a play at 30 audible seconds and excludes paused time', async () => {
  const writes = [];
  const tracker = new ListeningTracker(async (entries) => { writes.push(...entries); });
  const track = { uri: 'song-one', fileName: 'one.mp3', title: 'One', artist: 'Artist' };
  const start = new Date(2026, 9, 24, 12).getTime();
  tracker.observe(sample(start, 0, track));
  tracker.observe(sample(start + 29_000, 29, track));
  await tracker.flush();
  assert.equal(writes.reduce((sum, entry) => sum + entry.listenedMs, 0), 29_000);
  assert.equal(writes.reduce((sum, entry) => sum + entry.plays, 0), 0);
  tracker.observe(sample(start + 30_000, 30, track, false));
  tracker.observe(sample(start + 90_000, 30, track, false));
  await tracker.flush();
  assert.equal(writes.reduce((sum, entry) => sum + entry.listenedMs, 0), 30_000);
  assert.equal(writes.reduce((sum, entry) => sum + entry.plays, 0), 1);
});

test('seek jumps do not add listening time or a play', async () => {
  const writes = [];
  const tracker = new ListeningTracker(async (entries) => { writes.push(...entries); });
  const track = { uri: 'song-two', fileName: 'two.mp3', title: 'Two', artist: 'Artist' };
  const start = new Date(2026, 9, 24, 12).getTime();
  tracker.observe(sample(start, 0, track));
  tracker.observe(sample(start + 10_000, 10, track));
  tracker.markSeek(200);
  tracker.observe(sample(start + 11_000, 200, track));
  tracker.observe(sample(start + 12_000, 201, track));
  await tracker.flush();
  assert.equal(writes.reduce((sum, entry) => sum + entry.listenedMs, 0), 11_000);
  assert.equal(writes.reduce((sum, entry) => sum + entry.plays, 0), 0);
});

test('listening that crosses midnight is attributed to both local days', async () => {
  const writes = [];
  const tracker = new ListeningTracker(async (entries) => { writes.push(...entries); });
  const track = { uri: 'song-three', fileName: 'three.mp3', title: 'Three', artist: 'Artist' };
  const start = new Date(2026, 9, 24, 23, 59, 59).getTime();
  tracker.observe(sample(start, 0, track));
  tracker.observe(sample(start + 2000, 2, track));
  await tracker.flush();
  assert.deepEqual(writes.map(({ day, listenedMs }) => ({ day, listenedMs })), [
    { day: '2026-10-24', listenedMs: 1000 },
    { day: '2026-10-25', listenedMs: 1000 },
  ]);
});

test('copies of one filename carry the same stable identity across folders', async () => {
  const writes = [];
  const tracker = new ListeningTracker(async (entries) => { writes.push(...entries); });
  const start = new Date(2026, 9, 24, 12).getTime();
  const first = { uri: 'folder-a/song.mp3', fileName: 'song.mp3', title: 'Same title', artist: 'Artist' };
  const second = { uri: 'folder-b/song.mp3', fileName: 'song.mp3', title: 'Same title', artist: 'Artist' };
  tracker.observe(sample(start, 0, first));
  tracker.observe(sample(start + 30_000, 30, first));
  tracker.observe(sample(start + 31_000, 0, second));
  tracker.observe(sample(start + 61_000, 30, second));
  await tracker.flush();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(({ fileName, plays }) => ({ fileName, plays })), [
    { fileName: 'song.mp3', plays: 1 },
    { fileName: 'song.mp3', plays: 1 },
  ]);
});

test('repeating the same song can count a second qualified play', async () => {
  const writes = [];
  const tracker = new ListeningTracker(async (entries) => { writes.push(...entries); });
  const track = { uri: 'repeat-song', fileName: 'repeat-song.mp3', title: 'Repeat', artist: 'Artist' };
  const start = new Date(2026, 9, 24, 12).getTime();
  tracker.observe(sample(start, 0, track, true, 40));
  tracker.observe(sample(start + 39_000, 39, track, true, 40));
  tracker.observe(sample(start + 40_000, 0, track, true, 40));
  tracker.observe(sample(start + 70_000, 30, track, true, 40));
  await tracker.flush();
  assert.equal(writes.reduce((sum, entry) => sum + entry.plays, 0), 2);
});
