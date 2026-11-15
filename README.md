# Octo Player

一个纯 JavaScript 网页播放库：**原生 `<video>` 优先，WebCodecs / MSE 次之，真实 WASM 音视频软解兜底**。带响应式演示页、拖放/本地文件、URL 播放、性能诊断和 JSON 基准报告。

解码内核使用固定版本 **libmedia 1.3.1 + FFmpeg / dav1d**，不是从零自研编解码器。本仓库实现播放路径选择、生命周期、原生音频兼容探测、版本受控的线程配置补丁、性能监测、资源打包和测试。所有业务代码均为 JavaScript。

## 运行

需要 Node.js 22.12+，推荐 Node.js 24。

```bash
npm ci
npm run dev
```

打开终端显示的本地地址。页面可直接播放仓库自带的 H.265 + AAC、AV1 + Opus 原创测试片，也可以拖入自己的视频。**本地文件只在浏览器读取，不上传。**

```bash
npm run build
npm run preview
```

`dist/` 是完整静态站点，包含演示页、库和按需加载的解码器。可部署到普通静态服务器或 Cloudflare Workers Static Assets；仓库已提供 `wrangler.jsonc`，构建命令为 `npm run build`，部署命令为 `npx wrangler deploy`。`dist/lib/player.js` 是 ES Module 库入口。

首次构建需要从固定 Git commit 下载约 30 MiB 的解码资源；之后会校验并复用。**不需要在播放时访问 jsDelivr 或其他公共 CDN**。只会加载当前媒体需要的解码器；原生视频路径不加载 libmedia / WASM。

## 接入自己的网页

将 `dist/lib/` 和 `dist/vendor/` 部署到同一网站，保留各目录内部结构。

```html
<div id="player" style="width:100%;aspect-ratio:16/9"></div>
<button id="play">播放</button>
<script type="module">
  import { OctoPlayer } from '/lib/player.js';

  const player = new OctoPlayer({
    container: '#player',
    assetBase: '/vendor/libmedia/',
    mode: 'auto',                // auto | native | wasm
    renderer: 'auto',            // auto | webgl | webgpu
    performance: 'balanced',     // balanced | max
    bufferTarget: 1.5,           // 压缩包预读秒数，范围 0.25–8
  });

  player.on('error', ({ message }) => console.error(message));
  player.on('stats', stats => console.log(stats));
  await player.load('/movie.mp4');
  document.querySelector('#play').onclick = () => player.play();
</script>
```

`load()` 也接受 `File`、`Blob` 和 `{ src, type, name, headers, credentials }`。自定义 HTTP headers 用于 libmedia 路径；原生 `<video>` 不能设置任意请求头，此时应选择 `mode: 'wasm'`，或使用可直接访问的签名 URL。

### API

| 方法 / 属性 | 用途 |
| --- | --- |
| `await player.load(source, { startTime: 0 })` | 加载或换源；旧操作会中止 |
| `await player.play()` / `await player.pause()` | 播放 / 暂停；第一次有声播放应由用户点击触发 |
| `await player.seek(seconds)` | 跳转；对同一实例的 seek 请求按顺序处理 |
| `setVolume(0…1)` / `setMuted(boolean)` | 音量 / 静音 |
| `setPlaybackRate(0.25…4)` | 倍速 |
| `currentTime` / `duration` / `paused` | 秒数与播放状态 |
| `getStats()` | 当前实际统计；不可获得的指标为 `null` |
| `getDiagnostics()` / `exportReport()` | 路径、能力、错误与基准报告 |
| `await player.destroy()` | 释放当前视频、Worker、对象 URL 和监听器 |
| `on(event, callback)` | 返回取消监听函数 |

事件：`statechange`、`enginechange`、`metadata`、`timeupdate`、`stats`、`warning`、`error`、`playing`、`pause`、`seeking`、`seeked`、`ended`。业务界面可只订阅需要的事件。保持容器有非零尺寸。

## 播放策略

1. **原生路径**：直接使用 `<video>` 的解码、渲染和音频输出；没有逐帧 canvas 拷贝或 WASM 转码。浏览器自行选择硬件解码。只做低频统计，不把“原生播放”误标为“硬解已证实”。
2. **兼容路径**：原生容器/音视频编码不支持、加载超时或中途解码失败时，保留播放位置和音量，切换到 libmedia。其可使用 MSE、WebCodecs 硬件优先配置及 WASM 回退。
3. **强制软解**：`mode: 'wasm'` 禁用 MSE 和 WebCodecs。测试会核对真实解码器，不允许自动退回 MSE 伪装成软解。没有可用 GPU 渲染上下文时明确报错。
4. **独立音频管线**：AAC、Opus 等音频独立解码，通过 Web Audio / AudioWorklet 输出，以音频时钟同步视频，避免视频压力让主线程直接堵住音频回调。

