# 测试与验收

> 适用版本：v2.13.0 · 最后核对：2026-10-24

提交前必须通过 `npm run check` 与 `npm test`。改到浏览器侧行为时，再跑对应的浏览器套件。

## 1. 分层

| 层 | 命令 | 是否联网 | 内容 |
| --- | --- | --- | --- |
| 语法与版本门禁 | `npm run check` | 否 | 全部 `.js` / `.mjs` 跑 `node --check`；本机 Chrome 主版本必须在 `browser-compat.json` 的已验收列表里 |
| 单元与 Node 集成 | `npm test` | 否 | `tests/*.test.mjs`，不启动浏览器 |
| 弹窗与后台链路 | `npm run test:popup` | 否 | 真实 Chromium 加载真实 `popup.html`；同一运行器执行 background / offscreen 消息链路夹具 |
| 在线网络 | `npm run test:network` | 否 | 受控延迟与需求响应：`run-playback-network.mjs` + `run-playback-demand.mjs` |
| 在线播放 | `npm run test:playback` | 否 | 真实 AVC/AAC 夹具驱动 MediaSource 双轨播放、拖动、零网络命中 |
| 生产扩展 | `npm run test:extension` | 否 | 先 `npm run build`，再加载生产包验证注入、命中与热重载（标记 + SHA-256） |
| 同版浏览器 | `npm run test:chrome` | 下载浏览器 | 取与本机 Chrome 同构建的 Chrome for Testing，重跑上面四个浏览器套件 |
| 官网 | `npm run test:site` | 否 | 375 / 1280 宽度、演示加载、深色、减少动态 |
| 真实站点 | `npm run test:live [-- <视频地址>]` | **是** | 真实 B 站视频走完整缓存再播放；匿名身份只能取到 480P，不进 `npm test` |

`npm test` 由 `scripts/run-tests.mjs` 启动：用脚本自身位置推出仓库根，并在找不到任何测试文件时直接失败。不用 `node --test tests/*.test.mjs` 是因为 Windows 的 npm 经 `cmd.exe` 执行，`cmd.exe` 既不展开 `*`，也不支持 WSL 的 UNC 工作目录，会以「0 个测试、退出码 0」假通过。

## 2. 浏览器套件的前提

- 需要 Playwright：`npm install` 会装上 `devDependencies` 里的 `playwright`，首次还需 `npx playwright install chromium`。也可以用 `PLAYWRIGHT_MODULE=/绝对路径/playwright/index.mjs` 复用已有安装。
- 一律用独立的临时 profile，不复制用户登录态。
- 品牌版 Chrome 137+ 忽略 `--load-extension`，所以套件使用 Playwright 的 Chromium / Chrome for Testing；`scripts/lib/browser-launch.mjs` 支持用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定可执行文件（`test:chrome` 就是这样换浏览器的）。
- Chromium 会向未打包扩展目录写入 `_metadata/`，测试结束后清理，才能与生产 zip 逐文件一致。

## 3. 在用户现有 Chrome 里的受控探针

以下脚本连接用户**已打开**的 macOS Chrome（需在 Chrome 开启「允许 Apple 事件中的 JavaScript」），不启动浏览器、不复制 profile、不导出凭据。它们是正确性探针，不是测速：

| 脚本 | 用途 |
| --- | --- |
| `node tests/run-existing-reuse-probe.mjs <pid> <tab>` | 真实 IndexedDB / Blob 下的离线镜像：写入、跨主机复用、孔洞、账户隔离、清理 |
| `node tests/run-existing-cache-probe.mjs <pid> <tab>` | 在隔离包装器里验证页面缓存，不改动页面真实的 fetch / XHR |

另有 `node scripts/benchmark-range-download.mjs [BV号] [块大小MiB]`：在 Node 里直连 B 站接口与 CDN，对比离线 Range 下载的节点与块大小。它请求的是老的 `/x/web-interface/view` 接口，非网页指纹下可能被 HTTP 412 拒绝（见[完整缓存 · 视频信息](../architecture/offline-cache.md#12-视频信息)）。

## 4. 原则

- **修 bug 先写能复现的测试**，确认它失败，再改代码。
- 截图和构建成功不能代替行为断言：弹窗的实时刷新必须由浏览器测试检查节点身份、hover 动画次数、焦点与 pending 保留（见[弹窗 · 实时刷新规则](../architecture/popup.md#2-实时刷新规则)）。
- 夹具要复用生产实现，而不是复制一份策略——2.8.8 曾因消息桩与后台实现漂移，让浏览器套件在「下载完成」处静默超时却无人察觉（见 [Chrome 154 故障记录](../history/2.8.8-chrome-154-incident.md)）。
- 受控网络与真实线路的结果分开报告；模型里的数字不能当作实网性能承诺。
- `tests/playback-documentation.test.mjs` 守住 README 与技术文档：必须提到 SIDX、128 MiB 和当前版本号，不得出现已废弃的旧说法；技术文档必须写明 `适用版本：v<当前版本>`。
