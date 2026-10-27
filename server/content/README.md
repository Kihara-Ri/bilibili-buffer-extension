# Bilibili 内容引擎 0.1.0

这是 bilibili-buffer 的独立后端模块，使用 Python 3.11+ 标准库，无运行时第三方依赖。前端调用契约见 [API.md](API.md)。

## 文档入口

| 文档 | 说明 |
| --- | --- |
| [PROJECT.md](PROJECT.md) | 目标、用户约束、功能状态和后续完成条件 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 技术路线、模块/数据边界和取舍 |
| [REFERENCES.md](REFERENCES.md) | 参考项目、来源时间与使用边界 |
| [API.md](API.md) | 全部 HTTP/CLI 契约、字段、错误与限制 |
| [api-examples.json](api-examples.json) | 从虚构测试数据生成的响应示例 |
| [HANDOFF.md](HANDOFF.md) | Claude Code 前端接入与验收 |
| [deploy/README.md](deploy/README.md) | 生产地址、认证、目录、续期和回滚 |

## 运行


在仓库根目录启动：

```sh
python3 server/content/run.py serve --port 8765
# 前端开发服务器使用同一主机名，例如均使用 localhost
python3 server/content/run.py serve --port 8765 --allow-origin http://localhost:5173
npm run test:content
```

默认仅监听 127.0.0.1；数据库和登录态位于本目录被忽略的 `data/`。数据与 Cookie 不进入扩展存储、仓库或发布 ZIP。扩展现有版本、权限、缓存与下载流程均保持原样；本服务单独运行。

职责：账号 QR 登录与本机注销、稍后再看完整分页同步、URL/BV 解析与分 P、字幕及时间戳证据、短期 MP4 播放代理。没有 UI、播放器控件、模型调用、摘要生成、排序或自动推送。暂未实现历史、收藏夹、关注列表与 UP 更新订阅。

验证真实公共视频链路（不确认 QR 登录、不回传观看进度）：

```sh
python3 server/content/smoke.py --base http://127.0.0.1:8765 --url BV1TUno6bEwA --qr
```

`bilibili_content/store.py` 管内容版本；`library.py` 管同步、分 P 和字幕；`bilibili.py` 封装上游；`qrlogin.py` 管登录；`playback.py` 管短期源地址及流代理；`server.py` 对外提供 JSON/媒体 API。测试使用虚构账号和可控上游，不需要私人 Cookie。

B 站私有接口可能变化；风控或网络失败会返回明确错误，不伪装成空列表。当前播放仅接收单段 MP4；没有字幕不等于视频没有信息，也不会凭标题生成内容。

生产部署：[`https://bilibili.kihara.cn`](https://bilibili.kihara.cn)，服务器 rasp5remote。启动、认证与回滚见 [deploy/README.md](deploy/README.md)。
