import { test, expect } from '@playwright/test';

test('rapid play-pause-play honors the last transport request', async ({ page }) => {
  await page.goto('/test/e2e/harness.html');
  await page.waitForFunction(() => window.__ready);
  await page.evaluate(async () => {
    await window.createPlayer({ mode: 'wasm', renderer: 'webgl' });
    await window.player.load('/fixtures/hevc-aac.mp4');
  });
  await page.locator('#play').click();
  await page.evaluate(() => window.__playPromise);
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(0.25);
  await page.evaluate(async () => {
    await window.player.pause();
    const first = window.player.play();
    const middle = window.player.pause();
    const last = window.player.play();
    await Promise.all([first, middle, last]);
  });
  await expect.poll(() => page.evaluate(() => window.player.paused)).toBe(false);
  expect(await page.evaluate(() => window.player.state)).toBe('playing');
  const start = await page.evaluate(() => window.player.currentTime);
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(start + 0.2);
});
