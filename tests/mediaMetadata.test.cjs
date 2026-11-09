const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

test('asynchronous artwork updates identify their track and cannot overwrite a newer selection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/playback/useTrackArtwork.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  const pending = new Map();
  const remoteUpdates = [];
  const mockRequire = (id) => {
    if (id === 'react') return {
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value }),
      useState: () => [null, () => {}],
    };
    if (id.endsWith('/mediaControls')) return { updateLockScreen: (_, metadata) => remoteUpdates.push(metadata) };
    if (id.endsWith('/wrappedStore')) return { updateTrackDetails: async () => {} };
    if (id.endsWith('/trackMetadata')) return {
      fallbackMetadata: (track) => ({ title: track.name }),
      loadEmbeddedTrackDetails: (uri) => new Promise((resolve) => pending.set(uri, resolve)),
      materializeArtwork: async () => 'file:///cover.jpg',
      rememberCacheValue: (cache, key, value) => cache.set(key, value),
    };
    throw new Error(`Unexpected import ${id}`);
  };
  vm.runInNewContext(code, { exports, require: mockRequire });
  const { loadArtwork } = exports.useTrackArtwork({
    player: {}, tracker: { updateMetadata() {} }, artworkCache: new Map(), metadataCache: new Map(),
  });
  const first = loadArtwork({ uri: 'song-a', name: 'A.mp3' });
  const second = loadArtwork({ uri: 'song-b', name: 'B.mp3' });
  pending.get('song-b')({ artwork: null, metadata: { title: 'B', artist: 'Artist B' } });
  await second;
  pending.get('song-a')({ artwork: null, metadata: { title: 'A', artist: 'Artist A' } });
  await first;
  assert.equal(remoteUpdates.length, 1);
  assert.equal(remoteUpdates[0].title, 'B');
  assert.equal(remoteUpdates[0].uri, 'song-b', 'native playback needs the identity to reject late updates after a car next/previous command');
});
