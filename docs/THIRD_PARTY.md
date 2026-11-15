# Third-party playback engine and binary provenance

## License of this distribution

This repository and its combined playback distribution are **GPL-3.0-or-later**;
the complete GPLv3 text is in [`../LICENSE`](../LICENSE).

The JavaScript playback engine `@libmedia/avplayer` declares
**LGPL-3.0-or-later**, but the upstream FFmpeg decoder build script used for the
distributed WASM assets enables `--enable-gpl` and `--enable-version3`.
Accordingly, this project does **not** describe the combined bundle as MIT or as
LGPL-only. Preserve this notice, the license texts, and the corresponding source
and build instructions when redistributing it. This player does not include
x264/x265 encoders or any server-side transcoding service.

## Pinned components

| Component | Exact version / source revision | Role and license |
| --- | --- | --- |
| libmedia / AVPlayer | npm `@libmedia/avplayer@1.3.1`; Git `152f629d3021fd8013efa464fcb7b55f9fbe7753` | Demuxing, Workers, WebCodecs, render scheduling, audio output; LGPL-3.0-or-later |
| FFmpeg fork | `zhaohappy/FFmpeg`, `a216f26d6ed993bdc12d842cdab3f91bd0b31909` | HEVC and audio decoders, resampling; this build enables GPLv3 |
| dav1d | `videolan/dav1d`, `37155c11474c1812de6c96656fb167a67d307a37` | AV1 decoder; BSD-2-Clause |
| libvpx | `a40848c80f8a002f2f4225c1c16a34743cce54db` (`v1.14.1-315-ga40848c80`) | Additional VP8/VP9 decoding; BSD-style license |
| SoundTouch | `2.3.2`, source included in the pinned libmedia repository | Audio tempo/pitch handling; LGPL-2.1-or-later |
| `@libmedia/cheap` | npm `1.3.1`; libmedia submodule `85cc79e032cbd417e3bb4a218bdf26da537b970b` | Shared-memory/runtime support; MIT |
| `@libmedia/common` | npm `2.3.0`; libmedia submodule `00c9c3c481cf7c53ed252cec6ca2dc6e9732ea28` | Utilities; MIT |
| ass-compiler / assjs | exact npm versions in `package-lock.json` | Components present in upstream player bundle; MIT |

The FFmpeg revision is recovered from the pinned release's
[`ffversion.h`](upstream/ffversion.h), which records
`n7.0.1-8-ga216f26d6e`. The dav1d revision is recovered from the shipped AV1
binary's `1.4.1-63-g37155c11` version string. These are the available upstream
source provenance records; we have **not** performed a bit-for-bit rebuild of
all upstream binaries. The release does not record an exact Emscripten/LLVM
version, so it would be inaccurate to claim a fully reproducible compiler
toolchain. The binary identity itself is fully pinned and checked below.

## Source and build instructions

