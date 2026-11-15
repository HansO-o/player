import { Events } from './core/events.js';
import { detectCapabilities, threadBudget } from './core/capabilities.js';
import { normalizeSource, serializableSource, abortError, throwIfAborted } from './core/source.js';
import { probeMp4 } from './core/mp4-probe.js';
import { PerformanceMonitor } from './core/performance.js';
import { NativeEngine } from './engines/native-engine.js';

export { detectCapabilities, queryDecodingSupport, threadBudget } from './core/capabilities.js';
export const version = '0.1.0';

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const errorDetail = (error) => ({ code: error.code || error.name || 'PLAYBACK_ERROR', message: error.message || String(error), error });

/** Small native-first facade. The fallback engine is not loaded until it is needed. */
export class OctoPlayer extends Events {
  constructor(options = {}) {
    super();
    const container = typeof options.container === 'string' ? document.querySelector(options.container) : options.container;
    if (!container?.append) throw new TypeError('OctoPlayer requires a container element');
    this.options = {
      mode: 'auto', renderer: 'auto', performance: 'balanced',
      assetBase: new URL('./vendor/libmedia/', document.baseURI).href,
      nativeTimeoutMs: 10000, statsIntervalMs: 1000, ...options,
    };
    if (!['auto', 'native', 'wasm'].includes(this.options.mode)) throw new TypeError('mode must be auto, native or wasm');
    if (!['auto', 'webgpu', 'webgl'].includes(this.options.renderer)) throw new TypeError('renderer must be auto, webgpu or webgl');
    this.options.assetBase = new URL(this.options.assetBase, document.baseURI).href.replace(/\/?$/, '/');
    this.options.wasmBase = this.options.wasmBase || `${this.options.assetBase}wasm/`;
    this.capabilities = detectCapabilities();
    this.monitor = new PerformanceMonitor();
    this.surface = document.createElement('div');
    this.surface.className = 'octo-player-surface';
    this.surface.style.cssText = 'position:relative;width:100%;height:100%;min-height:1px;overflow:hidden;background:#000;';
    container.append(this.surface);
    this.engine = null; this.source = null; this.state = 'idle'; this.destroyed = false;
    this.volume = Math.max(0, Math.min(1, finite(options.volume, 1)));
    this.muted = Boolean(options.muted); this.playbackRate = finite(options.playbackRate, 1);
    this.generation = 0; this.controller = null; this.fallbackTask = null; this.transportIntent = 0; this._desiredPlaying = false;
    this.history = []; this.warnings = []; this.metadata = {}; this.latestStats = null; this._reportedError = null;
    this._retired = Promise.resolve(); this._seekQueue = Promise.resolve();
    this.timer = setInterval(() => this._sample(), Math.max(250, this.options.statsIntervalMs));
  }

  _assertLive() { if (this.destroyed) throw new Error('Player has been destroyed'); }
  _setState(state) {
    if (this.destroyed && state !== 'destroyed') return;
    if (this.state === state) return;
    this.state = state; this.monitor.state(state);
    this.emit('statechange', { state });
  }
  _warning(warning) {
    this.warnings.push({ code: warning.code, message: warning.message, at: new Date().toISOString() });
    if (this.warnings.length > 50) this.warnings.shift();
    this.emit('warning', warning);
  }
  _reportError(detail) {
    this._setState('error');
    const error = detail.error || detail;
    if (this._reportedError === error) return;
    this._reportedError = error;
    this.emit('error', detail);
  }

