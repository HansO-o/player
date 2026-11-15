const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska',
  hevc: 'video/hevc', h265: 'video/hevc', ivf: 'video/av1',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav',
  m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', ts: 'video/mp2t',
};

export function normalizeSource(value, baseURI = globalThis.document?.baseURI || 'http://localhost/') {
  const descriptor = value && typeof value === 'object' && 'src' in value ? value : { src: value };
  const input = descriptor.src;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const name = descriptor.name || input.name || 'local-video';
    return { ...descriptor, input, name, mime: descriptor.type || input.type || mimeFromName(name), local: true };
  }
  if (typeof input !== 'string' || !input.trim()) throw new TypeError('Provide a File, Blob, URL or { src, type }');
  const url = new URL(input, baseURI);
  if (!['http:', 'https:', 'blob:'].includes(url.protocol)) throw new TypeError('Only HTTP(S), blob URLs and local files are supported');
  const name = descriptor.name || decodeName(url.pathname.split('/').pop()) || 'video';
  return { ...descriptor, input: url.href, name, mime: descriptor.type || mimeFromName(name), local: url.protocol === 'blob:' };
}

function decodeName(name) { try { return decodeURIComponent(name); } catch { return name; } }
export function mimeFromName(name = '') { return MIME[name.split('?')[0].split('.').pop().toLowerCase()] || ''; }

export function abortError() { return new DOMException('Playback operation was superseded or destroyed', 'AbortError'); }
export function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

export function serializableSource(source) {
  // Signed URLs may contain access tokens; diagnostics never export a URL or full local filename.
  return source ? { local: source.local, mime: source.mime, size: source.input?.size ?? null } : null;
}
