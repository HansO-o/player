import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

// Observe actual PCM reaching the audio graph without replacing its production
// path: the additional analyser branch has zero gain, so the original output
// stays audible exactly once. This is a functional check, not a CPU benchmark.
async function instrumentAudio(page) {
  await page.addInitScript(() => {
    window.__audioPeak = 0;
    window.__audioTaps = [];
    if (!globalThis.AudioNode || !globalThis.AudioDestinationNode) return;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
      const result = connect.call(this, destination, ...rest);
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 1024;
        const silent = this.context.createGain();
        silent.gain.value = 0;
        connect.call(this, analyser);
        connect.call(analyser, silent);
        connect.call(silent, destination);
        window.__audioTaps.push({ analyser, samples: new Float32Array(analyser.fftSize) });
      }
      return result;
    };
    setInterval(() => {
      for (const tap of window.__audioTaps) {
        tap.analyser.getFloatTimeDomainData(tap.samples);
        for (const sample of tap.samples) window.__audioPeak = Math.max(window.__audioPeak, Math.abs(sample));
      }
    }, 50);
  });
}

async function prepare(page, options = {}) {
  await instrumentAudio(page);
  await page.goto('/test/e2e/harness.html');
  await page.waitForFunction(() => window.__ready);
  await page.evaluate(settings => window.createPlayer(settings), { mode: 'wasm', renderer: 'webgl', ...options });
}

async function play(page, fixture) {
  await page.evaluate(source => window.player.load(source), `/fixtures/${fixture}`);
  await page.locator('#play').click();
  await page.evaluate(() => window.__playPromise);
}

async function stats(page) {
  return page.evaluate(() => window.player.getStats());
}

async function attachEvidence(page, testInfo, extra = {}) {
  const evidence = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    currentTime: window.player?.currentTime,
    duration: window.player?.duration,
    stats: window.player?.getStats(),
    diagnostics: window.player?.getDiagnostics(),
    audioPeak: window.__audioPeak,
    events: window.__events,
  }));
  await testInfo.attach('playback-evidence', {
    body: Buffer.from(JSON.stringify({ ...evidence, browser: { project: testInfo.project.name, version: page.context().browser()?.version(), hostPlatform: process.platform }, ...extra }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)),
    contentType: 'application/json',
  });
  console.log('PLAYBACK_EVIDENCE', JSON.stringify({ test: testInfo.title, browser: testInfo.project.name,
    decoder: evidence.stats?.decoder, renderer: evidence.stats?.renderer, threads: evidence.stats?.threads,
    videoFrames: evidence.stats?.renderedFrames, audioFrames: evidence.stats?.audioRenderedFrames,
    audioState: evidence.stats?.audioContextState, audioPeak: evidence.audioPeak,
    currentTime: evidence.currentTime, isolation: evidence.crossOriginIsolated }));
}

for (const fixture of ['hevc-aac.mp4', 'av1-opus.webm', 'hevc10-aac.mp4']) {
  test(`forced WASM produces moving pixels and audible PCM: ${fixture}`, async ({ page }, testInfo) => {
    await prepare(page);
    await play(page, fixture);
    try {
      await expect.poll(async () => (await stats(page)).renderedFrames).toBeGreaterThan(5);
      await expect.poll(async () => (await stats(page)).audioRenderedFrames).toBeGreaterThan(5);
      await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
      const snapshot = await stats(page);
      expect(snapshot.decoder).toMatch(/wasm/i);
      expect(snapshot.decodedFrames).toBeGreaterThan(0);
      expect(snapshot.audioDecodedFrames).toBeGreaterThan(0);
      expect(snapshot.audioContextState).toBe('running');
      expect(await page.evaluate(() => window.player.duration)).toBeGreaterThan(4.8);
      const stage = page.locator('#stage');
      const first = createHash('sha256').update(await stage.screenshot()).digest('hex');
      const at = await page.evaluate(() => window.player.currentTime);
      await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(at + 0.35);
      const second = createHash('sha256').update(await stage.screenshot()).digest('hex');
      expect(second, 'moving test pattern must change the rendered surface').not.toBe(first);
    } finally {
      await attachEvidence(page, testInfo, { fixture, requestedMode: 'wasm' });
    }
  });
}

for (const fixture of ['tone-aac.m4a', 'tone-opus.ogg']) {
  test(`forced WASM audio-only output: ${fixture}`, async ({ page }, testInfo) => {
    await prepare(page);
    try {
      await play(page, fixture);
      await expect.poll(async () => (await stats(page)).audioRenderedFrames).toBeGreaterThan(5);
      await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
      const snapshot = await stats(page);
      expect(snapshot.decoder).toMatch(/wasm/i);
      expect(snapshot.audioDecodedFrames).toBeGreaterThan(0);
      expect(snapshot.audioContextState).toBe('running');
      expect(snapshot.hasAudio).toBe(true);
      expect(await page.evaluate(() => window.player.getDiagnostics().metadata.hasVideo)).toBe(false);
    } finally {
      await attachEvidence(page, testInfo, { fixture, requestedMode: 'wasm', audioOnly: true });
    }
  });
}

test('maximum-performance WASM uses a bounded verified decoder thread count', async ({ page }, testInfo) => {
  await prepare(page, { performance: 'max' });
  await play(page, 'hevc-aac.mp4');
  await expect.poll(async () => (await stats(page)).renderedFrames).toBeGreaterThan(5);
  await expect.poll(async () => (await stats(page)).threads).toBeGreaterThanOrEqual(1);
  const snapshot = await stats(page);
  const diagnostics = await page.evaluate(() => window.player.getDiagnostics());
  expect(snapshot.threads).toBeLessThanOrEqual(diagnostics.requestedThreads);
  expect(snapshot.sharedMemory).toBe(true);
  expect(snapshot.decoder).toBe('wasm');
  await attachEvidence(page, testInfo, { requestedPerformance: 'max' });
});

