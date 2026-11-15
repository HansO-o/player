import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = new URL('../public/fixtures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));

test('committed audiovisual fixtures match their recorded bytes and SHA-256', async () => {
  for (const item of manifest.fixtures) {
    const bytes = await readFile(new URL(item.file, directory));
    assert.equal(bytes.length, item.bytes, item.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.file);
    if (item.video) {
      assert.equal(item.video.width, 320);
      assert.equal(item.video.height, 180);
      assert.equal(item.video.frameRate, '24/1');
    }
    assert.equal(item.audio.channels, 2);
    assert.equal(item.audio.sampleRate, 48000);
    assert.ok(item.duration >= 5 && item.duration < 5.1);
  }
  assert.ok(manifest.fixtures.some(item => item.video?.codec === 'hevc' && item.audio.codec === 'aac'));
  assert.ok(manifest.fixtures.some(item => item.video?.codec === 'av1' && item.audio.codec === 'opus'));
  assert.ok(manifest.fixtures.some(item => !item.video && item.audio.codec === 'aac'));
  assert.ok(manifest.fixtures.some(item => !item.video && item.audio.codec === 'opus'));
});
