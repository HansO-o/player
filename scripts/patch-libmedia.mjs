import { createHash } from 'node:crypto';

export const ORIGINAL_SHA256 = '641018eb119847468d9ab61779356cc837cd984d395f007de9f2e354f862cfa6';
export const PATCH_VERSION = 5;

// These are separate upstream demuxer chunks, not alternate player builds.
// Allocation-site fixes keep the pointer stable for asynchronous MP4 reads.
export const CHUNK_SHA256 = {
  '573.avplayer.js': 'ffcedb0645e22f598bb5b9b322fa24cdd3dec51a7ad992061defd186a946974d',
  '943.avplayer.js': 'b600831c9ab77fcbf5db6e9786d5ceb566071c344f243c0908fcd154c3599e78',
};

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
      'let e=r.A.offscreenCanvas;return(s.A.safari',
      'let e=r.A.offscreenCanvas&&r.A.octoWorkerWebGL!==false;return(s.A.safari',
    ],
    [
      '"Util",{compile:U.A,browser:b.A,os:k.A}',
      '"Util",{compile:U.A,browser:b.A,os:k.A,setWorkerRendererSupported(e){y.A.octoWorkerWebGL=!!e}}',
    ],
    [
      'async checkUseMSE(e){',
      'async checkUseMSE(e){if(this.options.octoForceWasm)return false;',
    ],
    [
      'this.VideoDecoderThread.open(this.taskId,(0,j.Wu)(r.codecpar))',
      'this.VideoDecoderThread.open(this.taskId,(0,j.Wu)(r.codecpar),{octoThreadCount:this.options.octoThreadCount,octoPacketDiagnostics:this.options.octoPacketDiagnostics})',
    ],
    [
      'let s=await e.softwareDecoder.open(t,i,e.wasmDecoderOptions)',
      'if(e.wasmDecoderOptions&&e.wasmDecoderOptions.octoThreadCount)e.octoRequestedThreadCount=Number(e.wasmDecoderOptions.octoThreadCount);if(Number.isFinite(e.octoRequestedThreadCount)&&e.octoRequestedThreadCount>=1)i=Math.min(Math.floor(e.octoRequestedThreadCount),navigator.hardwareConcurrency||1);if(e.wasmDecoderOptions){if(e.wasmDecoderOptions.octoPacketDiagnostics)e.octoPacketDiagnostics=true;delete e.wasmDecoderOptions.octoThreadCount;delete e.wasmDecoderOptions.octoPacketDiagnostics}if(!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==="undefined")i=1;let s=await e.softwareDecoder.open(t,i,e.wasmDecoderOptions)',
    ],
    [
      'async setNextDiscard(e){',
      // Hash only bounded debug samples. Payload copies are temporary, never
      // logged or returned over RPC. Hashing does not block the decode loop.
      'octoCapturePacket(e,t,i=null){const s=i===null?(e.octoPacketSequence=(e.octoPacketSequence||0)+1):e.octoPacketSequence;if(i===null&&s>12||i!==null&&e.octoFailedPacketRecorded)return null;if(i!==null)e.octoFailedPacketRecorded=true;const a=r.f[20](t+24),o=r.f[15](t+28),n={sequence:s,pts:String(r.f[17](t+8)),dts:String(r.f[17](t+16)),size:o,flags:r.f[15](t+36),paddingZero:(0,x.s3)(a+o,64).every(e=>e===0),sha256:null,decodeResult:i};(e.octoPackets||(e.octoPackets=[])).push(n);if(o>=0&&o<=1048576&&globalThis.crypto&&globalThis.crypto.subtle){const e=new Uint8Array((0,x.s3)(a,o));crypto.subtle.digest("SHA-256",e).then(e=>{n.sha256=Array.from(new Uint8Array(e),e=>e.toString(16).padStart(2,"0")).join("")}).catch(()=>{})}return n}async getOctoDecodeStatus(e){const t=this.tasks.get(e);if(!t||!t.targetDecoder)return null;const i=t.targetDecoder instanceof D.A;return{decoder:i?"webcodecs":"wasm",hardwarePreference:i?(t.targetDecoder===t.hardwareDecoder?"prefer-hardware":"prefer-software"):null,threads:i?null:(t.targetDecoder.octoAllocatedThreads??null),terminalError:t.octoTerminalDecodeError??null,packetDiagnostics:t.octoPackets||null}}async setNextDiscard(e){',
    ],
    [
      'let t=f.targetDecoder.decode(o);',
      'const octoPacket=f.octoPacketDiagnostics?this.octoCapturePacket(f,o):null;let t=f.targetDecoder.decode(o);if(octoPacket)octoPacket.decodeResult=t;',
    ],
    [
      'f.avpacketPool.release(o),M.z3(`video decode error, taskId: ${e.taskId}, ret: ${t}`',
      'if(f.octoPacketDiagnostics&&!octoPacket)this.octoCapturePacket(f,o,t);f.octoTerminalDecodeError=t;f.avpacketPool.release(o),M.z3(`video decode error, taskId: ${e.taskId}, ret: ${t}`',
    ],
    // A negative decode result is not EOF. Forward it once through the
    // existing renderer control port, including errors on the very first pull.
    [
      'async pullFrame(e){const t=await e.leftIPCPort.request("pull");return',
      'async pullFrame(e){const t=await e.leftIPCPort.request("pull");if(typeof t==="number"&&t<0&&t!==-1048576&&!e.octoTerminalError){e.octoTerminalError=t;e.controlIPCPort.notify("octoDecodeError",{code:t})}return',
    ],
    [
      'case"ended":this.observer.onVideoEnded();break;',
      'case"octoDecodeError":this.observer.onError(Object.assign(new Error("Video pipeline failed ("+e.params.code+")"),{name:"DecodeError",code:e.params.code,terminal:true,stage:"video-decode"}));break;case"ended":this.observer.onVideoEnded();break;',
    ],
    [
      'await this.decoder.run(void 0,t);let r=0;',
      'this.octoAllocatedThreads=t;await this.decoder.run(void 0,t);let r=0;',
    ],
    [
      'async setSkipRender(e,t){',
      'async getOctoRenderStatus(e){const t=this.tasks.get(e);if(!t||!t.render)return null;return t.render.device?"webgpu":t.render.gl?"webgl":t.render.context?"canvas2d":null}async setSkipRender(e,t){',
    ],
    // Keep cancellation scoped to this loader, rather than replacing fetch
    // globally. The timer covers waiting for headers or one stalled body read;
    // successfully arriving chunks reset the idle deadline.
    [
      'async getTotalSize(e){var t,i,r;',
      'octoTimeout(){return Math.max(100,Math.min(120000,Number(this.options.octoFetchTimeoutMs)||15000))}octoExpire(e){this.octoTimedOut=true;this.octoCancelled=true;this.aborted=true;e&&e.abort(new DOMException("Media request timed out","TimeoutError"))}async octoTimedFetch(e){if(this.octoCancelled)throw new DOMException("Media request cancelled","AbortError");const t=this.abortController,i=setTimeout(()=>this.octoExpire(t),this.octoTimeout());try{return await fetch(this.info.url,e)}finally{clearTimeout(i)}}async octoTimedRead(){if(this.octoCancelled)throw new DOMException("Media request cancelled","AbortError");const e=this.abortController,t=this.reader,i=setTimeout(()=>this.octoExpire(e),this.octoTimeout());try{return await t.read()}finally{clearTimeout(i)}}async getTotalSize(e){if(this.octoCancelled)throw new DOMException("Media request cancelled","AbortError");var t,i,r;',
    ],
    ['const e=await fetch(this.info.url,a);', 'const e=await this.octoTimedFetch(a);'],
    ['t=await fetch(this.info.url,r),i=(0,h.A)();', 't=await this.octoTimedFetch(r),i=(0,h.A)();'],
    ['async openReader(){var e,t,i;', 'async openReader(){if(this.octoCancelled)throw new DOMException("Media request cancelled","AbortError");var e,t,i;'],
    ['const{value:r,done:s}=await this.reader.read();', 'const{value:r,done:s}=await this.octoTimedRead();'],
    [
      'async abort(){this.abortSleep(),this.reader&&(await this.reader.cancel(),this.abortController&&(this.abortController.abort(),this.abortController=null),this.reader=null)}',
      'async abort(){this.abortSleep();if(this.abortController){this.abortController.abort();this.abortController=null}if(this.reader){const e=this.reader;this.reader=null;await e.cancel().catch(()=>{})}}',
    ],
    // Abort only the source operation. Keep the task and IPC alive so the
    // pending demux RPC gets its rejection before shared memory is released.
    [
      'async unregisterTask(e){const t=this.tasks.get(e);t&&(await t.ioLoader.stop()',
      'async octoAbortTask(e){const t=this.tasks.get(e);if(!t)return false;t.ioLoader.octoCancelled=true;if(t.ioLoader.abort)await t.ioLoader.abort();else await t.ioLoader.stop();return true}async octoGetIOStatus(e){const t=this.tasks.get(e);return t?{cancelled:!!t.ioLoader.octoCancelled,timedOut:!!t.ioLoader.octoTimedOut}:null}async unregisterTask(e){const t=this.tasks.get(e);t&&(await t.ioLoader.stop()',
    ],
    // An abort can arrive before there is an IO task to cancel. These gates
    // prevent the still-starting load from installing new work afterward.
    [
      'await Le.startDemuxPipeline(this.options.enableWorker);let i=0,r=0;',
      'await Le.startDemuxPipeline(this.options.enableWorker);if(this.octoAbortRequested)throw new DOMException("Media load cancelled","AbortError");let i=0,r=0;',
    ],
    [
      'r<0&&P.h2(`register io task failed, ret: ${r}, taskId: ${this.taskId}`',
      'if(this.octoAbortRequested)throw new DOMException("Media load cancelled","AbortError");r<0&&P.h2(`register io task failed, ret: ${r}, taskId: ${this.taskId}`',
    ],
    [
      'this.fire(Ae.PROGRESS,[0]);let o=3e3;',
      'this.fire(Ae.PROGRESS,[0]);if(this.octoAbortRequested)throw new DOMException("Media load cancelled","AbortError");let o=3e3;',
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

/** Correct FFmpeg's 64-byte zero-padding contract without moving live pointers. */
export function patchLibmediaChunk(name, source) {
  const expected = CHUNK_SHA256[name];
  if (!expected) return source;
  if (sha256(source) !== expected) throw new Error(`Unexpected libmedia chunk hash: ${name}`);
  const [before, after] = name === '573.avplayer.js' ? [
    'const m=(0,I.sY)(s);o&&',
    'const m=(0,I.sY)(s+64);(0,r.sO)(m+s,0,64);o&&',
  ] : [
    'const d=t.size,f=(0,h.sY)(d);if((0,g.NX)(a,f,d),await e.ioReader.readBuffer(d,(0,m.JW)(f,d))',
    'const d=t.size,f=(0,h.sY)(d+64);if((0,m.sO)(f+d,0,64),(0,g.NX)(a,f,d),await e.ioReader.readBuffer(d,(0,m.JW)(f,d))',
  ];
  if (source.split(before).length !== 2) throw new Error(`Missing or ambiguous packet-padding anchor in ${name}`);
  return `/* Octo Player: libmedia 1.3.1 packet-padding fix v${PATCH_VERSION}. LGPL-3.0-or-later. */\n${source.replace(before, after)}`;
}
