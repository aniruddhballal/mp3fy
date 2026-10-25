import { Directory, File, Paths } from 'expo-file-system';
import { titleAndArtistFromFilename } from '../features/playback/playbackOrder';
import type { Track, TrackMetadata } from '../types/domain';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_METADATA_READ_BYTES = 4 * 1024 * 1024;
const MAX_ARTWORK_CACHE_FILES = 48;
const MAX_ARTWORK_CACHE_BYTES = 24 * 1024 * 1024;

export function fallbackMetadata(track: Track): TrackMetadata {
  return { ...titleAndArtistFromFilename(track.name), album: '', trackNumber: '' };
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function readSyncSafe(bytes: Uint8Array, start: number): number {
  return (bytes[start] << 21) | (bytes[start + 1] << 14) | (bytes[start + 2] << 7) | bytes[start + 3];
}

function readFrameSize(bytes: Uint8Array, start: number, version: number): number {
  if (version === 4) return readSyncSafe(bytes, start);
  return (bytes[start] * 0x1000000) + (bytes[start + 1] << 16) + (bytes[start + 2] << 8) + bytes[start + 3];
}

function findZero(bytes: Uint8Array, start: number): number {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 0) return index;
  }
  return bytes.length;
}

function decodeId3Text(bytes: Uint8Array, encoding: number): string {
  let end = bytes.length;
  if (encoding === 1 || encoding === 2) {
    while (end >= 2 && bytes[end - 2] === 0 && bytes[end - 1] === 0) end -= 2;
    let littleEndian = encoding === 1;
    let offset = 0;
    if (end >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      littleEndian = true;
      offset = 2;
    } else if (end >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      littleEndian = false;
      offset = 2;
    }
    const codeUnits: number[] = [];
    for (let index = offset; index + 1 < end; index += 2) {
      codeUnits.push(littleEndian ? bytes[index] | (bytes[index + 1] << 8) : (bytes[index] << 8) | bytes[index + 1]);
    }
    return String.fromCharCode(...codeUnits).replace(/\0/g, '').trim();
  }
  end = findZero(bytes, 0);
  const value = bytes.slice(0, end);
  if (!value.length) return '';
  try {
    if (encoding === 3) return new TextDecoder('utf-8').decode(value).replace(/\0/g, '').trim();
  } catch {
    // Fall through to a byte-preserving fallback for runtimes without TextDecoder support.
  }
  return String.fromCharCode(...value).replace(/\0/g, '').trim();
}

function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += BASE64[first >> 2];
    output += BASE64[((first & 3) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? BASE64[((second & 15) << 2) | (third >> 6)] : '=';
    output += index + 2 < bytes.length ? BASE64[third & 63] : '=';
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '').replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bitCount = 0;
  let offset = 0;
  for (const character of clean) {
    const digit = BASE64.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset] = (buffer >> bitCount) & 0xff;
      offset += 1;
    }
  }
  return bytes.slice(0, offset);
}

function artworkCacheKey(uri: string): string {
  let hash = 0;
  for (let index = 0; index < uri.length; index += 1) hash = ((hash << 5) - hash + uri.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(16);
}

export async function materializeArtwork(dataUri: string, trackUri: string): Promise<string | null> {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  try {
    const extension = match[1].split('/')[1] || 'jpg';
    const file = new File(Paths.cache, 'mp3fy-artwork', `${artworkCacheKey(trackUri)}.${extension}`);
    if (!file.exists) {
      file.create({ intermediates: true });
      file.write(decodeBase64(match[2]));
    }
    return file.uri;
  } catch {
    return null;
  }
}

export function rememberCacheValue<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value as string);
}

export function pruneArtworkCache() {
  try {
    const directory = new Directory(Paths.cache, 'mp3fy-artwork');
    if (!directory.exists) return;
    const entries = directory.list()
      .filter((item): item is File => item instanceof File)
      .map((file) => {
        const info = file.info();
        return { file, size: info.size ?? 0, modified: info.modificationTime ?? 0 };
      })
      .sort((a, b) => a.modified - b.modified);
    let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    while (entries.length > MAX_ARTWORK_CACHE_FILES || totalBytes > MAX_ARTWORK_CACHE_BYTES) {
      const entry = entries.shift();
      if (!entry) break;
      try {
        entry.file.delete();
        totalBytes -= entry.size;
      } catch {
        // A cache file can disappear while the system is reclaiming app cache.
      }
    }
  } catch {
    // Cache pruning is best effort and must never affect playback.
  }
}

