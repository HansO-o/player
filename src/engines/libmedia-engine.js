/**
 * Browser-side adapter for the pinned libmedia engine. All public times are in
 * seconds; libmedia's PTS / seek API uses bigint milliseconds.
 *
 * The upstream module is loaded only if native playback is unavailable or the
 * caller explicitly asks to benchmark WASM. It remains a replaceable external
 * LGPL component under assetBase (including its split worker modules).
 */
import { probeWorkerWebGL } from './worker-render-support.js';

const moduleLoads = new Map();
const pipelineCleanup = new WeakMap();

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function abortError() {
  return new DOMException('Playback operation was aborted', 'AbortError');
}

function waitForAudio(context, resume, signal, timeout = 2000) {
  if (context?.state === 'running') return Promise.resolve(true);
  if (!context) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      context.removeEventListener('statechange', check);
      signal?.removeEventListener('abort', aborted);
    };
    const done = (running) => { cleanup(); resolve(running); };
    const check = () => { if (context.state === 'running') done(true); };
    const aborted = () => { cleanup(); reject(abortError()); };
    context.addEventListener('statechange', check);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => done(context.state === 'running'), timeout);
    if (signal?.aborted) { aborted(); return; }
    Promise.resolve(resume).then(check, () => done(false));
    check();
  });
}

function fileExtension(source) {
  if (source.ext) return source.ext.replace(/^\./, '').toLowerCase();
  const extension = source.name?.split('.').pop()?.toLowerCase();
  if (/^(mp4|mov|m4v|m4a|webm|mkv|hevc|h265|h264|ivf|aac|mp3|opus|ogg|flac|wav|m3u8|mpd|ts)$/.test(extension || '')) return extension;
  if (/mpegurl/i.test(source.mime)) return 'm3u8';
  if (/dash\+xml/i.test(source.mime)) return 'mpd';
  // Unknown file URLs are sniffed by the demuxer. A nonempty generic extension
  // bypasses upstream's separate, uncancellable playlist-guessing fetch.
  return 'bin';
}

function loadModule(assetBase) {
  const url = new URL('avplayer.js', new URL(assetBase.endsWith('/') ? assetBase : `${assetBase}/`, document.baseURI)).href;
  if (!moduleLoads.has(url)) {
    const promise = import(/* @vite-ignore */ url).catch((error) => {
      moduleLoads.delete(url);
      throw new Error(`Could not load the WASM playback engine (${url}). Run npm run assets and serve the vendor directory. ${error.message}`, { cause: error });
    });
    moduleLoads.set(url, promise);
  }
  return moduleLoads.get(url);
}

export class LibmediaEngine {
  constructor(options) {
    this.name = 'libmedia';
    this.options = options;
    this.container = options.container;
    this.mode = options.mode || 'auto';
    this.emit = options.emit || (() => {});
    this.signal = options.signal;
    this.player = null;
    this.AVPlayer = null;
    this._paused = true;
    this._destroyed = false;
    this._started = false;
    this._volume = options.volume ?? 1;
    this._muted = !!options.muted;
    this._rate = options.playbackRate || 1;
    this._pendingSeek = null;
    this._metadata = { duration: 0, width: 0, height: 0, hasAudio: false, hasVideo: false, streams: [], sourceFps: null };
    this._decodeStatus = null;
    this._renderer = null;
    this._workerGraphics = null;
    this._decodeStatusPending = false;
    this._lastStatusPoll = 0;
    this._firstAudioRendered = false;
    this._listeners = [];
    this._resizeObserver = null;
    this._transport = Promise.resolve();
    this._rawLoad = null;
    this._loadAbortReason = null;
    this._abortListener = () => { this._abortIO().catch(() => {}); };
  }

  _assertActive() {
    if (this._destroyed || this.signal?.aborted) throw abortError();
  }

  _notify(type, detail = {}) {
    if (!this._destroyed && !this.signal?.aborted) this.emit(type, detail);
  }

  _enqueue(operation) {
    const result = this._transport.catch(() => {}).then(() => {
      this._assertActive();
      return operation();
    });
    this._transport = result;
    // Mark a rejection as observed even if a caller changes source immediately;
    // the returned promise still rejects normally for that caller.
    result.catch(() => {});
    return result;
  }

