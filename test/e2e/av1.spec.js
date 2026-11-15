import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

// This focused gate distinguishes source IO from decoder thread scheduling.
// Repetitions are separate fresh-player cases, never retries of a failed case.
async function installAudioObservation(page) {
  await page.addInitScript(() => {
    window.__av1AudioPeak = 0;
    window.__av1AudioTaps = [];
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
        window.__av1AudioTaps.push({ analyser, samples: new Float32Array(1024) });
      }
      return result;
    };
    setInterval(() => {
      for (const tap of window.__av1AudioTaps) {
        tap.analyser.getFloatTimeDomainData(tap.samples);
        for (const value of tap.samples) window.__av1AudioPeak = Math.max(window.__av1AudioPeak, Math.abs(value));
      }
    }, 50);
  });
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('invalid AV1 payload reports one terminal error and stops playback', async ({ page }, testInfo) => {
  await page.goto('/test/e2e/harness.html');
  await page.waitForFunction(() => window.__ready);
  try {
    await page.evaluate(async () => {
      await window.createPlayer({ mode: 'wasm', renderer: 'webgl', debug: true });
      const bytes = new Uint8Array(await (await fetch('/fixtures/av1-opus.webm')).arrayBuffer());
      // ffprobe identifies packet 2's SimpleBlock at 3510, with a four-byte
      // block header. Set the AV1 OBU forbidden bit in its actual payload.
      if (bytes[3514] !== 0x32) throw new Error('Unexpected fixture packet layout');
      bytes[3514] = 0xff;
      await window.player.load(new File([bytes], 'invalid-av1.webm', { type: 'video/webm' }));
      document.querySelector('#play').addEventListener('click', () => window.__playPromise.catch(() => {}), { once: true });
    });
    await page.locator('#play').click();
    await page.evaluate(() => window.__playPromise.catch(() => {}));
    await expect.poll(() => page.evaluate(() => window.player.state)).toBe('error');
    await expect.poll(() => page.evaluate(() => window.player.paused)).toBe(true);
    const errors = await page.evaluate(() => window.__events.filter(entry => entry.event === 'error').map(entry => ({ name: entry.detail.error?.name, code: entry.detail.code })));
    expect(errors).toEqual([{ name: 'DecodeError', code: -1094995529 }]);
    expect(await page.evaluate(() => window.player.getStats().decodeErrors)).toBeGreaterThan(0);
    await page.evaluate(async () => {
      await window.player.pause().catch(() => {});
      await window.player.seek(2).catch(() => {});
      await window.player.play().catch(() => {});
    });
    await page.waitForTimeout(400);
    const stoppedAt = await page.evaluate(() => window.player.currentTime);
    await page.waitForTimeout(400);
    expect(Math.abs(await page.evaluate(() => window.player.currentTime) - stoppedAt)).toBeLessThan(0.15);
    expect(await page.evaluate(() => window.player.state)).toBe('error');
    expect(await page.evaluate(() => window.__events.filter(entry => entry.event === 'error').length)).toBe(1);
  } finally {
    const evidence = await page.evaluate(() => ({ stats: window.player.getStats(), events: window.__events }));
    await testInfo.attach('invalid-payload-evidence', { body: Buffer.from(JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)), contentType: 'application/json' });
  }
});

