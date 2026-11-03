const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

test('a filtered song remains tappable while the search keyboard is open', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/screens/LibraryScreens.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  const native = { FlatList: 'FlatList', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View' };
  const mockRequire = (id) => {
    if (id === 'react/jsx-runtime') return require(id);
    if (id === 'react') return { memo: (component) => component, useMemo: (fn) => fn(), useState: () => ['needle', () => {}] };
    if (id === 'react-native') return native;
    if (id === '../services/trackMetadata') return { fallbackMetadata: (track) => ({ title: track.name, artist: '' }) };
    if (id === '../styles/appStyles') return { styles: {} };
    return {};
  };
  vm.runInNewContext(code, { exports, require: mockRequire });
  const selected = [];
  const target = { uri: 'target', name: 'Needle song' };
  const tree = exports.SongsScreen({ folder: { name: 'Folder' }, tracks: [target, { uri: 'other', name: 'Other song' }], currentTrack: null, currentMetadata: null, metadataCache: new Map(), isScanning: false, playing: false, onPlayTrack: (track) => selected.push(track), onOpenQueue: () => {} });
  const list = tree.props.children.find((child) => child?.type === native.FlatList);
  assert.equal(list.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(list.props.data.length, 1);
  const row = list.props.renderItem({ item: list.props.data[0] });
  row.props.onPress();
  assert.equal(selected[0], target);
});
