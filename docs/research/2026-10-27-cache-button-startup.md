# 点击缓存后按钮闪回粉色：修复与验收

日期：2026-10-27。受测工作树：`cdn-stall-recovery/bilibili-buffer-extension`。此文记录发布前的修复验收；最终发布状态以 GitHub Release 为准。未自动安装到日常 Chrome。

## 复现

使用真实 popup.html / popup.css / src/popup.js，在 Chrome 消息边界控制 START_CACHE 响应与数据库任务出现时间。首次复现的慢响应场景在点击后 569ms 退回 idle，任务于 1804ms 登记后才恢复 downloading；快速响应、延迟登记场景在 203ms 退回 idle，1682ms 才出现任务。退回 idle 时按钮还恢复了可点击。

原因：startCache 只临时更新 DOM，没有保存启动状态。700ms 片库轮询以及启动成功后的主动刷新，在任务未落盘时进入 renderCacheAction 的空任务分支，覆盖连接样式。后台仍在获取 playurl 或 offscreen 仍在初始化时，任务缺席是正常窗口。

原始 trace、录屏及截图保留于 `.tmp/cache-button-flash/`。本次新回归先在未修复代码上观察到 `慢响应: 启动中不得退回粉色` 的失败，随后实现修复。

## 修复

- 按标签页、页面 ID、缓存模式、请求画质与编码保存启动身份，渲染统一读取该状态。响应成功、空列表与未更新的暂停/出错任务均不清除 pending。
- 匹配的新任务通过推送或轮询接管；续传等待保持原有进度和字节。等待期间隐藏尚不可用的暂停/继续，处理函数也阻止重复启动事件。
- 错误与请求身份绑定，保留重试反馈；进度先到、响应失败后到，或上一轮超时后才失败，均不能覆盖真实进度或新一轮请求。
- 后台迟到的旧画质任务不再通过轮询改变用户的新画质。视频与仅音频启动互不干扰，初次打开仍按快照恢复活动画质。
- 30 秒未确认时查询片库，复用在途查询，查询自身最多等 5 秒。仍无任务则显示尚未确认启动并允许重试，不声称后台任务已取消；迟到任务可恢复真实进度。弹窗关闭清理定时器，pending 不跨弹窗保存。

## 验证

- `npm run check`：125 个 JS 文件与 Chromium 156 主版本兼容门禁通过。
- `npm test`：321/321 通过。
- `npm run test:popup`：通过。新增 9 组启动行为回归，同时通过既有节点/hover/焦点/pending、删除撤销、进度水波、画质滑杆/减少动态、后台/offscreen 与评价邀请检查。
- 新增行为覆盖：慢响应；响应后延迟登记；重复点击及节点/焦点；失败跨轮询保留与重试；切换画质时旧失败和旧进度隔离；视频/音频隔离；旧暂停记录与新初始化错误；进度先到而响应错误后到；启动无响应超时与同一选择重试；状态查询无响应有界退出；迟到任务恢复；仅轮询接管。
- `npm run build`：发布包校验通过，生产 popup.js 与当前源码一致。

以上验证运行真实 Chromium 与生产弹窗代码；外部 Chrome 消息和下载状态采用受控夹具。它证明按钮状态竞态修复，不代表重新完成真实 B 站 CDN 或下载速度验收。

整合主分支前的测试包：`dist/haineicunzhi-2.16.0.zip`，历史 SHA-256：`6ce9501cd10452d0f2f806556a8c3189b9107488305dffbd24d8d5499df74e93`。

修复后截图：`.tmp/cache-button-flash/fixed/connecting.png`、`downloading.png`；结构化结果：同目录 `result.json`。回归入口：`tests/run-popup-startup.mjs`，已纳入 `npm run test:popup`。

发布整合时保留主分支 c45fc0f 的长连接待删登记及真实工具栏弹窗关闭回归。最终版本以 Release 附件和 SHA256SUMS.txt 为准，不用历史测试包哈希校验正式附件。

## v2.16.0 发布整合验收

保留主分支关闭弹窗删除修复后重新验证：`npm run check`（128 个 JS 文件）、`npm test`（325/325）、完整 `test:popup`（含真实工具栏弹窗关闭）、`test:network`、`test:playback`、`test:updater` 及生产扩展注入/重载均通过。

商店构建与 GitHub 签名构建均完成；使用正式固定公钥验证更新 JSON，并将签名中的 57 个文件与 GitHub ZIP 及解压目录逐字节核对。更新套件本轮验证更新页、后台协调、渠道权限、发送方限制与跨页锁；未重新操作原生目录授权对话框。真实 CDN 故障与性能数据仍以此前 CDN 验收记录为准。

正式附件校验值（发布时随附 SHA256SUMS.txt）：

| 附件 | SHA-256 |
| --- | --- |
| haineicunzhi-2.16.0.zip（商店包） | ffc7eeb5697c543108eac7b0e39b8c626963bcb8e1751b71880c96a518558990 |
| haineicunzhi-github-2.16.0.zip | 00e22caefe65215db59825fa109afc80bb105700bf4f1d72c150e7d03224e692 |
| haineicunzhi-github-2.16.0.update.json | 739e1567fd963603ed628279eb2cfc0f87c4cafa1c64723891b4f0139b766270 |
