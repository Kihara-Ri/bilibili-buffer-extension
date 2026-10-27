# 文档索引

从[技术文档](../技术文档.md)读起：它讲清系统边界、运行架构、消息契约、存储、权限、术语与已知边界，并指向下面的专题。

文档分三类，维护方式不同：

| 目录 | 内容 | 维护方式 |
| --- | --- | --- |
| `architecture/` | 现在怎么工作 | 只写当前行为；改代码就同步改正文，不在开头堆「x.y 起改为……」的补丁说明 |
| `development/` | 怎么开发、测试、发布 | 跟着脚本一起改 |
| `history/` | 当初为什么这样做、怎样验证 | 写完即冻结，只在开头注明被什么取代 |

每篇现状文档开头都标注「适用版本 · 最后核对」日期，看到旧日期就说明它可能需要复核。

## 现状

| 文档 | 一句话 |
| --- | --- |
| [完整缓存](architecture/offline-cache.md) | 识别视频、选画质 / 编码 / 音轨、分块下载、三层故障恢复、暂停继续、双轨合并、音轨提取、本地播放、保存 |
| [播放提前加载](architecture/playback-assist.md) | 前方窗口规划、分片引擎（槽位 / 对冲 / 退避）、页面分段缓存、SIDX 着色、估计器保护、统计契约 |
| [部分命中复用](architecture/partial-cache-reuse.md) | 请求只有一部分在缓存里时，只补缺口再拼成完整响应 |
| [播放位置感知回收](architecture/playback-retention.md) | 128 MiB 满了先回收哪些块 |
| [持久化源范围复用](architecture/persistent-range-reuse.md) | 离线下载过的原始字节怎样服务在线播放，身份与账户隔离 |
| [下载工作内存与背压](architecture/download-memory.md) | 在线、驻留、离线各环节的字节上限 |
| [兼容与回退](architecture/compat-fallback.md) | 能力缺失或运行期失败时的降级承诺与熔断 |
| [弹窗](architecture/popup.md) | 界面结构、状态文案、键盘与无障碍、实时刷新规则 |

## 开发

| 文档 | 一句话 |
| --- | --- |
| [热更新、构建与发布](development/build-and-release.md) | `npm run dev` 的重载链路、发布包剥离、扩展 ID 与 DNR、权限白名单、图标、隐私、官网 |
| [GitHub 更新维护](development/github-updates.md) | 两渠道构建、签名密钥、内部目录更新与恢复边界 |
| [测试与验收](development/testing.md) | 测试分层、浏览器套件前提、现有 Chrome 探针、测试原则 |
| [浏览器版本兼容与自检](development/browser-compat.md) | Chrome 版本门禁、同版验收、运行期能力自检 |
| [商店提审流程](../store/README.md) | 素材生成、首次提交、每版发布步骤、常见驳回 |
| [测试夹具来源](../tests/fixtures/README.md) | 真实 B 站 DASH 分片夹具的来源与用途 |

## 历史记录

按版本排列，内容冻结。

| 文档 | 一句话 |
| --- | --- |
| [早期开发记录（1.x – 2.6）](history/early-development.md) | 最初的需求、早期技术路线、十几个问题的根因与排查 |
| [2.6.1 播放缓存设计](history/2.6.1-playback-cache-design.md) | 为什么从「预热后丢弃正文」改成「页面缓存 + 接住播放器请求」，为什么着色改用 SIDX |
| [2.6.2 弹窗稳定性设计](history/2.6.2-popup-stability.md) | 实时刷新规则的来历：节点复用、确认落盘、徽标派生 |
| [2.8.0 真实 Chrome 并发验证](history/2.8.0-concurrency-validation.md) | 1–128 路并发矩阵实测与当时的架构选择 |
| [2.8.1 – 2.8.7 缓存改进验收账本](history/2.8.1-2.8.7-cache-ledger.md) | 七项缓存改进的验收记录，其中三项后来被移除 |
| [2.8.8 Chrome 154 故障记录](history/2.8.8-chrome-154-incident.md) | 「Chrome 升级后插件没反应」的真实原因与由此新增的门禁 |

每个版本具体改了什么，见[开发日志](../开发日志.md)。

## 验收研究

- [2026-10-27 缓存启动按钮修复](research/2026-10-27-cache-button-startup.md)：启动状态交接、超时重试与迟到响应隔离。

- [2026-10-27 CDN 续审](research/2026-10-27-cdn-review.md)：缓存身份、清单更新竞态、迟到复用和范围边界修复。

- [2.16.0 CDN 救援验收](research/2026-10-26-cdn-recovery-validation.md)：零速等待复现、修改前后十场景对照、真实 CDN 与播放验收边界。

## 其他

- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)：参考项目与许可声明
- [privacy.html](../privacy.html)：隐私说明（随扩展打包，也发布在官网）
- `.impeccable.md`：界面设计语境（用户、品牌气质、设计原则），供设计工具读取
