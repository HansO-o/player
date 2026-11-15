const SIMD_PROBE = new Uint8Array([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11,
]);

export function threadBudget(capabilities, profile = 'balanced', requested) {
  if (!capabilities.sharedArrayBuffer || !capabilities.crossOriginIsolated) return 1;
  const cores = Math.max(1, Math.floor(capabilities.hardwareConcurrency || 2));
  if (Number.isFinite(requested)) return Math.max(1, Math.min(cores, Math.floor(requested)));
  // A browser's logical CPU count is a ceiling, not a measured optimum.
  return profile === 'max' ? cores : Math.min(8, Math.max(1, cores - (cores > 2 ? 1 : 0)));
}

export function detectCapabilities(environment = globalThis) {
  const nav = environment.navigator || {};
  let simd = false;
  try { simd = environment.WebAssembly?.validate(SIMD_PROBE) || false; } catch { /* wasm disabled */ }
  const audioContext = environment.AudioContext || environment.webkitAudioContext;
  return {
    secureContext: Boolean(environment.isSecureContext),
    crossOriginIsolated: environment.crossOriginIsolated === true,
    sharedArrayBuffer: typeof environment.SharedArrayBuffer === 'function',
    wasm: typeof environment.WebAssembly === 'object',
    simd,
    worker: typeof environment.Worker === 'function',
    offscreenCanvas: typeof environment.OffscreenCanvas === 'function',
    webCodecsVideo: typeof environment.VideoDecoder === 'function',
    webCodecsAudio: typeof environment.AudioDecoder === 'function',
    webgpu: Boolean(nav.gpu),
    webgl2: typeof environment.WebGL2RenderingContext === 'function',
    webgl: typeof environment.WebGLRenderingContext === 'function',
    audioWorklet: Boolean(audioContext && environment.AudioWorkletNode),
    mediaSource: Boolean(environment.MediaSource || environment.ManagedMediaSource),
    hardwareConcurrency: Math.max(1, Number(nav.hardwareConcurrency) || 2),
    deviceMemoryGiB: Number(nav.deviceMemory) || null,
    userAgent: nav.userAgent || '',
  };
}

export async function queryDecodingSupport({ contentType, width, height, bitrate, framerate }, environment = globalThis) {
  if (!contentType || !environment.navigator?.mediaCapabilities?.decodingInfo) return null;
  try {
    const result = await environment.navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: { contentType, width, height, bitrate, framerate },
    });
    return { supported: result.supported, smooth: result.smooth, powerEfficient: result.powerEfficient };
  } catch { return null; }
}
