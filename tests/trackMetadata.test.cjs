const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

const source = fs.readFileSync('src/services/trackMetadata.ts', 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

test('embedded artwork is cached as its original bytes alongside ID3 metadata', async () => {
  const image = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const frame = (id, payload) => { const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(payload.length, 4); return Buffer.concat([header, payload]); };
  const tag = Buffer.concat([frame('TIT2', Buffer.from('\x03Test title\0')), frame('APIC', Buffer.concat([Buffer.from('\x00image/jpeg\0\x03\0'), image]))]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (tag.length >> 7) & 0x7f, tag.length & 0x7f]);
  const sample = Buffer.concat([header, tag]);
  let written;
  class File {
    constructor(...parts) { this.uri = parts.join('/'); this.exists = false; }
    open() { return { size: sample.length, readBytes: () => new Uint8Array(sample), close() {} }; }
    create() {}
    write(bytes) { written = Buffer.from(bytes); }
  }
  const exports = {};
  new Function('require', 'exports', javascript)((id) => {
    if (id === 'expo-file-system') return { File, Directory: class {}, Paths: { cache: 'cache' } };
    if (id.includes('playbackOrder')) return { titleAndArtistFromFilename: () => ({ title: 'fallback', artist: '' }) };
    throw new Error(id);
  }, exports);
  const details = await exports.loadEmbeddedTrackDetails('song', { title: 'fallback', artist: '', album: '', trackNumber: '' });
  assert.equal(details.metadata.title, 'Test title');
  assert.equal(details.artwork.mime, 'image/jpeg');
  await exports.materializeArtwork(details.artwork, 'song');
  assert.deepEqual(written, image);
});
