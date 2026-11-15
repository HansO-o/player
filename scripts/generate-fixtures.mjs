#!/usr/bin/env node
/**
 * Generate original, deliberately small audiovisual integration fixtures.
 * Requires FFmpeg with libx265, libaom-av1, libx264 and libopus encoders.
 * This generates media, not performance benchmarks or third-party samples.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'public/fixtures');
const duration = 5;
const common = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${duration}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
  '-map', '0:v:0', '-map', '1:a:0', '-t', String(duration),
  '-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1',
  '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
  '-map_metadata', '-1', '-metadata', 'title=Octo Player original test pattern',
];
const audioCommon = [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
  '-t', String(duration), '-threads', '2', '-map_metadata', '-1',
  '-fflags', '+bitexact', '-flags:a', '+bitexact',
];
const fixtures = [
  {
    file: 'hevc-aac.mp4', videoCodec: 'hevc', audioCodec: 'aac', pixelFormat: 'yuv420p',
    args: ['-c:v', 'libx265', '-preset', 'fast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-x265-params', 'pools=1:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:bframes=3:log-level=error',
      '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart'],
  },
  {
    file: 'av1-opus.webm', videoCodec: 'av1', audioCodec: 'opus', pixelFormat: 'yuv420p',
    args: ['-c:v', 'libaom-av1', '-cpu-used', '8', '-crf', '40', '-b:v', '0',
      '-row-mt', '1', '-tiles', '1x1', '-g', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '64k', '-ac', '2'],
  },
  {
    file: 'hevc10-aac.mp4', videoCodec: 'hevc', audioCodec: 'aac', pixelFormat: 'yuv420p10le',
    args: ['-c:v', 'libx265', '-preset', 'fast', '-crf', '30', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'pools=1:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:bframes=3:log-level=error',
      '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart'],
  },
  {
    file: 'h264-aac.mp4', videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p',
    args: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-bf', '3',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart'],
  },
  {
    file: 'tone-aac.m4a', videoCodec: null, audioCodec: 'aac', audioOnly: true,
    args: ['-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart'],
  },
  {
    file: 'tone-opus.ogg', videoCodec: null, audioCodec: 'opus', audioOnly: true,
    args: ['-c:a', 'libopus', '-b:a', '64k', '-ac', '2'],
  },
];

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

await mkdir(directory, { recursive: true });
const manifest = {
  description: 'Original procedural moving test pattern with a 440 Hz sine wave. Functional fixtures; not performance benchmarks.',
  license: 'CC0-1.0',
  generator: run('ffmpeg', ['-version']).split('\n')[0],
  regenerate: 'npm run fixtures',
  fixtures: [],
};
for (const fixture of fixtures) {
  const destination = path.join(directory, fixture.file);
  run('ffmpeg', [...(fixture.audioOnly ? audioCommon : common), ...fixture.args, destination]);
  const bytes = await readFile(destination);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination]));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  if ((video?.codec_name ?? null) !== fixture.videoCodec || audio?.codec_name !== fixture.audioCodec || (!fixture.audioOnly && video.pix_fmt !== fixture.pixelFormat)) {
    throw new Error(`Unexpected output stream metadata for ${fixture.file}`);
  }
  manifest.fixtures.push({
    file: fixture.file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    video: video ? { codec: video.codec_name, profile: video.profile, pixelFormat: video.pix_fmt, width: video.width, height: video.height, frameRate: video.r_frame_rate } : null,
    audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, signalHz: 440 },
    duration: Number(probe.format.duration),
  });
  process.stdout.write(`${fixture.file}: ${bytes.length} bytes, ${video?.codec_name || 'no video'} + ${audio.codec_name}\n`);
}
await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
