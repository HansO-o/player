import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { patchLibmedia, sha256, ORIGINAL_SHA256, PATCH_VERSION } from './patch-libmedia.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'scripts/libmedia-assets.json'), 'utf8'));
const destination = path.join(root, 'public/vendor/libmedia');
const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(require.resolve('@libmedia/avplayer')), '../..');
const upstreamPackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
if (upstreamPackage.version !== manifest.version) {
  throw new Error(`Expected libmedia ${manifest.version}, got ${upstreamPackage.version}. Run npm ci.`);
}

await mkdir(destination, { recursive: true });
const jsFiles = [];
for (const name of await readdir(path.join(packageRoot, 'dist/esm'))) {
  if (!name.endsWith('.js')) continue;
  let bytes = await readFile(path.join(packageRoot, 'dist/esm', name));
  if (name === 'avplayer.js') bytes = Buffer.from(patchLibmedia(bytes.toString('utf8')));
  await writeFile(path.join(destination, name), bytes);
  jsFiles.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await copyFile(path.join(packageRoot, 'COPYING.LGPLv3'), path.join(destination, 'COPYING.LGPLv3'));
await copyFile(path.join(root, 'LICENSE'), path.join(destination, 'COPYING.GPLv3'));
await mkdir(path.join(destination, 'licenses'), { recursive: true });
for (const name of await readdir(path.join(root, 'docs/licenses'))) {
  await copyFile(path.join(root, 'docs/licenses', name), path.join(destination, 'licenses', name));
}
await copyFile(path.join(root, 'docs/THIRD_PARTY.md'), path.join(destination, 'THIRD_PARTY.md'));

function validate(bytes, entry) {
  const gitHash = createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
  if (bytes.length !== entry.bytes || gitHash !== entry.gitBlobSha1 || (entry.sha256 && sha256(bytes) !== entry.sha256)) {
    throw new Error(`Integrity check failed: ${entry.path}`);
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
    throw new Error(`Not a WebAssembly binary: ${entry.path}`);
  }
}

async function download(entry) {
  const target = path.join(destination, 'wasm', entry.path);
  try {
    const cached = await readFile(target);
    validate(cached, entry);
    return { ...entry, sha256: sha256(cached) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`${entry.path}: cached asset will be replaced (${error.message})`);
  }
  const url = `https://raw.githubusercontent.com/zhaohappy/libmedia/${manifest.revision}/dist/${entry.path}`;
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${entry.path}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      validate(bytes, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      return { ...entry, sha256: sha256(bytes) };
    } catch (error) { failure = error; }
  }
  throw failure;
}

// Limited build-time download parallelism; player downloads only the codecs
// needed by the current media. There are no runtime requests to public CDNs.
const remaining = [...manifest.files];
const wasmFiles = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (remaining.length) {
    const entry = remaining.shift();
    wasmFiles.push(await download(entry));
  }
}));
wasmFiles.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify({
  engine: manifest.engine,
  version: manifest.version,
  revision: manifest.revision,
  patchVersion: PATCH_VERSION,
  originalJavaScriptSha256: ORIGINAL_SHA256,
  javascript: jsFiles,
  wasm: wasmFiles,
}, null, 2)}\n`);
console.log(`Prepared libmedia ${manifest.version}: ${jsFiles.length} JavaScript modules, ${wasmFiles.length} verified WASM assets (${(wasmFiles.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024).toFixed(1)} MiB; loaded on demand).`);
