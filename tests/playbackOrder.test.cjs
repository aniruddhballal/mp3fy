const assert = require('node:assert/strict');
const test = require('node:test');
const { buildQueue, nextPlaybackMode, restorePlaybackMode } = require('../src/features/playback/playbackOrder.ts');

const tracks = [
  { uri: 'a-z', folderUri: 'folder', name: 'Artist A - Zebra.mp3' },
  { uri: 'a-a', folderUri: 'folder', name: 'Artist A - Alpha.mp3' },
  { uri: 'b-b', folderUri: 'folder', name: 'Artist B - Beta.mp3' },
  { uri: 'other', folderUri: 'other-folder', name: 'Artist C - Other.mp3' },
];

test('playback mode cycles from folder order through title order and shuffle', () => {
  assert.equal(nextPlaybackMode('folder'), 'title');
  assert.equal(nextPlaybackMode('title'), 'shuffle');
  assert.equal(nextPlaybackMode('shuffle'), 'folder');
  assert.equal(restorePlaybackMode('sequential'), 'title');
  assert.equal(restorePlaybackMode('shuffle'), 'shuffle');
});

test('folder order groups artists by filename while title order sorts song titles', () => {
  assert.deepEqual(buildQueue(tracks, tracks[0], 'folder').queue.map((track) => track.uri), ['a-a', 'a-z', 'b-b']);
  assert.deepEqual(buildQueue(tracks, tracks[0], 'title').queue.map((track) => track.uri), ['a-a', 'b-b', 'a-z']);
  assert.deepEqual(buildQueue(tracks, tracks[0], 'title', [], Math.random, (track) => track.uri === 'a-z' ? 'Aardvark' : track.name).queue.map((track) => track.uri), ['a-z', 'a-a', 'b-b']);
});

test('returning to shuffle changes the upcoming order if it would repeat', () => {
  const first = buildQueue(tracks, tracks[0], 'shuffle', [], () => 0.99).queue;
  const next = buildQueue(tracks, tracks[0], 'shuffle', first.map((track) => track.uri), () => 0.99).queue;
  assert.equal(first[0].uri, tracks[0].uri);
  assert.equal(next[0].uri, tracks[0].uri);
  assert.notDeepEqual(next.map((track) => track.uri), first.map((track) => track.uri));
  assert.deepEqual(new Set(next.map((track) => track.uri)), new Set(first.map((track) => track.uri)));
});

test('a separately selected song remains playable when no selected folder contains it', () => {
  assert.deepEqual(buildQueue(tracks, tracks[3], 'folder').queue.map((track) => track.uri), ['other']);
});
