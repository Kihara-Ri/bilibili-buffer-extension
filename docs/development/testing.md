# 测试与验收

> 适用版本：v2.16.1 工作树 · 最后核对：2026-11-22

提交前必须通过 `npm run check` 与 `npm test`。改到浏览器侧行为时，再跑对应的浏览器套件。

## 1. 分层

| 层 | 命令 | 是否联网 | 内容 |
| --- | --- | --- | --- |
| 语法与版本门禁 | `npm run check` | 否 | 全部 `.js` / `.mjs` 跑 `node --check`；本机 Chrome 主版本必须在 `browser-compat.json` 的已验收列表里 |
| 单元与 Node 集成 | `npm test` | 否 | `tests/*.test.mjs`，不启动浏览器 |
| 弹窗与后台链路 | `npm run test:popup` | 否 | 真实 Chromium 加载 `popup.html`，并执行 background / offscreen 消息链路夹具。用真实 IndexedDB 和可控的取源响应验证任务命令交错、多任务预算、整文件顺序流让行。另有启动 pending、选择隔离、评价邀请与工具栏关闭后删除的回归 |
| 在线网络 | `npm run test:network` | 否 | 受控延迟与需求响应：`run-playback-network.mjs` + `run-playback-demand.mjs` |
| 在线播放 | `npm run test:playback` | 否 | 真实 AVC/AAC 夹具驱动 MediaSource 双轨播放、拖动、零网络命中 |
| 生产扩展 | `npm run test:extension` | 否 | 加载生产包验证注入、命中、热重载（标记和 SHA-256）、离线片库播放与拖动、分 P 竞态及坏档回退。用本机 HTTP Range 检查 Offscreen 让行、完全缓冲进页启动与本地换源 |
| AI 下载工具 | `npm run test:mcp` | 否 | 通过真实 MCP 管道和 Chromium 验证 P3–P7 的原轨音频、原字幕与预算，重连续传、暂停、取消、仅重试失败的分 P |
| AI 下载连接器 | `npm run test:mcp:native` | 否 | 在临时 Chrome 资料中启动原生连接器。由本机 HTTPS 夹具核对浏览器附上的会话，覆盖已有登录、确认登出、网络故障、恢复登录、重启、断开与导出 |
| 同版浏览器 | `npm run test:chrome` | 下载浏览器 | 取与本机 Chrome 同构建的 Chrome for Testing，重跑 `browser-compat.json` 列出的套件 |
| 官网 | `npm run test:site` | 否 | 375 / 1280 宽度、演示加载、深色、减少动态 |
| 真实站点 | `npm run test:live [-- <视频地址>]` | **是** | 真实 B 站视频走完整缓存再播放，画质取决于测试 Chrome 的账号权限 |

`npm test` 由 `scripts/run-tests.mjs` 启动：用脚本自身位置推出仓库根，并在找不到任何测试文件时直接失败。不用 `node --test tests/*.test.mjs` 是因为 Windows 的 npm 经 `cmd.exe` 执行，`cmd.exe` 既不展开 `*`，也不支持 WSL 的 UNC 工作目录，会以「0 个测试、退出码 0」假通过。

## 2. 浏览器套件的前提

- 需要 Playwright：`npm install` 会装上 `devDependencies` 里的 `playwright`，首次还需 `npx playwright install chromium`。也可以用 `PLAYWRIGHT_MODULE=/绝对路径/playwright/index.mjs` 复用已有安装。
- 受控浏览器套件使用独立临时资料目录。真实 B 站测试可复用专用测试 Chrome 保存的登录状态。
- AI 下载连接器的临时资料测试在 macOS 和 Linux 运行，用 `openssl` 为本机 HTTPS 夹具生成临时证书。
- 品牌版 Chrome 137+ 忽略 `--load-extension`，所以套件使用 Playwright 的 Chromium / Chrome for Testing；`scripts/lib/browser-launch.mjs` 支持用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定可执行文件（`test:chrome` 就是这样换浏览器的）。
- Chromium 会向未打包扩展目录写入 `_metadata/`，测试结束后清理，才能与生产 zip 逐文件一致。

`run-full-buffering.mjs` 用可控 HTTP Range 服务延后媒体正文，验证自适应的单视频缓存入口、全速档的进页启动与并行播放、旧设置迁移、选档和复用。完成后断开浏览器网络，在播放与暂停中各做六次跨位置 seek。`requestVideoFrameCallback` 核对目标帧的 `mediaTime`，记录跳转指令到该帧预计显示时间的 P50 与 P95。测试包含单文件 MP4、由真实双轨样本合并的 MP4，以及同一单文件直接用 Blob 打开的基线。

`run-committed-playback.mjs` 用发布包打开有部分落盘分块的页面，覆盖双轨进度标记、由播放器预先追加已落盘的分片、暂停后恢复原缓冲目标，以及切画质或删除任务后更新标记。夹具拒绝全部媒体网络请求，验证跨 CDN 地址的按需跳转和 17 MiB 的完整 Range 都能从片库读出。

### 2.1 保留真实 B 站测试的登录状态

```sh
npm run live:browser -- --login
```

在独立测试 Chrome 的 B 站页面完成一次登录。命令确认站点登录有效后关闭窗口。Chrome 把会话保存在仓库外的本机专用目录。macOS 路径为 `~/Library/Application Support/Haineicunzhi/Bilibili Test Chrome`。B 站判定会话失效时可重跑登录命令。

之后 `npm run live:browser` 打开同一套资料，也可以在 `--` 后指定一个 B 站视频地址。`npm run test:live` 和 `npm run test:live:playback` 自动复用已初始化的专用资料。需要全新匿名环境时给测试命令加 `-- --anonymous`。运行测试前关闭前一轮的专用窗口，让 Chrome 释放资料目录。

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

## CDN 救援对照与真实播放

- `npm run test:cdn`：真实 Chromium 中交错运行基线 9123e48 与当前调度器，十类网络场景各三次；条件由路由注入，不是自然线路测速。
- `npm run test:live:playback` 在独立测试 Chrome 中加载真实视频并验证 seek 后继续播放。加 `-- --fail-originals` 会阻断清单主备域，保留镜像真实请求。带登录状态的运行记录聚合统计和主机名。测 CDN 时若视频已命中本地缓存，可选另一个视频或使用 `--anonymous`。
- 具体结果、退化情况与未覆盖画质见 [2.16.0 验收记录](../research/2026-10-26-cdn-recovery-validation.md)。

故障注入主机同时从内联清单与观察器实际轨道识别；必须有至少一次真实原线路阻断，且新增镜像请求存在、seek 后播放继续，才算接手验收通过。只看到视频继续播放不足以证明故障已注入。