for (const sourceType of ['http', 'file']) {
  for (const threads of [1, 2]) {
    for (const repetition of [1, 2, 3]) {
      test(`AV1 complete playback: ${sourceType}, ${threads} decoder threads, case ${repetition}`, async ({ page }, testInfo) => {
        const consoleMessages = [];
        const pageErrors = [];
        page.on('console', message => {
          const text = message.text();
          if (['warning', 'error'].includes(message.type()) || /packet|decod.*error|error.*decod/i.test(text)) {
            consoleMessages.push({ type: message.type(), text, location: message.location() });
          }
        });
        page.on('pageerror', error => pageErrors.push({ name: error.name, message: error.message, stack: error.stack }));
        await installAudioObservation(page);
        await page.goto('/test/e2e/harness.html');
        await page.waitForFunction(() => window.__ready);
        try {
          await page.evaluate(async ({ sourceType, threads, repetition }) => {
            // The first case collects bounded packet diagnostics; the other
            // cases verify the production path without instrumentation timing.
            await window.createPlayer({ mode: 'wasm', renderer: 'webgl', threads, debug: repetition === 1 });
            let source = '/fixtures/av1-opus.webm';
            if (sourceType === 'file') {
              const response = await fetch(source);
              if (!response.ok) throw new Error(`Fixture download failed: ${response.status}`);
              source = new File([await response.blob()], 'av1-opus.webm', { type: 'video/webm' });
            }
            await window.player.load(source);
          }, { sourceType, threads, repetition });
          await page.locator('#play').click();
          await page.evaluate(() => window.__playPromise);
          await page.waitForFunction(() => {
            const stats = window.player.getStats();
            return stats.decodeErrors > 0 || stats.renderedFrames > 10;
          }, null, { timeout: 12000 });
          const firstFrames = await page.evaluate(() => window.player.getStats());
          expect(firstFrames.decodeErrors, 'AV1 must not reject a valid input packet').toBe(0);
          expect(firstFrames.renderedFrames).toBeGreaterThan(10);
          await expect.poll(() => page.evaluate(() => window.__av1AudioPeak)).toBeGreaterThan(0.001);
          await expect.poll(() => page.evaluate(() => window.player.getStats().threads)).toBeGreaterThanOrEqual(1);
          const initial = await page.evaluate(() => window.player.getStats());
          expect(initial.decoder).toBe('wasm');
          expect(initial.threads).toBeLessThanOrEqual(threads);
          expect(initial.decodeErrors).toBe(0);
          expect(initial.audioDecodeErrors).toBe(0);
          expect(initial.audioContextState).toBe('running');

          const stage = page.locator('#stage');
          const before = digest(await stage.screenshot());
          const currentTime = await page.evaluate(() => window.player.currentTime);
          await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(currentTime + 0.3);
          expect(digest(await stage.screenshot()), 'AV1 must produce changing pixels').not.toBe(before);

          // Finish the entire clip: a first frame or a short successful prefix
          // must not hide a later decoder error followed by audio-only playback.
          await page.waitForFunction(() => {
            const stats = window.player.getStats();
            return window.player.state === 'ended' || window.player.state === 'error' || stats.decodeErrors > 0;
          }, null, { timeout: 20000 });
          const complete = await page.evaluate(() => window.player.getStats());
          expect(complete.state).toBe('ended');
          expect(complete.decodeErrors).toBe(0);
          expect(complete.audioDecodeErrors).toBe(0);
          expect(complete.renderedFrames).toBeGreaterThan(10);
          expect(complete.decodedFrames).toBeGreaterThan(10);
          expect(complete.currentTime).toBeGreaterThan(4.5);
          expect(complete.videoCurrentTime).toBeGreaterThan(4.5);
          expect(complete.audioOutputTime).toBeGreaterThan(4.5);
          expect(pageErrors).toEqual([]);
        } finally {
          const observation = await page.evaluate(() => ({
            stats: window.player?.getStats(), diagnostics: window.player?.getDiagnostics(),
            events: window.__events, audioPeak: window.__av1AudioPeak,
          })).catch(error => ({ observationError: error.message }));
          const evidence = { sourceType, requestedThreads: threads, repetition, debug: repetition === 1,
            browser: { name: testInfo.project.name, version: page.context().browser()?.version() },
            ...observation, consoleMessages, pageErrors };
          await testInfo.attach('av1-decoder-evidence', {
            body: Buffer.from(JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)),
            contentType: 'application/json',
          });
          console.log('AV1_EVIDENCE', JSON.stringify({ sourceType, threads, repetition,
            browser: testInfo.project.name, stats: observation.stats, audioPeak: observation.audioPeak,
            errors: consoleMessages.filter(item => item.type === 'error'), pageErrors },
          (_, value) => typeof value === 'bigint' ? value.toString() : value));
        }
      });
    }
  }
}
