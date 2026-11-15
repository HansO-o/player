import { OctoPlayer, detectCapabilities } from '../src/index.js';

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  'player-surface', 'player-shell', 'drop-zone', 'empty-state', 'open-file', 'file-input',
  'change-file', 'play-pause', 'seek', 'current-time', 'duration', 'mute', 'volume', 'speed',
  'fullscreen', 'url-form', 'url-input', 'file-name', 'state-label', 'mode', 'renderer',
  'performance', 'mode-hint', 'video-badges', 'engine-badge', 'resolution-badge', 'video-loading',
  'loading-label', 'stat-fps', 'stat-buffer', 'stat-drift', 'stat-dropped', 'stat-threads',
  'stats-source', 'fps-sparkline', 'live-dot', 'live-label', 'environment-summary',
  'environment-dot', 'capability-list', 'notice', 'notice-text', 'dismiss-notice',
  'benchmark-duration', 'benchmark-button', 'benchmark-label', 'benchmark-hint',
  'benchmark-progress', 'export-report', 'diagnostics', 'diagnostic-json', 'event-log',
].map((id) => [id, $(id)]));

let player;
let currentSource;
let loadGeneration = 0;
let isSeeking = false;
let muted = false;
let loaded = false;
let frameHistory = [];
let eventHistory = [];
let capabilities = {};
let benchmark = null;
let lastBenchmark = null;
let sourceStarted = null;
let latestStats = {};

const stateNames = {
  idle: '就绪', loading: '加载中', ready: '已就绪', playing: '播放中', paused: '已暂停',
  buffering: '缓冲中', waiting: '缓冲中', seeking: '跳转中', ended: '播放结束',
  error: '播放失败', destroyed: '已关闭', recovering: '切换引擎',
};
const engineNames = { native: '原生视频', wasm: 'WASM 软解', webcodecs: 'WebCodecs', libmedia: 'libmedia', mse: 'MSE' };
const modeHints = {
  auto: '浏览器可以播放时使用原生通道，失败后自动回退。',
  native: '仅使用浏览器原生视频通道，适合与软解表现对比。',
  wasm: '关闭原生视频与 WebCodecs 解码，用于验证 WASM 兜底表现。',
};