- [libmedia source at the pinned revision](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753)
- [FFmpeg source at the identified revision](https://github.com/zhaohappy/FFmpeg/tree/a216f26d6ed993bdc12d842cdab3f91bd0b31909)
- [dav1d source at the identified revision](https://github.com/videolan/dav1d/tree/37155c11474c1812de6c96656fb167a67d307a37)
- [libvpx source at the identified revision](https://github.com/webmproject/libvpx/tree/a40848c80f8a002f2f4225c1c16a34743cce54db)
- [SoundTouch source included in libmedia](https://github.com/zhaohappy/libmedia/tree/152f629d3021fd8013efa464fcb7b55f9fbe7753/packages/audiostretchpitch/src/clib/soundtouch)
- [Original WASM build guide](https://github.com/zhaohappy/libmedia/blob/152f629d3021fd8013efa464fcb7b55f9fbe7753/site/docs/guide/compile-wasm.en-US.md)
- Local copies: [`upstream/compile-wasm.md`](upstream/compile-wasm.md),
  [`upstream/build-ffmpeg-decoder.sh`](upstream/build-ffmpeg-decoder.sh),
  [`upstream/build-dav1d-lib.sh`](upstream/build-dav1d-lib.sh).

The upstream build uses sibling `emsdk`, `FFmpeg`, `dav1d`, and `libmedia`
directories, Emscripten, Meson/Ninja for dav1d, and the checked-in build scripts.
Check out the exact source revisions above, including libmedia's recursive
submodules. The scripts use `-O3`, SIMD and atomic variants, and separate codecs.
The JavaScript patch used here is distributed in preferred source form as
[`../scripts/patch-libmedia.mjs`](../scripts/patch-libmedia.mjs).

To reproduce this project's **asset assembly** from the pinned upstream
artifacts (without recompiling C/C++):

```sh
npm ci
npm run assets
npm run build
```

`scripts/libmedia-assets.json` pins the upstream Git revision, byte size, Git
blob SHA-1 and SHA-256 of every downloaded WASM file. `prepare-assets.mjs`
verifies those values and the WASM magic bytes. An incorrect or truncated
download fails the build. Verified cached files can be reused offline; otherwise
the build downloads from the pinned raw GitHub revision. There are no
`@latest` references or runtime public-CDN dependencies.

## Asset footprint

51 WASM files total approximately **29.4 MiB** before HTTP compression. This is
the deployable asset collection, **not** the browser's startup download.
It contains scalar, atomic and SIMD variants of HEVC, AV1, H.264, VP8, VP9,
AAC, Opus, MP3, FLAC, Vorbis, AC-3, E-AC-3, DTS, PCM and ADPCM, plus resampling
and audio tempo modules. The engine selects a compatible variant and fetches
only the codecs required by the selected source. Native `<video>` playback
never imports the fallback engine.

The important SIMD binaries are HEVC **1,187,929 bytes**, AV1 **917,671 bytes**,
AAC **725,214 bytes** and Opus **714,351 bytes**. Audio playback also requests
resampling and tempo modules. The raw ESM player and its split worker modules
are copied together without re-bundling; changing their relative layout breaks
upstream dynamic imports.

## Audited JavaScript patch

The original `dist/esm/avplayer.js` SHA-256 must be:

```text
641018eb119847468d9ab61779356cc837cd984d395f007de9f2e354f862cfa6
```

The preparation script rejects any other input. Each patch anchor must occur
exactly once. The deployed `vendor/libmedia/manifest.json` records both that
input hash and the output hash; changing upstream versions requires a new
review, not a best-effort patch.

The changes are deliberately limited:

1. An explicit WASM benchmark mode cannot silently select MSE. Upstream normally
   returns MSE before calling the supplied mode callback when WebGL is missing.
   The adapter reports missing graphics support as an error.
2. An optional decoder thread budget travels through the existing worker RPC.
   It is removed from the FFmpeg option dictionary before opening the decoder.
   The budget is capped at the browser's reported logical CPU count, and at one
   without cross-origin isolation / shared memory. Leaving it undefined retains
   upstream's resolution-based thread policy.
3. Two read-only worker RPCs report the actual decoder object, allocated decoder
   thread count and active renderer context. A failed/unavailable diagnostic
   returns an unknown value and does not interrupt playback. WebCodecs
   `prefer-hardware` remains a **preference**, not proof of physical hardware use.
4. The media FetchIOLoader has a scoped header/read-idle timeout (15 seconds by
   default, configurable with `fetchTimeoutMs`). Each successful network read
   resets the idle deadline, so this is not a maximum movie duration. A timeout
   aborts the actual request; the adapter never replaces global `fetch`.
5. Cancellation aborts an IO task without deleting its IPC channel. This also
   fixes an upstream `abort()` early return that previously failed to abort a
   request waiting for headers. The original demux operation is allowed to
   settle before the adapter releases its shared memory. Cancellation gates
   cover the interval before an IO task has been registered.
6. A real transferred-canvas Worker probe checks WebGL clear/readback rather
   than assuming that `OffscreenCanvas` API presence implies Worker graphics
   support. If the probe fails, a scoped capability setter enables upstream's
   existing main-thread renderer and prevents an unusable canvas transfer.
   Cross-origin-isolated video decoding stays in its separate Worker. Without
   shared memory and without Worker WebGL, upstream needs to keep video decode
   and render together on the main thread; audio and IO can still use Workers.

URLs with no recognizable filename extension use the demuxer's file-content
probe (`ext: 'bin'`), bypassing upstream's separate playlist-guessing request.
For HLS/DASH URLs with opaque paths, supply `ext: 'm3u8'` / `ext: 'mpd'` or the
correct MIME type. Media fetch cancellation does not cancel the browser's ES
module import or compilation of already-requested WASM engine resources.

The audio master clock, FFmpeg dependency handling, AV1 reference frames and
upstream adaptive non-reference-frame discard remain intact. There is no
invented `maxFPS` engine setting. Reducing rendering work alone cannot overcome
insufficient decoding throughput. More threads are not inherently faster and
can increase memory use, thermal throttling and scheduling overhead.

## Graphics and audio behavior

WASM YUV frames use WebGPU or WebGL; WebCodecs frames can also use Canvas2D.
The GPU context can run on the main thread when Worker graphics are unavailable;
the diagnostic `workerGraphics` records the actual probe outcome.
This upstream release does **not** provide a scalar YUV-to-Canvas2D fallback
when both WebGL and WebGPU are disabled. A headless browser without a working
graphics context therefore cannot validate the WASM video path, even if it can
play the same file with its native media pipeline. Such a result must be
reported as an environmental limitation, not a successful WASM test.

Audio uses a separate decode/render pipeline and AudioWorklet (with upstream's
fallback where necessary), resampling, channel handling and tempo adjustment.
The adapter requests the audio master clock and preserves unplayed audio when
video presentation falls behind. It exports actual decoded/rendered audio
frame counters and the AudioContext state for functional testing. MSE counters
that cannot prove decoding are reported as `null`.

The first AudioContext is created/resumed synchronously in the caller's play
gesture, before asynchronous worker setup. The adapter allows up to two seconds
for the audio backend to enter `running`; a denied or unavailable audio backend
pauses and reports `NotAllowedError` rather than silently claiming audible
playback. Destroying the final player stops shared pipelines and closes the
captured AudioContext; new instances wait for that cleanup before starting.

## License texts

- [`libmedia-LGPL-3.0.txt`](licenses/libmedia-LGPL-3.0.txt)
- [`dav1d-BSD-2-Clause.txt`](licenses/dav1d-BSD-2-Clause.txt)
- [`libvpx-BSD.txt`](licenses/libvpx-BSD.txt)
- [`FFmpeg-and-SoundTouch-LGPL-2.1.txt`](licenses/FFmpeg-and-SoundTouch-LGPL-2.1.txt)
- [`cheap-MIT.txt`](licenses/cheap-MIT.txt)
- [`common-MIT.txt`](licenses/common-MIT.txt)
- [`ass-compiler-MIT.txt`](licenses/ass-compiler-MIT.txt)
- [`assjs-MIT.txt`](licenses/assjs-MIT.txt)
- Root [`LICENSE`](../LICENSE): full GPLv3 for this combined distribution.
