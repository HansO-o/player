/** Local E2E server: deterministic native ESM, byte ranges and isolation headers. */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
const publicDirectory = path.join(repository, 'public');
const stalledMedia = await readFile(path.join(publicDirectory, 'fixtures/tone-aac.m4a'));
const networkRequests = new Map();
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.map': 'application/json; charset=utf-8',
};

const inside = (file, directory) => file === directory || file.startsWith(`${directory}${path.sep}`);

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      response.writeHead(400).end('Invalid path');
      return;
    }
    // Real HTTP fault fixtures, not mocked fetch/decoder APIs. Each test has its
    // own id so it can prove the server observed cancellation of the old load.
    if (pathname.startsWith('/test/e2e/network/')) {
      const id = url.searchParams.get('id') || '';
      const mode = pathname.split('/').pop();
      if (!/^[a-z0-9-]{1,100}$/i.test(id) || !['headers', 'get-headers', 'body', 'status'].includes(mode)) {
        response.writeHead(400).end('Invalid network fixture');
        return;
      }
      if (mode === 'status') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(networkRequests.get(id) || { opened: 0, closed: 0, active: 0 }));
        return;
      }
      if (mode !== 'headers' && request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': String(stalledMedia.length), 'Accept-Ranges': 'bytes' }).end();
        return;
      }
      const entry = networkRequests.get(id) || { opened: 0, closed: 0, active: 0, methods: [], firstByteSent: false };
      entry.opened++; entry.active++; entry.methods.push(request.method);
      networkRequests.set(id, entry);
      response.once('close', () => { entry.closed++; entry.active--; });
      if (mode === 'body') {
        response.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': String(stalledMedia.length), 'Accept-Ranges': 'bytes' });
        response.flushHeaders();
        response.write(stalledMedia.subarray(0, 16));
        entry.firstByteSent = true;
      }
      // Deliberately neither end the response nor schedule data. The client
      // must abort, replace the source, destroy, or enforce its own timeout.
      return;
    }
    let target;
    let allowed;
    if (pathname.startsWith('/vendor/') || pathname.startsWith('/fixtures/')) {
      target = path.resolve(publicDirectory, `.${pathname}`);
      allowed = publicDirectory;
    } else if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/src/') || pathname.startsWith('/demo/') || pathname === '/test/e2e/harness.html') {
      target = path.resolve(repository, `.${pathname === '/' ? '/index.html' : pathname}`);
      allowed = repository;
    } else {
      response.writeHead(404).end('Not found');
      return;
    }
    target = await realpath(target);
    if (!inside(target, allowed)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) { response.writeHead(404).end('Not found'); return; }
    response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    response.setHeader('Accept-Ranges', 'bytes');
    const range = parseRange(request.headers.range, info.size);
    if (range === false) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Content-Length': '0' }).end();
      return;
    }
    if (range) {
      response.writeHead(206, { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`, 'Content-Length': String(range.end - range.start + 1) });
    } else {
      response.writeHead(200, { 'Content-Length': String(info.size) });
    }
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(target, range || {});
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : 404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`Octo Player test server: http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