function parseEmbeddedArtwork(bytes: Uint8Array): string | null {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return null;
  const version = bytes[3];
  if (version < 2 || version > 4) return null;
  const tagEnd = Math.min(bytes.length, 10 + readSyncSafe(bytes, 6));
  let cursor = 10;

  while (cursor + (version === 2 ? 6 : 10) <= tagEnd) {
    const idLength = version === 2 ? 3 : 4;
    const frameId = readAscii(bytes, cursor, idLength);
    if (!frameId.trim() || /^\0+$/.test(frameId)) break;
    const frameSize = version === 2
      ? (bytes[cursor + 3] << 16) | (bytes[cursor + 4] << 8) | bytes[cursor + 5]
      : readFrameSize(bytes, cursor + 4, version);
    const headerSize = version === 2 ? 6 : 10;
    const payloadStart = cursor + headerSize;
    const payloadEnd = Math.min(tagEnd, payloadStart + frameSize);
    if (payloadEnd <= payloadStart) break;

    if ((version === 2 && frameId === 'PIC') || (version !== 2 && frameId === 'APIC')) {
      let position = payloadStart;
      const encoding = bytes[position];
      position += 1;
      let mime = 'image/jpeg';
      if (version === 2) {
        const format = readAscii(bytes, position, 3).toLowerCase();
        mime = format === 'png' ? 'image/png' : format === 'gif' ? 'image/gif' : 'image/jpeg';
        position += 3;
      } else {
        const mimeEnd = findZero(bytes, position);
        const parsedMime = readAscii(bytes, position, mimeEnd - position);
        if (parsedMime) mime = parsedMime;
        position = mimeEnd + 1;
      }
      position += 1;
      if (encoding === 1 || encoding === 2) {
        position = findZero(bytes, position) + (encoding === 1 ? 2 : 1);
      } else {
        position = findZero(bytes, position) + 1;
      }
      if (position < payloadEnd) return `data:${mime};base64,${encodeBase64(bytes.slice(position, payloadEnd))}`;
    }
    cursor = payloadEnd;
  }
  return null;
}

function parseEmbeddedMetadata(bytes: Uint8Array, fallback: TrackMetadata): TrackMetadata {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return fallback;
  const version = bytes[3];
  if (version < 2 || version > 4) return fallback;
  const tagEnd = Math.min(bytes.length, 10 + readSyncSafe(bytes, 6));
  const fields: Record<string, keyof TrackMetadata> = version === 2
    ? { TT2: 'title', TP1: 'artist', TAL: 'album', TRK: 'trackNumber' }
    : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TRCK: 'trackNumber' };
  const metadata = { ...fallback };
  let cursor = 10;

  while (cursor + (version === 2 ? 6 : 10) <= tagEnd) {
    const idLength = version === 2 ? 3 : 4;
    const frameId = readAscii(bytes, cursor, idLength);
    if (!frameId.trim() || /^\0+$/.test(frameId)) break;
    const frameSize = version === 2
      ? (bytes[cursor + 3] << 16) | (bytes[cursor + 4] << 8) | bytes[cursor + 5]
      : readFrameSize(bytes, cursor + 4, version);
    const headerSize = version === 2 ? 6 : 10;
    const payloadStart = cursor + headerSize;
    const payloadEnd = Math.min(tagEnd, payloadStart + frameSize);
    if (payloadEnd <= payloadStart) break;
    const field = fields[frameId];
    if (field && payloadStart < payloadEnd) {
      const value = decodeId3Text(bytes.slice(payloadStart + 1, payloadEnd), bytes[payloadStart]);
      if (value) metadata[field] = value;
    }
    cursor = payloadEnd;
  }
  return metadata;
}

export async function loadEmbeddedTrackDetails(uri: string, fallback: TrackMetadata): Promise<{ artwork: string | null; metadata: TrackMetadata }> {
  try {
    const file = new File(uri);
    const handle = file.open();
    try {
      const sample = handle.readBytes(Math.min(handle.size ?? MAX_METADATA_READ_BYTES, MAX_METADATA_READ_BYTES));
      return { artwork: parseEmbeddedArtwork(sample), metadata: parseEmbeddedMetadata(sample, fallback) };
    } finally {
      handle.close();
    }
  } catch {
    return { artwork: null, metadata: fallback };
  }
}