function finite(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)); }
function number(value, digits = 0) { return finite(value) ? Number(value).toFixed(digits) : '—'; }
function timeLabel(seconds) {
  if (!finite(seconds) || Number(seconds) < 0) return '0:00';
  const value = Math.floor(Number(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(value % 60).padStart(2, '0')}`;
}
function safeJSON(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message, code: item.code };
    if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
    return item;
  }, 2);
}
function showNotice(message, type = 'warning') {
  elements.notice.hidden = false;
  elements.notice.className = `notice ${type}`;
  elements['notice-text'].textContent = String(message);
}
function logEvent(type, detail = {}) {
  eventHistory.unshift({ time: new Date().toISOString(), type, detail });
  eventHistory = eventHistory.slice(0, 60);
  renderEvents();
}
function renderEvents() {
  elements['event-log'].replaceChildren(...eventHistory.map((entry) => {
    const row = document.createElement('li');
    const timestamp = document.createElement('time');
    timestamp.textContent = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false });
    const label = document.createElement('span');
    const detail = entry.detail;
    label.textContent = `${entry.type}${detail?.message ? ` · ${detail.message}` : detail?.engine ? ` · ${detail.engine}` : detail?.state ? ` · ${stateNames[detail.state] || detail.state}` : ''}`;
    if (entry.type === 'error') row.className = 'event-error';
    row.append(timestamp, label);
    return row;
  }));
}
function updateDiagnostics() {
  if (!elements.diagnostics.open) return;
  try {
    elements['diagnostic-json'].textContent = safeJSON({
      capabilities,
      player: player?.getDiagnostics?.() ?? {},
      statistics: latestStats,
    });
  } catch (error) { elements['diagnostic-json'].textContent = error.message; }
}
function setPlaying(playing) {
  elements['play-pause'].dataset.playing = String(playing);
  elements['play-pause'].setAttribute('aria-label', playing ? '暂停' : '播放');
  elements['play-pause'].querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  elements['live-dot'].className = `status-dot${playing ? '' : ' neutral'}`;
  elements['live-label'].textContent = playing ? '播放中' : loaded ? '已暂停' : '待播放';
}
function updateTime(detail = {}) {
  const currentTime = detail.currentTime ?? player?.currentTime ?? 0;
  const duration = detail.duration ?? player?.duration ?? 0;
  elements['current-time'].textContent = timeLabel(currentTime);
  elements.duration.textContent = timeLabel(duration);
  if (!isSeeking) {
    elements.seek.max = finite(duration) && duration > 0 ? String(duration) : '100';
    elements.seek.value = finite(currentTime) ? String(currentTime) : '0';
    const percent = duration > 0 ? Math.max(0, Math.min(100, currentTime / duration * 100)) : 0;
    elements.seek.style.setProperty('--range-progress', `${percent}%`);
  }
  elements.seek.disabled = !loaded || !finite(duration) || duration <= 0;
}
function updateStats(stats = {}) {
  latestStats = stats;
  const fps = stats.intervalFps ?? stats.fps ?? stats.renderFps ?? stats.renderedFps;
  elements['stat-fps'].textContent = number(fps, 1);
  elements['stat-buffer'].textContent = number(stats.bufferedSeconds, 2);
  elements['stat-drift'].textContent = number(stats.avDriftMs, 0);
  elements['stat-dropped'].textContent = number(stats.droppedFrames, 0);
  elements['stat-threads'].textContent = number(stats.threads, 0);
  elements['stats-source'].textContent = stats.decoder || stats.engine || '等待数据';
  const decoder = String(stats.decoder || '').toLowerCase();
  if (decoder.includes('wasm')) elements['engine-badge'].textContent = 'WASM 软解';
  else if (decoder.includes('webcodecs')) elements['engine-badge'].textContent = 'WebCodecs';
  else if (stats.engine === 'native') elements['engine-badge'].textContent = '原生视频';
  if (finite(fps)) {
    frameHistory.push(Number(fps));
    if (frameHistory.length > 24) frameHistory.shift();
    const highest = Math.max(30, ...frameHistory);
    elements['fps-sparkline'].setAttribute('d', frameHistory.map((frame, index) => `${index ? 'L' : 'M'}${(index / Math.max(1, frameHistory.length - 1) * 120).toFixed(1)} ${(34 - frame / highest * 30).toFixed(1)}`).join(' '));
  }
  updateDiagnostics();
}
function displayMetadata(metadata = {}) {
  const { width, height } = metadata;
  if (width && height) {
    elements['resolution-badge'].textContent = `${width} × ${height}`;
    elements['resolution-badge'].hidden = false;
  }
  updateTime(metadata);
  logEvent('metadata', metadata);
}
function wirePlayer(instance, generation) {
  const listen = (event, callback) => instance.on(event, (detail) => {
    if (instance !== player || generation !== loadGeneration) return;
    callback(detail ?? {});
  });
  listen('statechange', (detail) => {
    const state = typeof detail === 'string' ? detail : detail.state;
    elements['state-label'].textContent = stateNames[state] || state || '';
    elements['video-loading'].hidden = !['loading', 'buffering', 'waiting', 'seeking', 'recovering'].includes(state);
    elements['loading-label'].textContent = state === 'loading' ? '正在读取视频' : state === 'seeking' ? '正在定位画面' : state === 'recovering' ? '正在切换播放引擎' : '正在缓冲';
    if (state === 'playing') setPlaying(true);
    if (['paused', 'ready', 'ended', 'error'].includes(state)) setPlaying(false);
    if (state !== 'playing' || eventHistory[0]?.detail?.state !== state) logEvent('statechange', { state });
  });
  listen('metadata', displayMetadata);
  listen('timeupdate', updateTime);
  listen('stats', updateStats);
  listen('enginechange', (detail) => {
    elements['engine-badge'].textContent = engineNames[detail.engine] || detail.engine || '自动';
    elements['video-badges'].hidden = false;
    logEvent('enginechange', detail);
  });
  listen('warning', (detail) => { showNotice(detail.message || String(detail)); logEvent('warning', detail); });
  listen('error', (detail) => {
    elements['video-loading'].hidden = true;
    elements['state-label'].textContent = '播放失败';
    showNotice(detail.message || '播放失败，请展开诊断查看原因。', 'error');
    logEvent('error', detail);
    setPlaying(false);
  });
  listen('ended', () => { setPlaying(false); elements['state-label'].textContent = '播放结束'; logEvent('ended'); if (benchmark) finishBenchmark('ended'); });
}
function getOptions() {
  return {
    container: elements['player-surface'],
    mode: elements.mode.value,
    renderer: elements.renderer.value,
    performance: elements.performance.value,
  };
}
async function recreatePlayer() {
  const generation = ++loadGeneration;
  if (player) await player.destroy();
  if (generation !== loadGeneration) return null;
  elements['player-surface'].replaceChildren();
  player = new OctoPlayer(getOptions());
  window.player = player;
  wirePlayer(player, generation);
  player.setVolume(Number(elements.volume.value));
  player.setMuted(muted);
  player.setPlaybackRate(Number(elements.speed.value));
  return { instance: player, generation };
}
function sourceName(source) {
  if (source instanceof File) return source.name;
  try { const url = new URL(source, location.href); return decodeURIComponent(url.pathname.split('/').pop()) || url.hostname; }
  catch { return String(source); }
}
async function openSource(source, { startTime = 0, autoplay = true } = {}) {
  if (benchmark) finishBenchmark('source-changed');
  currentSource = source;
  loaded = false;
  frameHistory = [];
  latestStats = {};
  elements.notice.hidden = true;
  elements['empty-state'].hidden = true;
  elements['video-badges'].hidden = true;
  elements['resolution-badge'].hidden = true;
  elements['video-loading'].hidden = false;
  elements['loading-label'].textContent = '正在读取视频';
  elements['file-name'].textContent = sourceName(source);
  elements['file-name'].title = sourceName(source);
  elements['state-label'].textContent = '加载中';
  elements['play-pause'].disabled = true;
  elements['benchmark-button'].disabled = true;
  updateStats({});
  updateTime({ currentTime: 0, duration: 0 });
  setPlaying(false);
  let context;
  try {
    context = await recreatePlayer();
    if (!context) return;
    await context.instance.load(source);
    if (context.generation !== loadGeneration) return;
    loaded = true;
    sourceStarted = new Date().toISOString();
    elements['play-pause'].disabled = false;
    elements['benchmark-button'].disabled = false;
    elements['video-loading'].hidden = true;
    elements['state-label'].textContent = '已就绪';
    if (startTime > 0) await context.instance.seek(startTime);
    updateTime();
    if (autoplay) {
      try { await context.instance.play(); setPlaying(true); }
      catch (error) {
        showNotice(error.name === 'NotAllowedError' ? '视频已就绪，请点播放按钮以启用声音。' : error.message);
        setPlaying(false);
      }
    }
    updateDiagnostics();
  } catch (error) {
    if (context && context.generation !== loadGeneration) return;
    elements['video-loading'].hidden = true;
    elements['state-label'].textContent = '播放失败';
    showNotice(error.message || String(error), 'error');
    logEvent('error', { message: error.message || String(error), code: error.code });
  }
}

function exportJSON(report, filename) {
  const blob = new Blob([safeJSON(report)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function report() {
  const engineReport = player?.exportReport?.() ?? {};
  return {
    ...engineReport,
    exportedAt: new Date().toISOString(),
    source: currentSource ? { local: currentSource instanceof File, size: currentSource instanceof File ? currentSource.size : null, openedAt: sourceStarted } : null,
    settings: { mode: elements.mode.value, renderer: elements.renderer.value, performance: elements.performance.value },
    capabilities,
    statistics: latestStats,
    playbackTelemetry: engineReport.benchmark,
    benchmark: lastBenchmark,
    events: eventHistory.map(({ time, type, detail }) => ({ time, type, state: detail?.state, code: detail?.code, engine: detail?.engine })),
    note: 'Observed on this device only. Native playback does not prove hardware decoding. Missing values are not estimated.',
  };
}
function mean(values) {
  const numbers = values.filter(finite).map(Number);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}
function finishBenchmark(reason = 'complete') {
  if (!benchmark) return;
  clearInterval(benchmark.timer);
  const completed = benchmark;
  benchmark = null;
  const validSamples = completed.samples.filter((sample) => !sample.paused && !sample.pageHidden && sample.state === 'playing');
  lastBenchmark = {
    startedAt: completed.startedAt,
    requestedDurationSeconds: completed.duration,
    elapsedSeconds: (performance.now() - completed.start) / 1000,
    stopReason: reason,
    samples: completed.samples,
    summary: {
      sampleCount: completed.samples.length,
      foregroundPlayingSampleCount: validSamples.length,
      meanPresentedFps: mean(validSamples.map((sample) => sample.intervalFps ?? sample.fps ?? sample.renderFps ?? sample.renderedFps)),
      meanBufferedSeconds: mean(validSamples.map((sample) => sample.bufferedSeconds)),
      meanAbsoluteAvDriftMs: mean(validSamples.map((sample) => finite(sample.avDriftMs) ? Math.abs(Number(sample.avDriftMs)) : null)),
    },
  };
  elements['benchmark-button'].classList.remove('recording');
  elements['benchmark-label'].textContent = '重新记录';
  elements['benchmark-duration'].disabled = false;
  elements['benchmark-progress'].hidden = true;
  const elapsed = lastBenchmark.elapsedSeconds.toFixed(1);
  elements['benchmark-hint'].textContent = `已记录 ${elapsed} 秒、${completed.samples.length} 个样本。点击「导出诊断」保存。`;
  logEvent('benchmark', { message: `Recorded ${elapsed}s; ${reason}` });
  showNotice(`记录完成：${elapsed} 秒。已纳入诊断报告，可导出 JSON。`, 'success');
}
function startBenchmark() {
  if (benchmark) { finishBenchmark('manual'); return; }
  if (!loaded) return;
  const duration = Number(elements['benchmark-duration'].value);
  benchmark = { duration, startedAt: new Date().toISOString(), start: performance.now(), samples: [], timer: null };
  elements['benchmark-button'].classList.add('recording');
  elements['benchmark-duration'].disabled = true;
  elements['benchmark-progress'].hidden = false;
  elements['benchmark-progress'].firstElementChild.style.width = '0%';
  elements['benchmark-label'].textContent = '停止记录';
  elements['benchmark-hint'].textContent = '记录中 · 请保持页面可见，并持续播放视频。';
  benchmark.timer = setInterval(() => {
    if (!benchmark) return;
    const elapsed = (performance.now() - benchmark.start) / 1000;
    const sample = player.getStats();
    benchmark.samples.push({ ...sample, elapsedSeconds: elapsed, currentTime: player.currentTime, paused: player.paused, pageHidden: document.hidden });
    elements['benchmark-label'].textContent = `停止记录 · ${Math.max(0, duration - Math.floor(elapsed))}s`;
    elements['benchmark-progress'].firstElementChild.style.width = `${Math.min(100, elapsed / duration * 100)}%`;
    if (elapsed >= duration) finishBenchmark();
  }, 1000);
}

elements['open-file'].addEventListener('click', () => elements['file-input'].click());
elements['change-file'].addEventListener('click', () => elements['file-input'].click());
elements['file-input'].addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) openSource(file);
  event.target.value = '';
});
elements['url-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  const value = elements['url-input'].value.trim();
  if (value) openSource(value);
});
document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => {
  openSource(new URL(`fixtures/${button.dataset.sample}`, document.baseURI).href);
}));
let dragDepth = 0;
elements['drop-zone'].addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; elements['drop-zone'].classList.add('drag-over'); });
elements['drop-zone'].addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
elements['drop-zone'].addEventListener('dragleave', (event) => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) elements['drop-zone'].classList.remove('drag-over'); });
elements['drop-zone'].addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; elements['drop-zone'].classList.remove('drag-over');
  const file = event.dataTransfer?.files?.[0];
  if (file) openSource(file);
});
async function togglePlay() {
  if (!loaded || !player) return;
  try {
    if (player.paused) { await player.play(); setPlaying(true); }
    else { await player.pause(); setPlaying(false); if (benchmark) finishBenchmark('paused'); }
  } catch (error) { if (error.name !== 'AbortError') showNotice(error.message, 'error'); }
}
elements['play-pause'].addEventListener('click', togglePlay);
elements['drop-zone'].addEventListener('keydown', (event) => {
  if (event.target !== elements['drop-zone']) return;
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (loaded) togglePlay(); else elements['file-input'].click(); }
  else if (loaded && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault();
    player.seek(Math.max(0, Math.min(player.duration || Infinity, player.currentTime + (event.key === 'ArrowRight' ? 5 : -5)))).catch((error) => showNotice(error.message, 'error'));
  }
});
elements.seek.addEventListener('input', () => { isSeeking = true; elements['current-time'].textContent = timeLabel(elements.seek.value); elements.seek.style.setProperty('--range-progress', `${Number(elements.seek.value) / Number(elements.seek.max) * 100}%`); });
elements.seek.addEventListener('change', async () => {
  try { await player.seek(Number(elements.seek.value)); }
  catch (error) { showNotice(error.message, 'error'); }
  finally { isSeeking = false; updateTime(); }
});
elements.mute.addEventListener('click', () => {
  muted = !muted;
  player?.setMuted(muted);
  elements.mute.setAttribute('aria-pressed', String(muted));
  elements.mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
  elements.mute.querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume');
});
elements.volume.addEventListener('input', () => { player?.setVolume(Number(elements.volume.value)); elements.volume.style.setProperty('--range-progress', `${Number(elements.volume.value) * 100}%`); });
elements.speed.addEventListener('change', () => { player?.setPlaybackRate(Number(elements.speed.value)); });
elements.fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (elements['player-shell'].requestFullscreen) await elements['player-shell'].requestFullscreen();
    else {
      const video = elements['player-surface'].querySelector('video');
      if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else showNotice('当前浏览器不支持此播放通道的全屏模式。');
    }
  } catch (error) { showNotice(error.message); }
});
for (const id of ['mode', 'renderer', 'performance']) {
  elements[id].addEventListener('change', async () => {
    elements['mode-hint'].textContent = modeHints[elements.mode.value];
    const time = player?.currentTime || 0;
    const autoplay = player ? !player.paused : true;
    if (currentSource) await openSource(currentSource, { startTime: time, autoplay });
    else { try { await recreatePlayer(); } catch (error) { showNotice(error.message, 'error'); } }
  });
}
elements['dismiss-notice'].addEventListener('click', () => { elements.notice.hidden = true; });
elements['benchmark-button'].addEventListener('click', startBenchmark);
elements['export-report'].addEventListener('click', () => { exportJSON(report(), `octo-player-${new Date().toISOString().replace(/[:.]/g, '-')}.json`); });
elements.diagnostics.addEventListener('toggle', updateDiagnostics);
document.addEventListener('visibilitychange', () => { if (benchmark && document.hidden) showNotice('页面已进入后台；报告会标记后台采样，避免误判前台帧率。'); });
window.addEventListener('pagehide', () => { if (benchmark) clearInterval(benchmark.timer); player?.destroy(); });

function capabilityValue(...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((object, part) => object?.[part], capabilities);
    if (typeof value === 'boolean') return value;
    if (typeof value?.supported === 'boolean') return value.supported;
  }
  return null;
}
async function initialize() {
  try { await recreatePlayer(); }
  catch (error) { showNotice(error.message, 'error'); logEvent('error', { message: error.message }); }
  try {
    capabilities = await detectCapabilities();
    const isolated = capabilityValue('crossOriginIsolated', 'isolated', 'isolation');
    elements['environment-summary'].textContent = isolated === true ? '跨域隔离已启用 · 可用多线程' : '标准环境 · 多线程可能受限';
    elements['environment-dot'].className = `status-dot${isolated ? '' : ' warning'}`;
    const available = [
      ['WASM', capabilityValue('wasm', 'webAssembly') ?? typeof WebAssembly !== 'undefined'],
      ['SIMD', capabilityValue('simd', 'wasmSimd')],
      ['共享内存', capabilityValue('sharedArrayBuffer', 'sharedMemory', 'threads') ?? (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated)],
      ['WebCodecs', capabilityValue('webCodecsVideo', 'webcodecs', 'webCodecs', 'videoDecoder') ?? typeof VideoDecoder !== 'undefined'],
      ['WebGPU', capabilityValue('webgpu', 'webGPU') ?? Boolean(navigator.gpu)],
      ['AudioWorklet', capabilityValue('audioWorklet') ?? typeof AudioWorkletNode !== 'undefined'],
    ];
    elements['capability-list'].replaceChildren(...available.map(([name, supported]) => {
      const chip = document.createElement('span');
      chip.className = `capability-chip${supported === true ? '' : ' unavailable'}`;
      chip.textContent = `${supported === true ? '✓ ' : supported === false ? '− ' : '? '}${name}`;
      chip.title = supported === true ? `${name} 可用` : supported === false ? `${name} 不可用` : `${name} 未确认`;
      return chip;
    }));
    logEvent('capabilities', capabilities);
    updateDiagnostics();
  } catch (error) {
    elements['environment-summary'].textContent = '环境检测失败 · 仍可尝试播放';
    elements['capability-list'].textContent = '请查看诊断';
    logEvent('warning', { message: error.message });
  }
}

initialize();