  async _abortIO(reason = abortError()) {
    this._loadAbortReason ||= reason;
    const player = this.player;
    if (!player) return;
    // The local flag covers cancellation before the IO task exists. The scoped
    // RPC aborts the source without deleting its IPC or shared-memory structs;
    // pending load/read calls settle before destroy releases those structures.
    player.octoAbortRequested = true;
    if (this.AVPlayer.IOThread) {
      await this.AVPlayer.IOThread.octoAbortTask(player.taskId).catch(() => {});
    }
  }

  async _translateLoadError(error) {
    if (this._loadAbortReason || this.signal?.aborted) return this._loadAbortReason || abortError();
    let timer;
    // Diagnostics may be unavailable after a worker fault. This bound applies
    // only to a read-only status query, never to shared-memory destruction.
    const state = await Promise.race([
      Promise.resolve().then(() => this.AVPlayer.IOThread?.octoGetIOStatus(this.player.taskId)).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 500); }),
    ]).finally(() => clearTimeout(timer));
    return state?.timedOut ? new DOMException('Media HTTP request or body read timed out.', 'TimeoutError') : error;
  }

  async load(source, { startTime = 0 } = {}) {
    this._assertActive();
    this.source = source;
    const { default: AVPlayer } = await loadModule(this.options.assetBase || '/vendor/libmedia/');
    await pipelineCleanup.get(AVPlayer);
    this._assertActive();
    this.AVPlayer = AVPlayer;
    AVPlayer.setLogLevel(this.options.debug ? 4 : 1);
    const wasmOnly = this.mode === 'wasm';
    const configuration = {
      container: this.container,
      wasmBaseUrl: (this.options.wasmBase || '/vendor/libmedia/wasm/').replace(/\/$/, ''),
      enableHardware: !wasmOnly,
      enableWebCodecs: !wasmOnly,
      enableWebGPU: this.options.renderer !== 'webgl',
      enableWorker: true,
      enableAudioWorklet: true,
      loop: !!this.options.loop,
      // Bounded compressed-packet preload: this is not a giant decoded RGBA queue.
      preLoadTime: Math.max(0.25, Math.min(8, this.options.bufferTarget ?? 1.5)),
      audioWorkletBufferLength: Math.max(8, Math.min(48, this.options.audioWorkletBufferLength ?? 24)),
      octoThreadCount: Number.isFinite(this.options.threadCount) ? Math.max(1, Math.floor(this.options.threadCount)) : undefined,
      octoForceWasm: wasmOnly,
    };
    if (wasmOnly || this.options.enableMSE === false) configuration.checkUseMSE = () => false;
    this.player = new AVPlayer(configuration);
    this.signal?.addEventListener('abort', this._abortListener, { once: true });
    this._assertActive();
    this._connectEvents();
    this.player.setVolume(this._muted ? 0 : this._volume, true);
    this.player.setPlaybackRate(this._rate);
    const loadOptions = {
      isLive: false,
      ioLoaderOptions: { retryCount: 2, retryInterval: 0.25, octoFetchTimeoutMs: this.options.fetchTimeoutMs ?? 15000 },
      ext: fileExtension(source),
      ...(source.headers || source.credentials ? { http: { headers: source.headers, credentials: source.credentials } } : {}),
    };
    const input = source.input instanceof Blob && !(source.input instanceof File)
      ? new File([source.input], `${source.name || 'local-video'}.${fileExtension(source)}`, { type: source.mime || source.input.type })
      : source.input;
    this._rawLoad = this.player.load(input, loadOptions);
    try { await this._rawLoad; }
    catch (error) { throw await this._translateLoadError(error); }
    this._assertActive();
    this._readMetadata();
    if (this._metadata.hasVideo) {
      this._workerGraphics = await probeWorkerWebGL();
      this._assertActive();
      this.AVPlayer.Util.setWorkerRendererSupported(this._workerGraphics.supported);
      if (!this._workerGraphics.supported) {
        this._notify('warning', {
          code: 'MAIN_THREAD_VIDEO_RENDERER',
          message: 'Worker 内没有可用的 WebGL，改用主线程 GPU 渲染；跨源隔离启用时视频解码仍保留在 Worker。',
        });
      }
    }
    if (wasmOnly && this._metadata.hasVideo) {
      const probe = document.createElement('canvas');
      const context = probe.getContext('webgl') || probe.getContext('webgl2');
      // Upstream's WASM YUV renderer needs a working GPU graphics context.
      // Report a real failure instead of accepting an unexpected native route.
      let gpu = null;
      if (this.options.renderer !== 'webgl' && navigator.gpu) {
        try { gpu = await navigator.gpu.requestAdapter(); } catch { /* WebGL remains the fallback. */ }
      }
      if (!context && !gpu) throw new Error(this.options.renderer === 'webgl'
        ? 'WASM video rendering needs WebGL, but this browser has disabled it.'
        : 'WASM video rendering needs WebGL or WebGPU, but this browser has disabled both.');
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this._pendingSeek = Math.max(0, number(startTime));
    if ('ResizeObserver' in globalThis) {
      this._resizeObserver = new ResizeObserver(() => this._resize());
      this._resizeObserver.observe(this.container);
    }
    this._resize();
    this._notify('loadedmetadata', this._metadata);
    this._notify('ready', { engine: 'libmedia', ...this._metadata });
    return this._metadata;
  }

  _connectEvents() {
    const listen = (type, callback) => {
      this.player.on(type, callback);
      this._listeners.push([type, callback]);
    };
    listen('playing', () => this._notify('buffering', { reason: 'decoder-start' }));
    listen('played', () => {
      this._paused = false;
      this._notify('playing', { engine: 'libmedia' });
      this._pollDecodeStatus(true);
    });
    listen('paused', () => { this._paused = true; this._notify('pause'); });
    listen('ended', () => { this._paused = true; this._notify('ended'); });
    listen('seeking', () => this._notify('seeking'));
    listen('seeked', () => this._notify('seeked', { currentTime: this.currentTime }));
    listen('time', () => this._notify('timeupdate', { currentTime: this.currentTime, duration: this.duration }));
    listen('firstVideoRendered', () => this._notify('firstframe', { kind: 'video' }));
    listen('firstAudioRendered', () => {
      this._firstAudioRendered = true;
      this._notify('audio-output', { state: this.AVPlayer.audioContext?.state || 'unknown' });
    });
    listen('audioContextRunning', () => this._notify('audio-output', { state: 'running' }));
    listen('streamUpdate', () => { this._readMetadata(); this._notify('loadedmetadata', this._metadata); });
    listen('error', (value) => {
      const error = value instanceof Error ? value : new Error(String(value?.message || value || 'WASM engine error'));
      this._notify('error', { error, message: error.message, engine: 'libmedia' });
    });
    listen('timeout', () => this._notify('buffering', { reason: 'source-timeout' }));
  }

  _readMetadata() {
    if (!this.player) return;
    const streams = this.player.getStreams().map((stream) => {
      const codec = stream.codecparProxy;
      const rate = codec?.framerate;
      return {
        id: stream.id,
        type: String(stream.mediaType || '').toLowerCase(),
        codecId: codec?.codecId,
        width: number(codec?.width),
        height: number(codec?.height),
        sampleRate: number(codec?.sampleRate),
        channels: number(codec?.chLayout?.nbChannels),
        sourceFps: rate?.den ? number(rate.num) / number(rate.den, 1) : null,
        language: stream.metadata?.language || null,
      };
    });
    const video = streams.find((stream) => stream.type === 'video');
    const audio = streams.find((stream) => stream.type === 'audio');
    this._metadata = {
      duration: Math.max(0, number(this.player.getDuration()) / 1000),
      width: video?.width || 0,
      height: video?.height || 0,
      sourceFps: video?.sourceFps || null,
      hasAudio: !!audio,
      hasVideo: !!video,
      streams,
    };
  }

  _resize() {
    if (!this.player || this._destroyed) return;
    const { width, height } = this.container.getBoundingClientRect();
    if (width > 0 && height > 0) this.player.resize(Math.round(width), Math.round(height));
  }

  async play() {
    this._assertActive();
    // Create/resume synchronously inside the click. Upstream otherwise creates
    // its context only after asynchronous worker/decoder setup, too late for
    // Firefox/Safari's transient user activation. Its normal startAudioPipeline
    // still installs the worklet exactly once on this shared context.
    if (this._metadata.hasAudio && (!this.AVPlayer.audioContext || this.AVPlayer.audioContext.state === 'closed')) {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (Context) this.AVPlayer.audioContext = new Context();
    }
    const contextResume = this.AVPlayer.audioContext?.state !== 'running' ? this.AVPlayer.audioContext?.resume() : null;
    if (contextResume) contextResume.catch(() => {});
    return this._enqueue(async () => {
      await this.player.play({ audio: true, video: true, subtitle: false, audioMasterForce: true });
      this._assertActive();
      this._started = true;
      if (this._pendingSeek > 0) await this.player.seek(BigInt(Math.round(this._pendingSeek * 1000)));
      this._pendingSeek = null;
      this._paused = false;
      if (!this.player.isMSE() && this._metadata.hasAudio && !await waitForAudio(this.AVPlayer.audioContext, contextResume, this.signal)) {
        await this.player.pause();
        this._paused = true;
        throw new DOMException('Click play to allow the browser to start audio output.', 'NotAllowedError');
      }
      this._resize();
      this._pollDecodeStatus(true);
    });
  }

  async pause() {
    if (this._destroyed) return;
    return this._enqueue(async () => {
      if (!this.player || !this._started) return;
      await this.player.pause();
      this._paused = true;
    });
  }

  async seek(seconds) {
    this._assertActive();
    const target = Math.max(0, Math.min(this.duration || Infinity, number(seconds)));
    return this._enqueue(async () => {
      if (!this._started) { this._pendingSeek = target; return; }
      await this.player.seek(BigInt(Math.round(target * 1000)));
    });
  }

  setVolume(volume) {
    this._volume = Math.max(0, Math.min(1, number(volume, 1)));
    this.player?.setVolume(this._muted ? 0 : this._volume, true);
  }

  setMuted(muted) {
    this._muted = !!muted;
    this.player?.setVolume(this._muted ? 0 : this._volume, true);
  }

  setPlaybackRate(rate) {
    this._rate = Math.max(0.25, Math.min(4, number(rate, 1)));
    this.player?.setPlaybackRate(this._rate);
  }

  get currentTime() { return this.player ? Math.max(0, number(this.player.currentTime) / 1000) : 0; }
  get duration() { return this._metadata.duration; }
  get paused() { return this._paused; }
  getAudioOutputNode() { return this.player?.getAudioOutputNode() || null; }

  _pollDecodeStatus(force = false) {
    if (this._destroyed || !this._started || this._decodeStatusPending || !this.player?.VideoDecoderThread) return;
    const now = performance.now();
    if (!force && now - this._lastStatusPoll < 1000) return;
    this._lastStatusPoll = now;
    this._decodeStatusPending = true;
    // This RPC is the only private extension: its hash-gated source patch is in
    // scripts/patch-libmedia.mjs. Failed diagnostics never interrupt playback.
    Promise.resolve().then(() => Promise.all([
      this.player?.VideoDecoderThread?.getOctoDecodeStatus(this.player.taskId),
      this.player?.VideoRenderThread?.getOctoRenderStatus(this.player.taskId),
    ]))
      .then(([status, renderer]) => {
        if (!this._destroyed) { this._decodeStatus = status; this._renderer = renderer; }
      })
      .catch(() => {})
      .finally(() => { this._decodeStatusPending = false; });
  }

  getStats() {
    if (!this.player || this._destroyed) return {};
    this._pollDecodeStatus();
    const stats = this.player.getStats();
    const mse = this.player.isMSE();
    const sourceFps = this._metadata.sourceFps || number(stats.videoEncodeFramerate) || null;
    const audioTime = number(stats.audioCurrentTime) / 1000;
    const videoTime = number(stats.videoCurrentTime) / 1000;
    const audioQueued = number(stats.audioPacketQueueLength);
    const videoQueued = number(stats.videoPacketQueueLength);
    const audioPacketRate = number(stats.audioEncodeFramerate);
    const bufferedParts = [];
    if (this._metadata.hasVideo && sourceFps) bufferedParts.push(videoQueued / sourceFps);
    if (this._metadata.hasAudio && audioPacketRate > 0) bufferedParts.push(audioQueued / audioPacketRate);
    const decoder = mse ? 'mse' : (this._decodeStatus?.decoder || (this.mode === 'wasm' ? 'wasm' : 'auto'));
    const mseVideo = mse ? this.container.querySelector('video') : null;
    const quality = mseVideo?.getVideoPlaybackQuality?.();
    return {
      engine: 'libmedia',
      decoder,
      // WebCodecs hardwareAcceleration is a preference; never certify physical
      // hardware based solely on a config hint or canPlayType.
      hardwareAcceleration: this._decodeStatus?.hardwarePreference || null,
      renderer: mse ? 'native' : this._renderer,
      rendererPreference: this.options.renderer || 'auto',
      workerGraphics: this._workerGraphics,
      threads: decoder === 'wasm' ? (this._decodeStatus?.threads ?? null) : null,
      requestedThreads: this.options.threadCount ?? null,
      sharedMemory: !!globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
      fps: number(stats.videoRenderFramerate),
      sourceFps,
      decodeFps: number(stats.videoDecodeFramerate),
      decodedFrames: mse ? null : number(stats.videoFrameDecodeCount),
      renderedFrames: quality ? quality.totalVideoFrames - quality.droppedVideoFrames : number(stats.videoFrameRenderCount),
      droppedFrames: quality ? quality.droppedVideoFrames : number(stats.videoFrameDropCount),
      droppedPackets: number(stats.videoDropPacketCount),
      decodeErrors: number(stats.videoDecodeErrorPacketCount),
      bufferedSeconds: bufferedParts.length ? Math.max(0, Math.min(...bufferedParts)) : null,
      bufferMeasurement: 'compressed-packet-queue-estimate',
      avDriftMs: this._metadata.hasAudio && this._metadata.hasVideo ? (videoTime - audioTime) * 1000 : null,
      videoCurrentTime: videoTime,
      maxFrameIntervalMs: number(stats.videoFrameRenderIntervalMax),
      videoStalls: number(stats.videoStutter),
      hasAudio: this._metadata.hasAudio,
      audioCodec: stats.audiocodec || null,
      videoCodec: stats.videocodec || null,
      audioDecodedFrames: mse ? null : number(stats.audioFrameDecodeCount),
      audioRenderedFrames: mse ? null : number(stats.audioFrameRenderCount),
      audioDroppedFrames: number(stats.audioFrameDropCount),
      audioDecodeErrors: number(stats.audioDecodeErrorPacketCount),
      audioOutputTime: audioTime,
      audioContextState: this.AVPlayer.audioContext?.state || null,
      audioOutputStarted: this._firstAudioRendered,
      audioSampleRate: number(stats.sampleRate),
      audioChannels: number(stats.channels),
      audioStalls: number(stats.audioStutter),
      width: number(stats.width) || this._metadata.width,
      height: number(stats.height) || this._metadata.height,
    };
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._paused = true;
    this._resizeObserver?.disconnect();
    this.signal?.removeEventListener('abort', this._abortListener);
    if (this.player) {
      await this._abortIO();
      // Upstream does not permit destruction while a transport RPC is still
      // mutating its shared memory. Complete those RPCs before releasing it.
      await this._transport.catch(() => {});
      await this._rawLoad?.catch(() => {});
      for (const [event, listener] of this._listeners) this.player.off(event, listener);
      this._listeners.length = 0;
      const player = this.player;
      this.player = null;
      await player.destroy();
      if (this.AVPlayer.Instances.length === 0) {
        const context = this.AVPlayer.audioContext;
        const cleanup = this.AVPlayer.stopPipelines().then(async () => {
          if (context && context.state !== 'closed') await context.close();
        });
        pipelineCleanup.set(this.AVPlayer, cleanup);
        await cleanup;
      }
    }
  }
}

export default LibmediaEngine;
