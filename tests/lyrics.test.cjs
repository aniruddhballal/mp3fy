const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LRCLIB_API_URL,
  LYRICS_NETWORK_ERROR_MESSAGE,
  MP3FY_USER_AGENT,
  fetchLyrics,
  parseSyncedLyrics,
} = require('../src/features/lyrics/lyrics.ts');

test('parses two- and three-digit fractional timestamps and ignores metadata tags', () => {
  assert.deepEqual(parseSyncedLyrics('[ar:Artist]\n[ti:Song]\n[00:01.23]First\n[01:02.345]Second'), [
    { timestampMs: 1_230, text: 'First' },
    { timestampMs: 62_345, text: 'Second' },
  ]);
});

test('keeps repeated timestamps and repeated timestamp tags in stable source order', () => {
  assert.deepEqual(parseSyncedLyrics('[00:04.00]Later\n[00:01.000][00:01.00]Twice\n[00:01.00]Again'), [
    { timestampMs: 1_000, text: 'Twice' },
    { timestampMs: 1_000, text: 'Twice' },
    { timestampMs: 1_000, text: 'Again' },
    { timestampMs: 4_000, text: 'Later' },
  ]);
});

test('normalizes CRLF, trims lyric text, preserves blank timed lines, and skips malformed timestamps', () => {
  assert.deepEqual(parseSyncedLyrics('[00:02.5]  line  \r\n[00:60.00]bad\r\nnot timed\r\n[00:03.00]'), [
    { timestampMs: 2_500, text: 'line' },
    { timestampMs: 3_000, text: '' },
  ]);
});

function response(payload, status = 200, ok = status >= 200 && status < 300) {
  return { status, ok, json: async () => payload };
}

function basePayload(overrides = {}) {
  return {
    id: 42,
    trackName: 'Song & More',
    artistName: 'An Artist',
    albumName: 'An Album',
    duration: 201,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: null,
    ...overrides,
  };
}

test('fetches synced lyrics with URL-encoded required and optional query fields', async () => {
  let request;
  const result = await fetchLyrics({
    title: 'Song & More',
    artist: 'An Artist/Name',
    album: 'Album #1',
    duration: 201,
  }, async (url, init) => {
    request = { url, init };
    return response(basePayload({ syncedLyrics: '[00:00.00]Hello' }));
  });

  assert.equal(result.kind, 'synced');
  assert.deepEqual(result.lines, [{ timestampMs: 0, text: 'Hello' }]);
  const parsedUrl = new URL(request.url);
  assert.equal(parsedUrl.origin + parsedUrl.pathname, LRCLIB_API_URL);
  assert.equal(parsedUrl.searchParams.get('track_name'), 'Song & More');
  assert.equal(parsedUrl.searchParams.get('artist_name'), 'An Artist/Name');
  assert.equal(parsedUrl.searchParams.get('album_name'), 'Album #1');
  assert.equal(parsedUrl.searchParams.get('duration'), '201');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers['User-Agent'], MP3FY_USER_AGENT);
});

test('returns plain lyrics when LRCLIB has no synced lyrics', async () => {
  const result = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => (
    response(basePayload({ syncedLyrics: null, plainLyrics: 'Plain lyric text' }))
  ));

  assert.equal(result.kind, 'plain');
  assert.equal(result.plainLyrics, 'Plain lyric text');
});

test('returns instrumental when LRCLIB marks the track instrumental', async () => {
  const result = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => (
    response(basePayload({ instrumental: true }))
  ));

  assert.equal(result.kind, 'instrumental');
});

test('omits absent optional query fields', async () => {
  let requestedUrl;
  await fetchLyrics({ title: 'Song', artist: 'Artist' }, async (url) => {
    requestedUrl = url;
    return response(basePayload({ plainLyrics: 'Lyrics' }));
  });

  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.searchParams.has('album_name'), false);
  assert.equal(parsedUrl.searchParams.has('duration'), false);
});

test('returns not-found for LRCLIB 404 and a successful empty record', async () => {
  const notFoundResult = await fetchLyrics({ title: 'Missing', artist: 'Artist' }, async () => response({}, 404, false));
  assert.equal(notFoundResult.kind, 'not-found');

  const emptyResult = await fetchLyrics({ title: 'Empty', artist: 'Artist' }, async () => response(basePayload()));
  assert.equal(emptyResult.kind, 'not-found');
});

test('returns useful errors for HTTP, network, invalid JSON, and invalid response failures', async () => {
  const http = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => response({}, 503, false));
  assert.deepEqual(http, {
    kind: 'error',
    message: 'LRCLIB returned HTTP 503',
  });

  const network = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => {
    throw new Error('java.net.UnknownHostException: Unable to resolve host');
  });
  assert.equal(network.kind, 'error');
  assert.equal(network.message, LYRICS_NETWORK_ERROR_MESSAGE);
  assert.equal(network.reason, 'network');

  const invalidJson = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => ({
    status: 200,
    ok: true,
    json: async () => { throw new SyntaxError('bad json'); },
  }));
  assert.equal(invalidJson.kind, 'error');
  assert.equal(invalidJson.message, 'bad json');

  const invalidResponse = await fetchLyrics({ title: 'Song', artist: 'Artist' }, async () => (
    response(basePayload({ plainLyrics: 123 }))
  ));
  assert.equal(invalidResponse.kind, 'error');
  assert.match(invalidResponse.message, /plainLyrics must be a string/);
});

test('returns validation errors without making a request', async () => {
  let called = false;
  const result = await fetchLyrics({ title: '', artist: 'Artist' }, async () => {
    called = true;
    return response(basePayload());
  });

  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'title is required');
  assert.equal(called, false);
});