  async load(value, { startTime = 0 } = {}) {
    this._assertLive();
    const source = normalizeSource(value);
    const generation = ++this.generation;
    ++this.transportIntent; this._desiredPlaying = false; this.fallbackTask = null;
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const oldEngine = this.engine; this.engine = null;
    // Drain previous workers before opening the next instance. Superseded loads are aborted.
    this._retired = this._retired.catch(() => {}).then(() => oldEngine?.destroy());
    this.source = source; this.metadata = {}; this.history = []; this.warnings = [];
    this.latestStats = null; this._reportedError = null; this.monitor.reset(); this._setState('loading');
    try {
      await this._retired;
      throwIfAborted(signal);
      // A tiny MP4 probe catches unsupported audio tracks and audio-only files before native playback.
      // It is bounded by size/time; an inconclusive probe still allows a native attempt.
      const probeController = new AbortController();
      const abortProbe = () => probeController.abort();
      signal.addEventListener('abort', abortProbe, { once: true });
      const probeTimer = setTimeout(abortProbe, 2000);
      try { source.probe = await probeMp4(source, probeController.signal); } catch { source.probe = null; }
      finally { clearTimeout(probeTimer); signal.removeEventListener('abort', abortProbe); }
      throwIfAborted(signal);
      if (this.options.mode !== 'wasm') {
        try {
          await this._openEngine('native', source, { generation, signal, startTime, reason: 'native-first' });
        } catch (error) {
          if (signal.aborted || this.options.mode === 'native') throw error;
          this._warning({ code: 'NATIVE_FALLBACK', message: `原生播放不可用，切换解码引擎：${error.message}` });
          await this._openEngine('libmedia', source, { generation, signal, startTime, reason: error.code || 'native-unavailable' });
        }
      } else {
        await this._openEngine('libmedia', source, { generation, signal, startTime, reason: 'forced-wasm' });
      }
      throwIfAborted(signal);
      this._setState('ready');
      this._sample();
      return this;
    } catch (error) {
      if (signal.aborted || generation !== this.generation) throw abortError();
      if (this.engine) { await this.engine.destroy().catch(() => {}); this.engine = null; }
      this._reportError(errorDetail(error)); throw error;
    }
  }

  async _openEngine(kind, source, { generation, signal, startTime, reason }) {
    if (this.engine) { const previous = this.engine; this.engine = null; await previous.destroy(); }
    throwIfAborted(signal);
    const mount = document.createElement('div');
    mount.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
    this.surface.replaceChildren(mount);
    let Engine = NativeEngine;
    if (kind === 'libmedia') {
      ({ LibmediaEngine: Engine } = await import('./engines/libmedia-engine.js'));
      throwIfAborted(signal);
      if (!this.capabilities.crossOriginIsolated) this._warning({ code: 'NO_CROSS_ORIGIN_ISOLATION', message: '未启用跨源隔离，WASM 使用单线程回退。启用 COOP/COEP 可使用多线程。' });
      if (!this.capabilities.simd) this._warning({ code: 'NO_SIMD', message: '当前浏览器没有可用的 WASM SIMD，使用标量解码器。' });
    }
    let engine;
    const emit = (type, detail) => {
      if (generation !== this.generation || signal.aborted || this.destroyed || this.engine !== engine) return;
      this._engineEvent(type, detail || {});
    };
    engine = new Engine({
      ...this.options, container: mount, signal, emit, muted: this.muted,
      threadCount: threadBudget(this.capabilities, this.options.performance, this.options.threads),
    });
    this.engine = engine;
    this.history.push({ engine: kind, reason, at: new Date().toISOString() });
    try {
      await engine.load(source, { startTime });
      throwIfAborted(signal);
      engine.setVolume(this.volume); engine.setMuted(this.muted); engine.setPlaybackRate(this.playbackRate);
      this.emit('enginechange', { engine: kind, reason });
    } catch (error) {
      if (this.engine === engine) this.engine = null;
      await engine.destroy().catch(() => {}); mount.remove(); throw error;
    }
  }