for (const mode of ['native', 'wasm']) {
test(`${mode} pause, keyframe seek, resume and volume keep audio/video operational`, async ({ page }, testInfo) => {
  await prepare(page, { mode });
  await play(page, mode === 'native' ? 'h264-aac.mp4' : 'hevc-aac.mp4');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(0.5);
  await page.evaluate(() => window.player.pause());
  await expect.poll(() => page.evaluate(() => window.player.paused)).toBe(true);
  const pausedAt = await page.evaluate(() => window.player.currentTime);
  await page.waitForTimeout(300);
  expect(Math.abs(await page.evaluate(() => window.player.currentTime) - pausedAt)).toBeLessThan(0.15);
  await page.evaluate(async () => {
    window.player.setVolume(0.35);
    window.player.setMuted(true);
    await window.player.seek(2.4);
    window.player.setMuted(false);
  });
  await page.locator('#play').click();
  await page.evaluate(() => window.__playPromise);
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(2.5);
  if (mode === 'wasm') await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
  await attachEvidence(page, testInfo, { mode, seekTarget: 2.4, pausedAt });
});
}

test('a local File is decoded without uploading it', async ({ page }, testInfo) => {
  await prepare(page);
  const externalRequests = [];
  page.on('request', request => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) externalRequests.push(request.url());
  });
  await page.evaluate(async () => {
    const response = await fetch('/fixtures/av1-opus.webm');
    const blob = await response.blob();
    await window.player.load(new File([blob], 'local-av1-opus.webm', { type: 'video/webm' }));
  });
  await page.locator('#play').click();
  await page.evaluate(() => window.__playPromise);
  await expect.poll(async () => (await stats(page)).renderedFrames).toBeGreaterThan(5);
  await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
  expect(externalRequests).toEqual([]);
  await attachEvidence(page, testInfo, { sourceType: 'File', externalRequests });
});

test('native fast path does not download the WASM engine', async ({ page }, testInfo) => {
  const vendorRequests = [];
  page.on('request', request => {
    if (/\/vendor\/|\.wasm(?:\?|$)/.test(request.url())) vendorRequests.push(request.url());
  });
  await prepare(page, { mode: 'native' });
  const supported = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.64000c, mp4a.40.2"'));
  test.skip(!supported, 'This browser build has no native H.264/AAC support; this is not a WASM failure.');
  await play(page, 'h264-aac.mp4');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(0.3);
  expect(vendorRequests).toEqual([]);
  const snapshot = await stats(page);
  expect(snapshot.engine).toBe('native');
  await attachEvidence(page, testInfo, { fixture: 'h264-aac.mp4', vendorRequests });
});

test('auto recovers from a native decoder failure using the fallback engine', async ({ page }, testInfo) => {
  await prepare(page, { mode: 'auto' });
  const supported = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.64000c, mp4a.40.2"'));
  test.skip(!supported, 'Native codec support is needed to reach the fault injection boundary.');
  await page.evaluate(async () => {
    await window.player.load('/fixtures/h264-aac.mp4');
    if (window.player.getStats().engine !== 'native') throw new Error('Expected native engine before fault injection');
    // Fault injection is limited to the native boundary. The fallback must load
    // and play the real file; no decoder data or counters are mocked.
    window.player.engine.play = () => Promise.reject(new DOMException('Injected native decoder failure', 'NotSupportedError'));
  });
  await page.locator('#play').click();
  await page.evaluate(() => window.__playPromise);
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(0.3);
  const diagnostics = await page.evaluate(() => window.player.getDiagnostics());
  expect(diagnostics.engineHistory.map(entry => entry.engine)).toEqual(['native', 'libmedia']);
  expect(diagnostics.stats.engine).toBe('libmedia');
  await attachEvidence(page, testInfo, { faultInjection: 'native play() NotSupportedError' });
});

test('WASM still plays with cross-origin isolation unavailable', async ({ page }, testInfo) => {
  await page.route('**/test/e2e/harness.html', async route => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-embedder-policy'];
    await route.fulfill({ response, headers });
  });
  await prepare(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await play(page, 'hevc-aac.mp4');
  await expect.poll(async () => (await stats(page)).renderedFrames).toBeGreaterThan(5);
  await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
  await attachEvidence(page, testInfo, { isolationDeliberatelyDisabled: true });
});

test('WASM audio-only output without cross-origin isolation', async ({ page }, testInfo) => {
  await page.route('**/test/e2e/harness.html', async route => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-embedder-policy'];
    await route.fulfill({ response, headers });
  });
  await prepare(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  try {
    await play(page, 'tone-aac.m4a');
    await expect.poll(async () => (await stats(page)).audioDecodedFrames).toBeGreaterThan(5);
    await expect.poll(() => page.evaluate(() => window.__audioPeak)).toBeGreaterThan(0.001);
    expect((await stats(page)).decoder).toBe('wasm');
  } finally {
    await attachEvidence(page, testInfo, { isolationDeliberatelyDisabled: true, audioOnly: true });
  }
});

test('HTTP errors reject instead of reporting successful playback', async ({ page }, testInfo) => {
  await prepare(page);
  const error = await page.evaluate(async () => {
    try {
      await window.player.load('/fixtures/does-not-exist.mp4');
      await window.player.play();
      return null;
    } catch (cause) {
      return { name: cause.name, message: cause.message, code: cause.code };
    }
  });
  expect(error).not.toBeNull();
  expect(error.message).toBeTruthy();
  await attachEvidence(page, testInfo, { expectedError: error });
});
