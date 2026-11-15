import { throwIfAborted } from './source.js';

const MAX_MOOV = 2 * 1024 * 1024;
const text = (data, offset, length = 4) => String.fromCharCode(...data.subarray(offset, offset + length));
const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);

function box(data, offset, end) {
  if (offset + 8 > end) return null;
  const dv = view(data);
  let size = dv.getUint32(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = Number(dv.getBigUint64(offset + 8)); header = 16;
  }
  if (!size) size = end - offset;
  if (!Number.isSafeInteger(size) || size < header) return null;
  return { type: text(data, offset + 4), size, start: offset + header, end: offset + size };
}

function children(data, start, end) {
  const result = [];
  while (start + 8 <= end) {
    const item = box(data, start, end);
    if (!item || item.end > end) break;
    result.push(item); start = item.end;
  }
  return result;
}

export function parseMoov(data) {
  const root = box(data, 0, data.length);
  if (!root || root.type !== 'moov' || root.end > data.length) return null;
  const result = { container: 'mp4', tracks: [] };
  const descend = (item, type) => children(data, item.start, item.end).find(child => child.type === type);
  for (const track of children(data, root.start, root.end).filter(item => item.type === 'trak')) {
    const mdia = descend(track, 'mdia');
    if (!mdia) continue;
    const handler = descend(mdia, 'hdlr');
    const minf = descend(mdia, 'minf');
    if (!handler || handler.start + 12 > handler.end || !minf) continue;
    const type = text(data, handler.start + 8);
    const stbl = descend(minf, 'stbl');
    const stsd = stbl && descend(stbl, 'stsd');
    if (!stsd || stsd.start + 8 > stsd.end) continue;
    const entry = box(data, stsd.start + 8, stsd.end);
    if (!entry || entry.end > stsd.end) continue;
    result.tracks.push({ kind: type === 'vide' ? 'video' : type === 'soun' ? 'audio' : type, codec: entry.type });
  }
  result.hasVideo = result.tracks.some(track => track.kind === 'video');
  result.hasAudio = result.tracks.some(track => track.kind === 'audio');
  return result;
}

async function boundedBody(response, max) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (bytes < max) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, max - bytes);
      chunks.push(chunk); bytes += chunk.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  const output = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

/** Bounded metadata probe. No whole-file download and no requirement that a URL supports CORS. */
export async function probeMp4(source, signal) {
  if (!/mp4|quicktime/.test(source.mime) && !/\.(mp4|m4v|m4a|mov)$/i.test(source.name)) return null;
  const local = typeof Blob !== 'undefined' && source.input instanceof Blob;
  let requests = 0;
  let cache = new Uint8Array(); let cacheOffset = 0;
  const read = async (offset, count) => {
    throwIfAborted(signal);
    if (offset >= cacheOffset && offset + count <= cacheOffset + cache.length) return cache.subarray(offset - cacheOffset, offset - cacheOffset + count);
    if (local) return new Uint8Array(await source.input.slice(offset, offset + count).arrayBuffer());
    if (++requests > 5) return new Uint8Array();
    const response = await fetch(source.input, { headers: { Range: `bytes=${offset}-${offset + count - 1}` }, signal, credentials: source.credentials || 'same-origin' });
    if (!response.ok || (offset > 0 && response.status !== 206)) { await response.body?.cancel(); return new Uint8Array(); }
    return boundedBody(response, count);
  };
  try {
    cache = await read(0, 65536);
    const first = box(cache, 0, cache.length);
    if (!first || !['ftyp', 'moov', 'free', 'wide'].includes(first.type)) return null;
    let offset = 0;
    for (let i = 0; i < 32; i++) {
      const header = await read(offset, 16);
      const current = box(header, 0, header.length);
      if (!current) return null;
      if (current.type === 'moov') {
        if (current.size > MAX_MOOV) return null;
        return parseMoov(await read(offset, current.size));
      }
      offset += current.size;
    }
  } catch (error) { if (signal?.aborted) throw error; }
  return null;
}
