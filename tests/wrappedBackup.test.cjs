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
  const restored = [];
  let snapshot = 'monday snapshot';
  const storage = {
    getItem: async (key) => preferences.get(key) ?? null,
    setItem: async (key, value) => { preferences.set(key, value); },
  };
  const saf = {
    requestDirectoryPermissionsAsync: async () => ({ granted: true, directoryUri: 'content://backups' }),
    readDirectoryAsync: async () => [...files.keys()],
    createFileAsync: async (_parent, name) => `content://backups/${name.endsWith('.json') ? name : `${name}.json`}`,
    readAsStringAsync: async (uri) => files.get(uri),
    writeAsStringAsync: async (uri, contents) => { files.set(uri, contents); },
  };
  const restart = () => {
    const backup = {};
    new Function('require', 'exports', javascript)((id) => {
      if (id === '@react-native-async-storage/async-storage') return storage;
      if (id === 'expo-file-system/legacy') return { StorageAccessFramework: saf, readAsStringAsync: saf.readAsStringAsync };
      if (id === './wrappedStore') return {
        exportWrappedBackup: async () => snapshot,
        restoreWrappedBackup: async (contents) => { restored.push(contents); },
      };
      throw new Error(`Unexpected import: ${id}`);
    }, backup);
    return backup;
  };
  return { backup: restart(), restart, files, preferences, restored, setSnapshot: (next) => { snapshot = next; } };
}

test('compulsory backup creates one JSON file only after listening history changes', async () => {
  const { backup, files, setSnapshot } = loadBackupHarness();
  assert.equal(await backup.chooseWrappedBackupFolder(), true);
  assert.equal(files.size, 0);
  backup.noteWrappedHistoryChanged();
  await backup.saveWrappedBackupNow();
  assert.deepEqual([...files.keys()], ['content://backups/mp3fy-wrapped.json']);
  assert.equal(files.get('content://backups/mp3fy-wrapped.json'), 'monday snapshot');
  setSnapshot('tuesday snapshot');
  backup.noteWrappedHistoryChanged();
  await backup.saveWrappedBackupNow();
  assert.equal(files.size, 1);
  assert.equal(files.get('content://backups/mp3fy-wrapped.json'), 'tuesday snapshot');
});

test('reinstalling and selecting the same folder restores its JSON and keeps writing to it', async () => {
  const { backup, files, preferences, restored, restart, setSnapshot } = loadBackupHarness();
  await backup.chooseWrappedBackupFolder();
  backup.noteWrappedHistoryChanged();
  await backup.saveWrappedBackupNow();
  preferences.clear();

  const reinstalled = restart();
  assert.equal(await reinstalled.chooseWrappedBackupFolder(), true);
  assert.deepEqual(restored, ['monday snapshot']);
  setSnapshot('tuesday snapshot');
  reinstalled.noteWrappedHistoryChanged();
  await reinstalled.saveWrappedBackupNow();
  assert.equal(files.size, 1);
  assert.equal(files.get('content://backups/mp3fy-wrapped.json'), 'tuesday snapshot');
});

test('existing backup destination can be reopened without creating another file', async () => {
  const { backup, files, preferences, restart, setSnapshot } = loadBackupHarness();
  await backup.chooseWrappedBackupFolder();
  backup.noteWrappedHistoryChanged();
  await backup.saveWrappedBackupNow();
  const saved = JSON.parse(preferences.values().next().value);
  assert.equal(saved.fileUri, 'content://backups/mp3fy-wrapped.json');

  const reopened = restart();
  assert.equal(await reopened.initializeWrappedBackup(), true);
  setSnapshot('after restart');
  reopened.noteWrappedHistoryChanged();
  await reopened.saveWrappedBackupNow();
  assert.equal(files.size, 1);
  assert.equal(files.get(saved.fileUri), 'after restart');
});
