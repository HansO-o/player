import { abortError, throwIfAborted } from '../core/source.js';

function mediaError(video) {
  const messages = { 1: 'Playback was aborted', 2: 'Video network request failed', 3: 'Browser decoder failed', 4: 'Browser does not support this source or codec' };
  const error = new Error(messages[video.error?.code] || 'Native video playback failed');
  error.code = `NATIVE_${video.error?.code || 'ERROR'}`;
  return error;
}

export class NativeEngine {
  constructor({ container, emit, signal, nativeTimeoutMs = 10000, muted = false, crossOrigin = globalThis.crossOriginIsolated ? 'anonymous' : null }) {
    this.name = 'native'; this.emit = emit; this.signal = signal; this.timeout = nativeTimeoutMs;
    this.listeners = []; this.destroyed = false; this.loaded = false; this.objectURL = null;
    this.video = document.createElement('video');
    Object.assign(this.video, { playsInline: true, preload: 'auto', controls: false, muted });
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
    if (crossOrigin) this.video.crossOrigin = crossOrigin;
    container.append(this.video);
    const on = (name, fn) => { this.video.addEventListener(name, fn); this.listeners.push([name, fn]); };
    on('playing', () => emit('playing', {}));
    on('pause', () => emit('pause', {}));
    on('waiting', () => emit('buffering', {}));
    on('ended', () => emit('ended', {}));
    on('seeking', () => emit('seeking', {}));
    on('seeked', () => emit('seeked', { currentTime: this.currentTime }));
    on('timeupdate', () => emit('timeupdate', { currentTime: this.currentTime, duration: this.duration }));
    on('durationchange', () => { if (this.loaded) emit('metadata', this.metadata()); });
    on('error', () => { if (this.loaded && !this.destroyed) emit('error', { error: mediaError(this.video), code: 'NATIVE_DECODE', message: mediaError(this.video).message }); });
  }

  async load(source, { startTime = 0 } = {}) {
    throwIfAborted(this.signal);
    this.source = source;
    if (source.mime && !this.video.canPlayType(source.mime)) throw Object.assign(new Error(`Native browser cannot play ${source.mime}`), { code: 'NATIVE_UNSUPPORTED' });
    const knownAudio = source.probe?.tracks.filter(track => track.kind === 'audio') || [];
    const audioMimes = { 'ac-3': 'audio/mp4; codecs="ac-3"', 'ec-3': 'audio/mp4; codecs="ec-3"', Opus: 'audio/mp4; codecs="opus"', fLaC: 'audio/mp4; codecs="flac"' };
    if (knownAudio.some(track => audioMimes[track.codec] && !this.video.canPlayType(audioMimes[track.codec]))) {
      throw Object.assign(new Error('The browser cannot play the audio track; switching both tracks to the media engine'), { code: 'NATIVE_AUDIO_UNSUPPORTED' });
    }
    const expectedVideo = source.probe ? source.probe.hasVideo : !source.mime.startsWith('audio/');
    const ready = new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.video.removeEventListener('loadeddata', loaded); this.video.removeEventListener('error', failed); this.signal?.removeEventListener('abort', aborted); };
      const loaded = () => {
        cleanup();
        if (expectedVideo && !this.video.videoWidth) reject(Object.assign(new Error('Browser loaded audio but did not decode a video track'), { code: 'NATIVE_NO_VIDEO' }));
        else resolve();
      };
      const failed = () => { cleanup(); reject(mediaError(this.video)); };
      const aborted = () => { cleanup(); reject(abortError()); };
      this.video.addEventListener('loadeddata', loaded);
      this.video.addEventListener('error', failed);
      this.signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('Native decode startup timed out; using fallback'), { code: 'NATIVE_TIMEOUT' })); }, this.timeout);
    });
    if (source.input instanceof Blob) this.video.src = this.objectURL = URL.createObjectURL(source.input);
    else this.video.src = source.input;
    this.video.load();
    await ready;
    throwIfAborted(this.signal);
    this.loaded = true;
    if (startTime > 0) await this.seek(startTime);
    this.emit('metadata', this.metadata());
    return this.metadata();
  }

  metadata() {
    return { duration: this.duration, width: this.video.videoWidth, height: this.video.videoHeight,
      hasVideo: Boolean(this.video.videoWidth), hasAudio: this.source?.probe?.hasAudio ?? null,
      codec: this.source?.probe?.tracks.find(t => t.kind === 'video')?.codec || null,
      audioCodec: this.source?.probe?.tracks.find(t => t.kind === 'audio')?.codec || null };
  }
  play() { throwIfAborted(this.signal); return this.video.play(); }
  pause() { this.video.pause(); }
  async seek(seconds) {
    throwIfAborted(this.signal);
    const target = Math.max(0, Math.min(Number(seconds), Number.isFinite(this.duration) ? this.duration : Number(seconds)));
    if (!Number.isFinite(target)) throw new TypeError('Seek time must be finite');
    if (Math.abs(this.currentTime - target) < 0.015 && !this.video.seeking) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Native seek timed out')); }, 10000);
      const cleanup = () => { clearTimeout(timer); this.video.removeEventListener('seeked', done); this.video.removeEventListener('error', failed); this.signal?.removeEventListener('abort', aborted); };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(mediaError(this.video)); };
      const aborted = () => { cleanup(); reject(abortError()); };
      this.video.addEventListener('seeked', done, { once: true });
      this.video.addEventListener('error', failed, { once: true });
      this.signal?.addEventListener('abort', aborted, { once: true });
      this.video.currentTime = target;
    });
  }
  setVolume(value) { this.video.volume = value; }
  setMuted(value) { this.video.muted = value; }
  setPlaybackRate(value) { this.video.playbackRate = value; }
  get currentTime() { return this.video.currentTime || 0; }
  get duration() { return this.video.duration || 0; }
  get paused() { return this.video.paused; }

  getStats() {
    const quality = this.video.getVideoPlaybackQuality?.();
    let bufferedSeconds = 0;
    for (let i = 0; i < this.video.buffered.length; i++) {
      if (this.video.buffered.start(i) <= this.currentTime && this.video.buffered.end(i) >= this.currentTime) { bufferedSeconds = this.video.buffered.end(i) - this.currentTime; break; }
    }
    const total = quality?.totalVideoFrames ?? this.video.webkitDecodedFrameCount ?? null;
    const dropped = quality?.droppedVideoFrames ?? this.video.webkitDroppedFrameCount ?? null;
    return {
      engine: 'native', decoder: 'browser-native', hardwareAcceleration: 'browser-managed',
      renderer: 'video', threads: null, requestedThreads: null,
      decodedFrames: total, renderedFrames: total === null ? null : Math.max(0, total - (dropped || 0)), droppedFrames: dropped,
      fps: null, sourceFps: null, decodeFps: null, avDriftMs: null,
      audioDecodedFrames: null, audioRenderedFrames: null, audioContextState: null,
      bufferedSeconds, currentTime: this.currentTime, duration: this.duration, paused: this.paused,
      width: this.video.videoWidth, height: this.video.videoHeight,
    };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.loaded = false;
    for (const [name, fn] of this.listeners) this.video.removeEventListener(name, fn);
    this.listeners.length = 0;
    this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video.remove();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
  }
}
