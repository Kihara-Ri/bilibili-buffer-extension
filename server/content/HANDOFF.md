# 给 Claude Code 的前端交接

最后核对：2026-10-27；服务版本 0.1.0。先读 [PROJECT.md](PROJECT.md)，再读 [API.md](API.md)；字段样例见 [api-examples.json](api-examples.json)，部署路径见 [deploy/README.md](deploy/README.md)。本页只规定接入约束，不规定用户尚未确认的视觉方案。

## 当前可接的后端

生产 API：`https://bilibili.kihara.cn`。根路径目前为 JSON，服务器未部署前端静态页面；Nginx 当前将所有路径交给 Python，前端发布时需要给静态文件另设路由，保留 /v1/* 与 /health 代理及认证。无需改动 Chrome 扩展 UI 或权限。

网站认证是 Nginx Basic，凭据由用户私下提供，不嵌入构建产物或 URL。B 站扫码只登录服务端账号，不替代网站认证。前端推荐同源部署；所有请求 credentials:include。SSR、跨站前端或新域名必须另处理 Cookie/Origin 和认证，不能以 CORS=* 解围。

开发启动：`python3 server/content/run.py serve --port 8765 --allow-origin http://localhost:5173`。API 与前端均用 localhost；同进程若放行生产 HTTPS Origin，QR Cookie 带 Secure，HTTP 开发不要与该进程混用。

## 需要实现的交互链路

- 登录：GET login/status → POST login/qr → 把返回 url 编为二维码 → 按 poll_after_seconds 轮询；成功后刷新状态。二维码过期可重建；尝试 ID/扫码 URL 不记日志。手机浏览器中如何完成扫码确认仍需真机设计和验收。
- 资料：用户主动同步稍后再看后读 queue。失败保留已有结果并显示 last_sync；未实现的历史/收藏/关注不能显示为“已同步但为空”。
- 视频：resolve 得 selected_id/parts → POST playback → 相对媒体地址按 API base 解析。切 P 使用对应 id，保存前端自己的进度。410 时重建计划；403/429/422 不循环重试。
- 阅读：针对具体分 P 采集字幕，再 GET content。按 evidence.kind=transcript 且 coverage=excerpt 读分段；full 轨道是便利聚合，不能和 excerpt 重复拼接。无字幕/受限/失败分别展示，当前没有生成摘要接口。
- 注销：POST login/logout 会影响共享服务端账号和所有播放计划；不会撤销其他 B 站设备，也不会清空旧采集内容。前端应让用户理解这一操作。

当前没有任务状态推送、WebSocket、摘要、自动推荐、通知订阅或用户观看进度 API；不要猜接口或用客户端成功播放合成站内历史。

## 接入验收

1. 网站未认证不能访问 API/媒体；通过网站认证但未登录 B 站可解析/播放公开视频，账号资料提示未登录。
2. 同浏览器的 QR 尝试能轮询，换浏览器不能接管；真实扫码后重启服务仍能验证账号。
3. 正常/失效/缺元信息队列均可区分；分页失败不清空列表；多 P 的时长/CID/字幕不串。
4. iPhone Safari 真机起播、拖动 Range、切 P、令牌过期恢复、后台/锁屏行为逐项记录。未通过的能力不能写“已支持”。
5. 字幕原文、AI 后续摘要、用户读过和真实播放进度独立保存；任何摘要都可回溯 evidence id、时间点和 revision/fingerprint。

接口改动先同步 API.md、api-examples.json 和后端测试，再调整调用。前端需要的新接口先明确契约，不能只在 UI 中假设其存在。
