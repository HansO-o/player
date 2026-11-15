import { createHash } from 'node:crypto';

export const ORIGINAL_SHA256 = '641018eb119847468d9ab61779356cc837cd984d395f007de9f2e354f862cfa6';
export const PATCH_VERSION = 2;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Auditable, exact-version-only patch. The upstream ESM bundle is deliberately
 * kept external: do not run the upstream package through another bundler.
 *
 * 1. Send the optional decoder thread budget through the existing worker RPC.
 * 2. Consume our private option BEFORE FFmpeg receives its dictionary.
 * 3. Expose actual decoder selection / thread allocation for diagnostics.
 *
 * The MPEG reference-frame scheduler and audio pipeline are unmodified.
 * Changing an upstream release requires reviewing these anchors and its hash.
 */
export function patchLibmedia(source) {
  if (sha256(source) !== ORIGINAL_SHA256) {
    throw new Error('Unexpected libmedia ESM hash. Refusing to patch an unreviewed upstream build.');
  }
  const patches = [
    [
      'async checkUseMSE(e){',
      'async checkUseMSE(e){if(this.options.octoForceWasm)return false;',
    ],
    [
      'this.VideoDecoderThread.open(this.taskId,(0,j.Wu)(r.codecpar))',
      'this.VideoDecoderThread.open(this.taskId,(0,j.Wu)(r.codecpar),{octoThreadCount:this.options.octoThreadCount})',
    ],
    [
      'let s=await e.softwareDecoder.open(t,i,e.wasmDecoderOptions)',
      'if(e.wasmDecoderOptions&&e.wasmDecoderOptions.octoThreadCount){const n=Number(e.wasmDecoderOptions.octoThreadCount);if(Number.isFinite(n)&&n>=1)i=Math.min(Math.floor(n),navigator.hardwareConcurrency||1)}if(e.wasmDecoderOptions)delete e.wasmDecoderOptions.octoThreadCount;if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==="undefined")i=1;e.octoThreadCount=i;let s=await e.softwareDecoder.open(t,i,e.wasmDecoderOptions)',
    ],
    [
      'async setNextDiscard(e){',
      'async getOctoDecodeStatus(e){const t=this.tasks.get(e);if(!t||!t.targetDecoder)return null;const i=t.targetDecoder instanceof D.A;return{decoder:i?"webcodecs":"wasm",hardwarePreference:i?(t.targetDecoder===t.hardwareDecoder?"prefer-hardware":"prefer-software"):null,threads:i?null:(t.octoThreadCount||1)}}async setNextDiscard(e){',
    ],
    [
      'async setSkipRender(e,t){',
      'async getOctoRenderStatus(e){const t=this.tasks.get(e);if(!t||!t.render)return null;return t.render.device?"webgpu":t.render.gl?"webgl":t.render.context?"canvas2d":null}async setSkipRender(e,t){',
    ],
  ];
  for (const [before, after] of patches) {
    if (source.split(before).length !== 2) {
      throw new Error(`libmedia patch anchor is missing or ambiguous: ${before.slice(0,80)}`);
    }
    source = source.replace(before, after);
  }
  return `/* Octo Player: libmedia 1.3.1, audited threading/diagnostics patch v${PATCH_VERSION}. LGPL-3.0-or-later. See docs/THIRD_PARTY.md and scripts/patch-libmedia.mjs. */\n${source}`;
}
