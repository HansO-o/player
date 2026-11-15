import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { threadBudget, detectCapabilities } from '../src/core/capabilities.js';
import { normalizeSource, serializableSource } from '../src/core/source.js';
import { parseMoov, probeMp4 } from '../src/core/mp4-probe.js';
import { PerformanceMonitor } from '../src/core/performance.js';
import { patchLibmedia } from '../scripts/patch-libmedia.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';

test('thread budgets respect real concurrency and isolation', () => {
  const caps = { crossOriginIsolated: true, sharedArrayBuffer: true, hardwareConcurrency: 12 };
  assert.equal(threadBudget(caps, 'max'), 12);
  assert.equal(threadBudget(caps, 'balanced'), 8);
  assert.equal(threadBudget(caps, 'max', 1000), 12);
  assert.equal(threadBudget({ ...caps, crossOriginIsolated: false }, 'max'), 1);
  assert.equal(threadBudget({ ...caps, hardwareConcurrency: 1 }, 'max'), 1);
  assert.equal(detectCapabilities({ WebAssembly }).simd, true);
});

test('normalization rejects executable protocols and diagnostics omit access tokens', () => {
  assert.throws(() => normalizeSource('javascript:alert(1)'), /HTTP/);
  assert.throws(() => normalizeSource('file:///etc/passwd'), /HTTP/);
  const source = normalizeSource('/film.mp4?token=private-value', 'https://example.com/');
  assert.equal(source.mime, 'video/mp4');
  assert.equal(source.input, 'https://example.com/film.mp4?token=private-value');
  assert.ok(!JSON.stringify(serializableSource(source)).includes('private-value'));
});

test('MP4 probe locates video and audio tracks in a real B-frame HEVC file', async () => {
  const bytes = await readFile(new URL('../public/fixtures/hevc-aac.mp4', import.meta.url));
  const source = normalizeSource(new File([bytes], 'sample.mp4', { type: 'video/mp4' }));
  const probe = await probeMp4(source);
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.ok(probe.tracks.some(t => t.codec === 'hvc1'));
  assert.ok(probe.tracks.some(t => t.codec === 'mp4a'));
  assert.equal(parseMoov(new Uint8Array([0, 0, 0, 0])), null);
});

test('monitor counts stalls only once and does not label paused throughput as pressure', () => {
  const monitor = new PerformanceMonitor();
  monitor.state('buffering', 100); monitor.state('buffering', 200); monitor.state('playing', 600);
  assert.equal(monitor.stalls, 1); assert.equal(monitor.stallMs, 500);
  monitor.sample({ renderedFrames: 10, droppedFrames: 0, state: 'playing', paused: false }, 0);
  const second = monitor.sample({ renderedFrames: 40, droppedFrames: 0, state: 'playing', paused: false }, 1000);
  assert.equal(second.intervalFps, 30);
  const seek = monitor.sample({ renderedFrames: 0, droppedFrames: 0, state: 'paused', paused: true }, 2000);
  assert.equal(seek.intervalFps, null);
  assert.equal(monitor.pressure(seek), null);
});

test('third-party threading patch is version gated and reproducible', async () => {
  const require = createRequire(import.meta.url);
  const packageRoot = path.resolve(path.dirname(require.resolve('@libmedia/avplayer')), '../..');
  const upstream = await readFile(path.join(packageRoot, 'dist/esm/avplayer.js'), 'utf8');
  const patched = patchLibmedia(upstream);
  assert.match(patched, /getOctoDecodeStatus/);
  assert.match(patched, /octoThreadCount/);
  assert.equal(patchLibmedia(upstream), patched);
  assert.throws(() => patchLibmedia(`${upstream}\n`), /hash/);
});