  _engineEvent(type, detail) {
    if (this.state === 'error' && ['playing', 'pause', 'buffering', 'waiting', 'seeking', 'seeked', 'ended'].includes(type)) return;
    switch (type) {
      case 'metadata': case 'loadedmetadata':
        this.metadata = { ...this.metadata, ...detail }; this.emit('metadata', this.metadata); return;
      case 'playing': this._setState('playing'); break;
      case 'pause': if (!['loading', 'seeking'].includes(this.state)) this._setState('paused'); break;
      case 'buffering': case 'waiting': if (this.state === 'playing') this._setState('buffering'); break;
      case 'seeking': this._setState('seeking'); break;
      case 'seeked': this._setState(this.paused ? 'paused' : 'playing'); break;
      case 'ended': this._setState('ended'); break;
      case 'warning': this._warning(detail); return;
      case 'error': {
        if (this.state === 'loading') return; // load() owns startup rejection/fallback.
        if (this.options.mode === 'auto' && this.engine?.name === 'native') {
          this._runtimeFallback(detail).catch(() => {}); return;
        }
        this._reportError(detail); return;
      }
    }
    this.emit(type, detail);
  }

  async _runtimeFallback(detail) {
    if (this.fallbackTask) return this.fallbackTask;
    const startTime = this.currentTime;
    const shouldPlay = !this.paused;
    const generation = this.generation; const signal = this.controller.signal;
    this._warning({ code: 'RUNTIME_FALLBACK', message: `原生解码中断，在 ${startTime.toFixed(1)} 秒切换解码器。` });
    this._setState('loading');
    const task = (async () => {
      try {
        await this._openEngine('libmedia', this.source, { generation, signal, startTime, reason: detail.code || 'native-runtime-error' });
        throwIfAborted(signal);
        this._setState('ready');
        if (shouldPlay && this._desiredPlaying) await this.play();
      } catch (error) {
        if (!signal.aborted) this._reportError(errorDetail(error));
        throw error;
      } finally { if (this.fallbackTask === task) this.fallbackTask = null; }
    })();
    this.fallbackTask = task;
    return task;
  }

  async play() {
    this._assertLive();
    if (this.state === 'error' && this._reportedError) throw this._reportedError;
    if (!this.engine) throw new Error('Load a source before calling play()');
    const engine = this.engine; const generation = this.generation; const intent = ++this.transportIntent;
    this._desiredPlaying = true;
    try {
      await engine.play();
      if (this.destroyed || generation !== this.generation || engine !== this.engine) throw abortError();
      if (intent !== this.transportIntent) { if (!this._desiredPlaying) await engine.pause(); return; }
      this._setState('playing');
    } catch (error) {
      if (this.destroyed || generation !== this.generation || engine !== this.engine || error.name === 'AbortError') throw abortError();
      if (error.name === 'NotAllowedError') {
        this._setState('paused'); this._warning({ code: 'USER_GESTURE_REQUIRED', message: '浏览器需要点击播放后才能输出声音。' });
      } else if (this.options.mode === 'auto' && this.engine?.name === 'native') {
        await this._runtimeFallback(errorDetail(error));
        if (generation !== this.generation || this.destroyed) throw abortError();
        if (this._desiredPlaying) { await this.engine.play(); this._setState('playing'); }
        return;
      } else { this._reportError(errorDetail(error)); }
      throw error;
    }
  }
  async pause() {
    if (this.state === 'error' && this._reportedError) throw this._reportedError;
    this._assertLive(); const intent = ++this.transportIntent; this._desiredPlaying = false;
    const engine = this.engine;
    if (!engine) return;
    await engine.pause();
    if (!this.destroyed && this.engine === engine && intent === this.transportIntent) this._setState('paused');
  }
  seek(seconds) {
    this._assertLive();
    if (this.state === 'error' && this._reportedError) return Promise.reject(this._reportedError);
    if (!Number.isFinite(seconds)) return Promise.reject(new TypeError('Seek time must be finite'));
    const generation = this.generation;
    if (!this.engine) return Promise.reject(new Error('Load a source before seeking'));
    this._seekQueue = this._seekQueue.catch(() => {}).then(async () => {
      if (generation !== this.generation || this.destroyed) throw abortError();
      if (this.fallbackTask) await this.fallbackTask;
      if (generation !== this.generation || this.destroyed || !this.engine) throw abortError();
      const engine = this.engine;
      this._setState('seeking');
      await engine.seek(Math.max(0, seconds));
      if (generation !== this.generation || this.destroyed || engine !== this.engine) throw abortError();
      this.monitor.previous = null;
      this._setState(this.paused ? 'paused' : 'playing'); this._sample();
    });
    return this._seekQueue;
  }
  setVolume(value) {
    this._assertLive(); if (!Number.isFinite(value)) throw new TypeError('Volume must be finite');
    this.volume = Math.max(0, Math.min(1, value)); this.engine?.setVolume(this.volume);
  }
  setMuted(value) { this._assertLive(); this.muted = Boolean(value); this.engine?.setMuted(this.muted); }
  setPlaybackRate(value) {
    this._assertLive(); if (!Number.isFinite(value) || value < 0.25 || value > 4) throw new RangeError('Playback rate must be between 0.25 and 4');
    this.playbackRate = value; this.engine?.setPlaybackRate(value);
  }
  get currentTime() { return this.engine?.currentTime || 0; }
  get duration() { return this.engine?.duration || this.metadata.duration || 0; }
  get paused() { return this.engine?.paused ?? true; }

