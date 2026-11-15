import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function prepare(page, fetchTimeoutMs) {
  await page.goto('/test/e2e/harness.html');
  await page.waitForFunction(() => window.__ready);
  await page.evaluate(timeout => window.createPlayer({ mode: 'wasm', renderer: 'webgl', fetchTimeoutMs: timeout }), fetchTimeoutMs);
}

async function beginLoad(page, url) {
  await page.evaluate(source => {
    window.__networkLoadResult = null;
    window.__networkLoadPromise = window.player.load(source).then(
      () => window.__networkLoadResult = { status: 'fulfilled' },
      error => window.__networkLoadResult = { status: 'rejected', name: error.name, message: error.message },
    );
  }, url);
}

async function serverState(request, id) {
  return (await request.get(`/test/e2e/network/status?id=${id}`)).json();
}

for (const mode of ['headers', 'get-headers', 'body']) {
  for (const action of ['destroy', 'replace']) {
    test(`HTTP ${mode} stall is cancelled by ${action}`, async ({ page, request }, testInfo) => {
      const id = randomUUID();
      await prepare(page, 15000);
      // No file suffix: also exercises the generic URL demux path rather than
      // the bounded MP4 pre-probe. This request must reach libmedia's IO loader.
      await beginLoad(page, `/test/e2e/network/${mode}?id=${id}`);
      await expect.poll(async () => (await serverState(request, id)).active).toBeGreaterThan(0);
      const before = await serverState(request, id);
      expect(before.methods).toContain(mode === 'headers' ? 'HEAD' : 'GET');
      if (mode === 'body') expect(before.firstByteSent).toBe(true);
      await page.evaluate(operation => {
        window.__networkActionResult = null;
        const promise = operation === 'destroy' ? window.player.destroy() : window.player.load('/fixtures/tone-aac.m4a');
        promise.then(
          () => window.__networkActionResult = { status: 'fulfilled' },
          error => window.__networkActionResult = { status: 'rejected', name: error.name, message: error.message },
        );
      }, action);
      await expect.poll(() => page.evaluate(() => window.__networkActionResult), { timeout: 7000 }).not.toBeNull();
      expect(await page.evaluate(() => window.__networkActionResult)).toEqual({ status: 'fulfilled' });
      await expect.poll(() => page.evaluate(() => window.__networkLoadResult), { timeout: 3000 }).not.toBeNull();
      expect(await page.evaluate(() => window.__networkLoadResult)).toMatchObject({ status: 'rejected', name: 'AbortError' });
      await expect.poll(async () => (await serverState(request, id)).active, { timeout: 3000 }).toBe(0);
      expect(await page.evaluate(() => window.__events.filter(entry => entry.event === 'error'))).toEqual([]);
      expect(await page.evaluate(() => window.player.state)).toBe(action === 'destroy' ? 'destroyed' : 'ready');
      if (action === 'replace') expect(await page.evaluate(() => window.player.getDiagnostics().metadata.hasAudio)).toBe(true);
      const evidence = { mode, action, before, after: await serverState(request, id), result: await page.evaluate(() => window.__networkLoadResult) };
      await testInfo.attach('network-cancellation-evidence', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
      console.log('NETWORK_EVIDENCE', JSON.stringify(evidence));
    });
  }

  test(`HTTP ${mode} stall rejects with a bounded timeout`, async ({ page, request }, testInfo) => {
    const id = randomUUID();
    await prepare(page, 200);
    await beginLoad(page, `/test/e2e/network/${mode}?id=${id}`);
    await expect.poll(() => page.evaluate(() => window.__networkLoadResult), { timeout: 7000 }).not.toBeNull();
    const result = await page.evaluate(() => window.__networkLoadResult);
    expect(result).toMatchObject({ status: 'rejected', name: 'TimeoutError' });
    const server = await serverState(request, id);
    expect(server.opened).toBeGreaterThan(0);
    if (mode === 'body') expect(server.firstByteSent).toBe(true);
    await expect.poll(async () => (await serverState(request, id)).active, { timeout: 3000 }).toBe(0);
    expect(await page.evaluate(() => window.player.state)).toBe('error');
    await testInfo.attach('network-timeout-evidence', { body: Buffer.from(JSON.stringify({ mode, result, server }, null, 2)), contentType: 'application/json' });
    console.log('NETWORK_EVIDENCE', JSON.stringify({ mode, result, server }));
  });
}
