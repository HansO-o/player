# 验证记录与性能验收

## 本次验证的范围

自动测试使用 `public/fixtures/` 内自行生成的短片和纯音频：移动测试图像和
440 Hz 正弦音频，视频为 320×180、24 fps，文件均约 5 秒。生成脚本、FFmpeg 版本、
视频/音频格式和 SHA-256 见同目录的 `manifest.json`。

这些素材用于证明解封装、解码、画面输出和音频输出实际工作，不能用来
证明老旧手机 1080p30 或任何设备上的 4K 性能。浏览器测试报告会保存
浏览器 User-Agent、实际统计、跨源隔离状态、音频信号峰值和错误事件。

## 可复现自动测试

```sh
npm ci
npm run assets
npm test
npx playwright install chromium firefox webkit
npm run test:e2e
```

测试由 Playwright 启动专用 Node 静态服务器，支持 HTTP Range 并设置
COOP/COEP。服务器不进行热重载，真实 404 也不会替换为 SPA 页面。可用系统 Chromium
代替下载版本时，通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定二进制路径。

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e -- --project=chromium
```

测试结果和失败追踪保存在 `test-results/`。每项播放测试附带
`playback-evidence` JSON，方便核对实际走过的路径。

| 验证项 | 验证依据 |
| --- | --- |
| 强制 WASM HEVC Main + AAC | 视频和音频输出计数增长、画面截图改变、非零 PCM |
| 强制 WASM AV1 + Opus | 同上，并验证 WebM 路径 |
| 强制 WASM HEVC Main 10 + AAC | 同上，并验证 10-bit 渲染 |
| 强制 WASM 纯音频 | AAC/M4A 与 Opus/Ogg 的解码计数、输出状态和非零 PCM |
| 最大线程策略 | 解码器 RPC 返回实际线程数，范围不超过请求的 CPU 预算 |
| 暂停、跳转、恢复 | 原生和 WASM 各自验证暂停时间稳定、跳转后从新时间继续播放 |
| 本地 File | 解码播放，播放过程中不向外部域名发请求 |
| 原生路径 | 时间推进，不请求 WASM 或 libmedia 引擎资源 |
| 自动回退 | 原生边界注入解码错误后，真实回退引擎重新打开并播放同一个文件 |
| 缺少跨源隔离 | 删除顶层 COOP/COEP 后实际解码 HEVC 和输出音频 |
| 纯音频缺少跨源隔离 | 无共享内存时 AAC 仍走 WASM 并输出非零 PCM |
| 错误资源 | 不存在的媒体地址返回错误，不报告播放成功 |

音频测试在原有 Web Audio 图上添加静音分析分支；原输出链路不变，
通过 `AnalyserNode` 读取非零 PCM。它验证音频确实走到输出图，
不等于人工听音或物理扬声器质量测试。

## 环境与结果

本地功能验证日期：**2026-11-15**。测试宿主为 Linux；设备预设中的
User-Agent 可显示 Windows/macOS，这不是实际硬件信息。

| 环境 | 本地结果 |
| --- | --- |
| Node 24.22.1 / FFmpeg 7.1.5 | 6 个素材的字节数和 SHA-256 校验通过，合计 658,699 字节 |
| Firefox 159.0 / Playwright 1.65.1 | 4 项通过：原生暂停/跳转/恢复；原生路径不加载 WASM；原生失败后回退引擎继续播放；404 资源拒绝 |
| Firefox 159.0 的 WASM 视频路径 | 当前宿主无法创建 WebGL/WebGL2 上下文，即使启用软件渲染设置也报 `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`；完整视频软解输出未验证 |
| Firefox 159.0 的 Web Audio 输出 | 独立于播放器的 AudioContext + Oscillator 控制实验也停在 suspended、时间 0；本地宿主无法验证 PCM 输出 |
| 系统 Chromium 156.0.8078.79 | 浏览器启动前被执行宿主禁止本地进程 socket，未进入页面；不能视为播放器测试通过或失败 |
| Playwright WebKit 27.2 | 二进制已下载，但宿主缺少 GTK4、Graphene 等运行库，未运行 |
| 真实 Chrome / Edge / Safari、手机 | 本地未验证 |

上述 4 项通过来自明确选取的功能子集，**不是完整 14 项套件全部通过**。
最新本地命令：

```sh
npm run test:e2e -- --project=firefox --grep 'native pause|native fast|auto recovers|HTTP errors'
# 4 passed (9.4s)
```

测试发现并推动修复了两个可观察问题：强制 WASM 不能静默转为 MSE；
有音轨却未启动音频输出时不能报告播放成功。测试始终保留真实图像和
非零 PCM 断言，不因本地环境缺失而跳过这些验收条件。完整套件应在
具备可用图形和音频输出环境的 CI/真实设备上继续运行，并以其报告更新结果。

Playwright WebKit 即使通过，也不能代替真实 macOS/iOS Safari 的验证。

## 仍需真实设备验证的验收条件

以下均为产品目标，而非本次短片功能测试已经达成的结论：

- Chrome、Edge、Firefox、Safari 最近两个正式大版本。
- 老旧手机 HEVC 1080p30 持续实时播放。
- 新设备 HEVC/AV1 4K30 软解，以及 4K60 降帧后的稳定观感。
- 原生路径 CPU 与裸 `<video>` 的对比。
- 与 B 站 WasmPlayer 在同设备、同码流、同温度下的性能比较。

### 设备上的测试方法

1. 记录设备型号、系统和浏览器版本、视频 codec/profile/bit depth、码率、
   分辨率、帧率，以及页面的隔离/线程/SIMD/GPU 检测结果。
2. 同一文件分别运行自动、原生、强制 WASM。硬件解码不能只靠“支持该格式”
   推断；浏览器支持检测和实际硬件状态必须分开记录。
3. 至少准备 HEVC 和 AV1 的 1080p30、4K30、4K60，覆盖低运动/高运动、
   8-bit/10-bit、AAC/Opus。不要用低码率静态画面代替复杂内容。
4. 正常播放预热后记录 30 秒以上，持续播放 10 分钟观察温升后的变化。
   记录输出帧率、解码速度、丢帧、重缓冲次数/时长、音频错误、音画偏差，
   并导出页面的 JSON 报告。
5. 人工试听，确认声音连续、没有爆音，跳转后音画同步恢复。手机应包含
   锁屏/切后台/回前台、横竖屏和系统打断后的恢复测试。
6. CPU 对比应使用同一设备上的浏览器/系统性能工具，控制播放窗口大小、
   电源状态和文件来源；网页本身不能可靠读取整个进程的 CPU 百分比。

缓冲只能吸收临时波动。若持续解码吞吐量小于源帧率，增加缓冲会耗尽，
仍需正确丢弃适合丢弃的帧、降低输出负担或选择较低复杂度的码流。
音频时间轴应持续前进；不能通过拖慢时间或无限累积延迟伪装成“流畅”。
