# AI 下载工具

本地 MCP 通过标准输入输出接收请求，交给已连接的 Chrome 资料中的海内存知。扩展沿用该资料的 B 站登录与片库。视频默认选当前账号可用的最高画质，音频优先 Hi-Res 原轨。工具支持标准 BV／av 视频、分 P、带 `bvid` 的列表页和 `b23.tv` 分享短链。

## 接入 Codex

使用带「AI 下载」入口的扩展版本。已有 GitHub 解压版的用户首次启用这项可选权限时需要手动更新。在仓库根目录安装本机连接器并注册 MCP。

```bash
npm ci
npm run mcp:setup
codex mcp add haineicunzhi -- "$(command -v node)" "$PWD/scripts/bilibili-mcp.mjs"
```

在平时用的 Chrome 打开海内存知弹窗，从「设置 → 关于 → AI 下载」点「连接此 Chrome」，按 Chrome 提示授权。连接只需设置一次，Chrome 重启后会恢复。多个 Chrome 资料中可以在一个资料里断开，再在想使用的资料中连接。连接设置里的「断开连接」会停止此资料提供 MCP 服务。

其他支持本地 MCP 的客户端同样用 `node` 启动 `scripts/bilibili-mcp.mjs`，参数使用脚本的绝对路径。使用 Chromium 或 Chrome for Testing 时，连接器安装命令可追加 `-- --browser=chromium` 或 `-- --browser=testing`。加载 ID 自定义的解压版本时可运行 `npm run mcp:setup -- --extension-id=实际ID`。

## 登录和恢复

已在连接的 Chrome 资料里登录 B 站时，可以直接查询或下载。MCP 只有在 B 站明确返回未登录时才返回 `LOGIN_REQUIRED` 和 B 站登录地址。在同一资料登录后，可用原来的 `jobId` 继续。接口返回异常时任务以 `ACCOUNT_CHECK_UNAVAILABLE` 暂停，适合稍后重试。Chrome 与本机连接器断开时返回 `CHROME_NOT_CONNECTED`，应先检查扩展的连接状态。

默认导出到 `~/Downloads/海内存知`。可在 MCP 客户端的环境配置里用 `HAINEICUNZHI_DOWNLOAD_DIR` 指定本机输出目录。批量任务的同一目录下按 `P3`、`P4` 等分集，文件沿用扩展的标题、分 P 和画质命名。继续旧任务时使用它原先的输出配置。

分 P 音频的文件名包含主标题和实际 P 序号，例如 `视频主标题 - P5 - 城外探索 [AAC 192K].m4a`。分 P 名只是 `05` 或 `P05` 时，文件名只写一次 `P5`。单 P 音频沿用原有命名。

## 工具契约

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `bilibili_account_status` | 无 | `signed_in` 表示已登录，`signed_out` 带 `loginUrl`，`unavailable` 表示暂时无法确认。 |
| `bilibili_video_info` | `url` | `parts` 列出每个 P 的标题、时长、CID 和链接。指定 P 的 `videoQualities` 和 `audio` 带 `bytes` 与 `estimated`，`null` 表示体积未知。`account` 表示匿名、浏览器保存了会话或接口报告有大会员权益。 |
| `bilibili_download` | `url`，可选 `mode`、`quality`、`subtitles`、`maxBytes` | 返回持久化 `jobId`。`mode` 默认 `video`，可选 `audio`。`quality` 是实际可用的视频画质 ID，例如 `120` 对应 4K。 |
| `bilibili_download_batch` | `url`、`pages`，可选 `mode`、`quality`、`subtitles`、`maxTotalBytes` | `pages` 是同一 BV／av 投稿内的 P 序号数组。返回一个批次 `jobId`，状态中的 `items` 逐集报告进度、文件和错误。 |
| `bilibili_download_status` | `jobId`，可选 `waitSeconds`（0 至 20） | 文件可用时返回 `files`，含绝对路径和实际字节数。`qualityLabel` 与 `codec` 来自实际缓存，`splitTracks` 表示视频和音频轨分开导出。 |
| `bilibili_download_list` | 可选 `limit` | 最近创建的本地任务，包括旧会话的任务。 |
| `bilibili_download_control` | `jobId`、`action` | `pause` 暂停，`resume` 继续暂停或中断项，`cancel` 取消未完成项，`retry_failed` 只重试失败项。暂停与取消会保留缓存断点和已导出的文件。 |
| `bilibili_subtitles` | `url`，可选 `language`、`format`、`offset`、`limit` | 按 P 获取 B 站原字幕。`cues` 按条分页，`nextOffset` 为下一页，`format` 可把完整字幕保存为 `json`、`srt` 或 `both`。默认只返回 JSON 数据。 |

- 任务从 `queued` 进入 `starting`、`downloading` 和 `exporting`。最终状态包括 `complete`、`partial`、`failed`、`paused`、`cancelled` 和 `interrupted`。活动任务收到命令时返回 `pendingAction`，之后可查询是否真正停下。`partial` 表示同一批次有成功和失败的分集。
- `jobId` 和结果保存在海内存知本机资料的 `MCP/downloads.json` 中。宿主退出后，排队和中断项仍可用同一个 ID 查到，调用 `resume` 可以续传。相同请求复用现存任务或经过文件大小核对的已完成产物。批次已完成的 P 不参加恢复或失败重试。
- `subtitles: true` 同时写入 JSON 和 SRT，也可指定 `{ "language": "ai-zh", "format": "srt" }`。字幕成功时保留语言、来源和起止秒数。缺少字幕、字幕锁定、语言不可用或接口错误各用独立状态表示，媒体仍可导出。`machineGenerated` 为 `true` 代表 B 站 AI 轨道，为 `null` 时来源类型未声明。
- `maxBytes` 和 `maxTotalBytes` 限制实际导出的媒体及字幕字节数。规划先给每个分 P 保留一个可用档位，再按 P 顺序提高画质。音轨提取可能需要下载整段 MP4，相应体积是源文件估算。落盘校验超预算的分集会失败，已缓存的数据可供重新规划。

## 实现与验证

扩展在用户授权后通过 Chrome Native Messaging 启动本机连接器。连接器只监听本机回环地址，每次启动生成独立凭据。扩展处理受限的 B 站查询、缓存与导出操作，登录会话由 Chrome 自己管理。关闭 MCP 会清理该会话使用的临时标签页和 Chrome 导出任务。 [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

工具通过 `GET_PAGE_INFO` 读取分 P，通过 `REFRESH_POPUP_DATA` 复用画质与体积快照。`START_CACHE` 会核对规划时的 CID，暂停和续传走扩展原有任务命令。Chrome 按当前下载目录生成临时文件，本机 MCP 核对后把媒体、字幕和产物清单一起发布到结果目录。

`npm run test:mcp:native` 在临时 Chrome 资料中验证本机连接、已有登录、明确登出、接口故障、恢复登录和导出。`npm run test:mcp` 用隔离的 Chromium 夹具验证音频、字幕和批量续传。为开发调试保留 `scripts/bilibili-mcp.mjs --isolated` 入口，使用独立浏览器与独立任务记录。

协议参考 [MCP TypeScript SDK 的 stdio 接入](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)。