软解内核包含 SIMD / 标量变体、Worker、SharedArrayBuffer、多线程、OffscreenCanvas 和 WebGL / WebGPU 渲染。WebGPU 在这里主要负责 YUV 转色、缩放与显示，**不等于把 HEVC/AV1 整个解码过程搬到 GPU**。

`balanced` 为 UI 留出一个逻辑核心，并将请求线程预算限制到 8；`max` 使用浏览器报告的全部逻辑核心。也可显式设置 `threads: 4`。无跨源隔离时会降为单线程。实际线程配置通过解码 Worker 的 RPC 返回；还未得到结果时显示 `null`。更多线程可能增加内存、调度开销和温度，并不必然更快。

### 缓冲与流畅性

默认预读约 1.5 秒**压缩包**，不是堆积大量 4K RGBA 图像。解码与音频输出有独立管线；上游根据音频时钟丢弃迟到的视频帧，并在持续过载时跳过安全的非参考帧。监控器会报告持续丢帧或超过 500 ms 的音画偏差。

缓冲能吸收短时网络/解码波动。若设备平均只能解 25 fps，它不能让 30 fps 视频永久无损实时播放；若 60 fps 素材只能维持约 40 fps，也不能保证均匀的 40 fps 时间间隔。本项目不伪造帧率，不做未实现的补帧承诺。

## 部署要求

通过 HTTPS 或 localhost 提供页面，并为页面配置：

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite 开发 / 预览服务器与 `public/_headers` 已包含这些响应头。只把 `_headers` 文件放到 Nginx 并不会自动生效，Nginx 等服务器需要配置同名响应头。不要用 `file://` 直接打开 HTML。

跨域视频与分段资源需满足 CORS / CORP 及页面 COEP 规则；WASM 的 Fetch 读取需要 CORS，远程快速 seek 需要源站正确处理 HTTP Range。原生模式在隔离页面默认使用匿名 CORS，可通过 `crossOrigin` 选项指定；没有隔离时默认不强制 CORS。

本库不会向第三方上传媒体；导出的基准不含完整源 URL、访问令牌或本地文件名。错误消息由应用决定如何展示，生产日志不要盲目收集第三方返回的原始错误。

## 验证与性能目标

```bash
npm test
npm run build
npx playwright install --with-deps
npm run test:e2e
```

端到端测试使用真实 H.265 / Main10 / AV1 视频和 AAC / Opus 音频，检查帧计数、画面变化及非零 PCM，还覆盖 seek、暂停恢复、无隔离回退、本地文件、原生懒加载和失败处理。CI 保存运行日志、截图、trace 和 JSON 证据。详细记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

**“四种浏览器最近两个大版本”“老旧手机 1080p30 不掉帧”“较新设备 4K30/4K60”是验收目标，不是本仓库已经在所有设备达成的保证。** 需要在指定真机、码流、功耗和温度条件下测试。Playwright WebKit 不等于实际 Safari；Linux Chromium 不等于所有 Chrome/Edge 系统构建。也尚未与 B 站 WasmPlayer 使用同一素材、同一设备进行对照。

页面提供 10/30 秒记录。建议对同一个文件分别测 `auto`、`wasm + balanced`、`wasm + max`，关注呈现 FPS、丢帧、最大帧间隔、音频中断和热降频。浏览器没有可移植的全进程 CPU 占用 API，CPU/功耗请用系统工具测量。

## 许可证与来源

本项目分发组合采用 **GPL-3.0-or-later**。libmedia JS 原为 LGPL-3.0-or-later，但所使用的预编译 FFmpeg WASM 启用了 GPL，不能把整套分发物标成 MIT。完整许可证、精确源码版本、二进制 SHA-256、构建脚本与本仓库补丁见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md) 和 [scripts/libmedia-assets.json](scripts/libmedia-assets.json)。

技术依据：[libmedia 源码与文档](https://github.com/zhaohappy/libmedia)、[WebCodecs 标准](https://www.w3.org/TR/webcodecs/)、[跨源隔离说明](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated)。
