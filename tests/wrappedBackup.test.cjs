const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'wrapped', 'wrappedBackup.ts'), 'utf8');
const javascript = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 } }).outputText;

function loadBackupHarness() {
  const files = new Map();
  const preferences = new Map();
  const failed = new Set();
  let snapshot = 'first snapshot';
  const storage = {
    getItem: async (key) => preferences.get(key) ?? null,
    setItem: async (key, value) => { preferences.set(key, value); },
  };
  const saf = {
    requestDirectoryPermissionsAsync: async () => ({ granted: true, directoryUri: 'content://backups' }),
    createFileAsync: async (_parent, name) => `content://backups/${name}.json`,
    writeAsStringAsync: async (uri, contents) => {
      if (failed.has(uri)) throw new Error('Storage unavailable');
      files.set(uri, contents);
    },
  };
  const restart = () => {
    const backup = {};
    new Function('require', 'exports', javascript)((id) => {
      if (id === '@react-native-async-storage/async-storage') return storage;
      if (id === 'expo-file-system/legacy') return { StorageAccessFramework: saf, getInfoAsync: async (uri) => ({ exists: files.has(uri) }) };
      if (id === './wrappedStore') return { exportWrappedBackup: async () => snapshot };
      throw new Error(`Unexpected import: ${id}`);
    }, backup);
    return backup;
  };
  return { backup: restart(), restart, files, failed, preferences, setSnapshot: (next) => { snapshot = next; } };
}

test('automatic Wrapped backup keeps two fixed files and tolerates one failed write', async () => {
  const { backup, files, failed, setSnapshot } = loadBackupHarness();
  assert.equal(await backup.chooseWrappedBackupFolder(), true);
  assert.equal(files.size, 2);
  assert.equal(files.get('content://backups/mp3fy-wrapped.json'), 'first snapshot');
  setSnapshot('second snapshot');
  backup.noteWrappedHistoryChanged();
  failed.add('content://backups/mp3fy-wrapped-previous.json');
  assert.equal(await backup.saveWrappedBackupNow(), true);
  assert.equal(files.get('content://backups/mp3fy-wrapped.json'), 'second snapshot');
  assert.equal(files.get('content://backups/mp3fy-wrapped-previous.json'), 'first snapshot');
  failed.clear();
  assert.equal(await backup.saveWrappedBackupNow(), true);
  assert.equal(files.get('content://backups/mp3fy-wrapped-previous.json'), 'second snapshot');
  assert.equal(files.size, 2);
});

test('existing backup destination can be reopened after app restart', async () => {
  const { backup, files, preferences, restart, setSnapshot } = loadBackupHarness();
  await backup.chooseWrappedBackupFolder();
  const saved = JSON.parse(preferences.values().next().value);
  assert.equal(files.has(saved.primaryUri), true);
  assert.equal(files.has(saved.reserveUri), true);
  const reopened = restart();
  assert.equal(reopened.isWrappedBackupEnabled(), false);
  assert.equal(await reopened.initializeWrappedBackup(), true);
  assert.equal(reopened.isWrappedBackupEnabled(), true);
  setSnapshot('after restart');
  await reopened.saveWrappedBackupNow();
  assert.equal(files.get(saved.primaryUri), 'after restart');
});
