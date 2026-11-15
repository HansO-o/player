# Original test clips

These small clips are generated from FFmpeg's moving `testsrc2` pattern and a
440 Hz sine wave. They contain no third-party video or audio. The project grants
its rights in these generated clips under **CC0-1.0**.

Run `npm run fixtures` to regenerate them using `scripts/generate-fixtures.mjs`.
FFmpeg must provide `libx265`, `libaom-av1`, `libx264`, AAC, and `libopus`.
Encoding uses a bounded thread count. FFmpeg versions may produce different
bytes; the script records the exact generator and recomputes SHA-256 hashes.

| File | Video | Audio | Purpose |
| --- | --- | --- | --- |
| `hevc-aac.mp4` | HEVC Main, 8-bit, `hvc1` | AAC stereo | WASM decode, MP4 seeking and B-frame ordering |
| `av1-opus.webm` | AV1 Main, 8-bit | Opus stereo | WASM decode and WebM seeking |
| `hevc10-aac.mp4` | HEVC Main 10, 10-bit | AAC stereo | 10-bit decode and rendering |
| `h264-aac.mp4` | H.264, 8-bit | AAC stereo | Native playback reference |
| `tone-aac.m4a` | None | AAC stereo | Audio-only WASM output |
| `tone-opus.ogg` | None | Opus stereo | Audio-only WASM output |

Video clips are 320×180, 24 fps. All files are about five seconds. They validate the media path;
they **do not establish 1080p or 4K performance**. The audible sine tone is
intentional. The manifest records codec, pixel format, duration and file hash.
