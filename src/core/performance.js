function number(value) { return Number.isFinite(value) ? value : null; }

/** Estimates presentation headroom; never treats rendered FPS as maximum decoder throughput. */
export class PerformanceMonitor {
  constructor({ maxSamples = 600 } = {}) {
    this.maxSamples = maxSamples;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.warnings = [];
    this.startedAt = Date.now();
    this.stalls = 0;
    this.stallMs = 0;
    this.stallStartedAt = null;
    this.firstFrameAt = null;
    this.lastPressureAt = -Infinity;
    this.previous = null;
  }

  state(state, now = performance.now()) {
    if (state === 'buffering' && this.stallStartedAt === null) { this.stallStartedAt = now; this.stalls++; }
    if (state !== 'buffering' && this.stallStartedAt !== null) { this.stallMs += Math.max(0, now - this.stallStartedAt); this.stallStartedAt = null; }
  }

  sample(stats, now = performance.now()) {
    const frames = number(stats.renderedFrames);
    if (frames > 0 && this.firstFrameAt === null) this.firstFrameAt = Date.now();
    let intervalFps = null;
    let intervalDropRatio = null;
    if (this.previous && now > this.previous.now && frames !== null && this.previous.frames !== null) {
      const rendered = frames - this.previous.frames;
      const dropped = number(stats.droppedFrames) === null || this.previous.dropped === null ? null : stats.droppedFrames - this.previous.dropped;
      if (rendered >= 0) intervalFps = rendered * 1000 / (now - this.previous.now);
      if (rendered >= 0 && dropped !== null && dropped >= 0 && rendered + dropped > 0) intervalDropRatio = dropped / (rendered + dropped);
    }
    this.previous = { now, frames, dropped: number(stats.droppedFrames) };
    const sample = { ...stats, sampledAt: Date.now(), intervalFps, intervalDropRatio };
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return sample;
  }

  pressure(sample, now = performance.now()) {
    // Do not infer overload when paused, starting, seeking, backgrounded, or from sparse counters.
    if (sample.paused || sample.state !== 'playing' || globalThis.document?.hidden) return null;
    if (now - this.lastPressureAt < 10000 || this.samples.length < 4) return null;
    const recent = this.samples.slice(-4);
    const drops = recent.filter(s => s.intervalDropRatio !== null && s.intervalDropRatio > 0.12);
    const lag = recent.filter(s => Number.isFinite(s.avDriftMs) && Math.abs(s.avDriftMs) > 500);
    if (drops.length >= 3 || lag.length >= 3) {
      this.lastPressureAt = now;
      return { code: 'DECODE_PRESSURE', message: '持续播放压力：音频时钟优先，解码器会跳过迟到的视频帧；缓冲无法补足持续算力不足。', dropRatio: sample.intervalDropRatio, avDriftMs: sample.avDriftMs };
    }
    return null;
  }

  report() {
    const valid = this.samples.filter(s => s.state === 'playing' && s.intervalFps !== null && !s.paused);
    const fps = valid.map(s => s.intervalFps).sort((a, b) => a - b);
    const at = (p) => fps.length ? fps[Math.min(fps.length - 1, Math.floor((fps.length - 1) * p))] : null;
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      firstFrameDelayMs: this.firstFrameAt ? this.firstFrameAt - this.startedAt : null,
      stalls: this.stalls,
      stallMs: this.stallMs + (this.stallStartedAt === null ? 0 : performance.now() - this.stallStartedAt),
      fps: { median: at(0.5), p05: at(0.05), p95: at(0.95), samples: fps.length },
      samples: this.samples.map(s => ({ ...s })),
    };
  }
}
