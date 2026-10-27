# 参考项目与来源使用边界

整理日期：2026-10-27（Asia/Tokyo）。下面产品比较来自 bilibili-discovery 的 2026-10-25 调研；协议接入另有 2026-10-27 实际响应验证。本页不声称已重新核查每个上游的最新版本、分发状态或功能。它们是来源与设计参考，不是本服务已安装的依赖。

| 来源 | 本项目参考什么 | 不据此承诺什么 |
| --- | --- | --- |
| [PiliPlus](https://github.com/bggRGjQaUbCoE/PiliPlus) | 账号、字幕、元信息、取流端点的已有客户端实现；[接口定义](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/main/lib/http/api.dart)、[用户请求](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/main/lib/http/user.dart)、[WBI](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/main/lib/utils/wbi_sign.dart) | 不引入完整 Flutter 客户端；其平台支持不能证明本服务 iPhone 播放可用 |
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | 用户提到的 AI 刷视频方案；参考字幕筛选、故事板和按需转写的分工 | 不默认复用其强度、推荐流或投递方式；不自动评论 @ 用户；抽帧不算全片审阅 |
| [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw) | 个人内容库、偏好与反馈/Agent 分层的思路 | 不引入整套宿主或 embedding 模型；不以跳回 B 站页面/App 代替纯净观看 |
| [BiliNote](https://github.com/JefferyHcool/BiliNote) | 字幕/转写→结构化笔记→原片时间戳的阅读分支 | 当前没有部署其模型、Whisper 或多模态服务，不假定树莓派转写性能 |
| [MiniBili](https://minibili.zhaohe.org/) / [NeoBili](https://github.com/Fab1e2000/NeoBili) | 精简移动观看入口和客户端交互的比较对象 | 不采用未由用户确认的 UI；分发与系统要求使用时另核查 |
| [RSSHub 关注视频](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/bilibili/followings-video.ts) | 未来关注更新增量采集的参考 | 目前未接入 RSSHub、更新调度或通知 |
| [Bilibili API 收集备份](https://github.com/BACNext/bilibili-API-collect-backup) | QR、字幕、播放协议字段的社区记录，和实际响应交叉验证 | 私有接口不是官方稳定授权契约，不把文档当实时可用保证 |
| [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) / [Safari 17.1](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/) | 未来 iPhone PWA 通知和媒体能力评估的官方依据 | 当前没有 PWA 安装、Push 订阅或真机播放验收；使用时重新核对支持条件 |

## 当前实现直接依赖的协议观察

- QR 返回的扫描地址可为 account.bilibili.com/h5/account-h5/auth/scan-web；兼容旧 passport 扫描路径，未放行任意域或重定向。
- 公共 MP4 实测节点包含 upos-hz-mirrorakam.akamaized.net，按明确主机放行，不开放整个 Akamai 域。
- 匿名 nav 可携带 WBI 信息；已存但失效的登录态不能悄悄冒充匿名账号权益。
- 以 ai- 开头的字幕语言标机器生成；其他轨道标记未知，不推断为人工字幕。

这些是当前适配器行为与测试的来源说明，不是对上游未来稳定性的承诺。站内字段变化时先补失败样本与测试，再更改适配器和 API 能力说明。

## 代码与许可证

当前 Python 内容服务从自己的 bilibili-discovery 实验拆出；运行时第三方依赖为空。上面链接不表示复制了项目代码、已逐项完成许可证审计，或可移除其署名。未来引入代码/资产/包时应另核对当时许可证，保留要求的声明，并更新仓库 THIRD_PARTY_NOTICES.md。历史实验中的私人关注快照与作者原稿不属于可自动迁入或公开发布的参考素材。