  getStats() {
    const raw = this.engine?.getStats() || {};
    return {
      engine: this.engine?.name || null, fps: null, sourceFps: null, decodeFps: null,
      renderedFrames: null, decodedFrames: null, droppedFrames: null, bufferedSeconds: null,
      avDriftMs: null, audioDecodedFrames: null, audioRenderedFrames: null,
      hardwareAcceleration: 'unknown', threads: null, ...raw,
      fps: raw.fps ?? this.latestStats?.intervalFps ?? null,
      currentTime: this.currentTime, duration: this.duration, paused: this.paused, state: this.state,
      volume: this.volume, muted: this.muted, playbackRate: this.playbackRate,
    };
  }
  _sample() {
    if (this.destroyed || !this.engine || ['loading', 'error'].includes(this.state)) return;
    try {
      const raw = this.engine.getStats();
      this.latestStats = this.monitor.sample({ ...this.getStats(), fps: raw.fps ?? null });
      this.latestStats.fps = raw.fps ?? this.latestStats.intervalFps;
      const warning = this.monitor.pressure(this.latestStats);
      if (warning) this._warning(warning);
      this.emit('stats', this.latestStats);
    } catch (error) { console.debug('OctoPlayer stats unavailable:', error.message); }
  }
  getDiagnostics() {
    return {
      version, capabilities: { ...this.capabilities }, state: this.state,
      mode: this.options.mode, performance: this.options.performance, renderer: this.options.renderer,
      requestedThreads: threadBudget(this.capabilities, this.options.performance, this.options.threads),
      source: serializableSource(this.source), metadata: { ...this.metadata },
      engineHistory: this.history.map(item => ({ ...item })), warnings: this.warnings.map(item => ({ ...item })),
      stats: this.getStats(),
    };
  }
  exportReport() {
    const diagnostics = this.getDiagnostics();
    // Export only numeric/technical metadata. A container can carry a signed URL in arbitrary tags.
    diagnostics.metadata = Object.fromEntries(['duration', 'width', 'height', 'codec', 'audioCodec', 'hasAudio', 'hasVideo'].filter(k => k in this.metadata).map(k => [k, this.metadata[k]]));
    return {
      schema: 'octo-player-benchmark/v1', generatedAt: new Date().toISOString(), ...diagnostics,
      benchmark: this.monitor.report(),
      limitations: ['Browser APIs do not prove hardware decoder use or expose total CPU utilization.', 'A local test does not certify other devices, browser versions or Bilibili performance parity.'],
    };
  }
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true; ++this.generation; ++this.transportIntent; this.controller?.abort(); clearInterval(this.timer);
    const engine = this.engine; this.engine = null;
    await this._retired.catch(() => {});
    await engine?.destroy(); this.surface.remove(); this._setState('destroyed'); this.clear();
  }
}

export default OctoPlayer;
