# 「解决部分 B 站视频播放卡顿」与海内存知实现对比

核查日期：2026-10-26（Asia/Tokyo）。本文是研究记录，不代表已实现改动。

## 比较范围与证据

- 对方商店 ID：`meljboglnmhdohojhimibmfcfahnnffj`。[商店页面](https://chromewebstore.google.com/detail/meljboglnmhdohojhimibmfcfahnnffj)。本次未直接取得商店正文，也未下载、校验商店 CRX；不声称商店安装包和公开源码逐字节一致。
- 作者公开仓库：[l3ss-kk/bilibili-cdn-rewrite-extension](https://github.com/l3ss-kk/bilibili-cdn-rewrite-extension)。检查的提交为 `01150d8e54101aacf349d160f9376e3d1773f4cc`，源码 manifest 标为 `0.6.0`。作者仓库的商店文案与用户提供的名称和用途一致。
- 海内存知：本地 `2.15.0`，检查起点 HEAD `9123e48`；直接读取当前源码，不以旧文档或旧版功能代替现状。
- 未进行双方在同一日本出口、同一视频、同一画质下的真实 CDN 对照测速。因此下文关于实际收益的判断均为条件推断，不给出性能胜负或提升百分比。

## 1. 对方怎样工作

核心文件是 [src/cdn-rules.js](https://github.com/l3ss-kk/bilibili-cdn-rewrite-extension/blob/01150d8e54101aacf349d160f9376e3d1773f4cc/src/cdn-rules.js#L1-L65)。它生成两条 Chrome declarativeNetRequest 动态规则：

1. 来源域名为 `upos-sz-mirrorcosov.bilivideo.com` 或 `upos-hz-mirrorakam.akamaized.net`；
2. URL 匹配 `.m4s`，资源类型为 `xmlhttprequest`、`media`、`other`；这里是 URL 过滤子串，不是严格的文件扩展名解析；
3. 动作为 `redirect.transform.host`，只指定新的域名，未设置改写路径或查询串。

可选目标：

| 选项 | 目标域名 |
| --- | --- |
| mirrorhw（默认） | upos-sz-mirrorhw.bilivideo.com |
| mirrorali | upos-sz-mirrorali.bilivideo.com |
| mirroralib | upos-sz-mirroralib.bilivideo.com |
| mirrorhwb | upos-sz-mirrorhwb.bilivideo.com |

可以理解为保留媒体路径与原查询参数，把一次请求的服务器地址换掉。媒体仍由浏览器直接向目标 CDN 获取，没有作者代理服务器。DNR 规则由浏览器执行，动态规则能够跨浏览器会话保留，不要求每个媒体请求唤醒后台 JavaScript。[Chrome DNR 文档](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)

[background.js](https://github.com/l3ss-kk/bilibili-cdn-rewrite-extension/blob/01150d8e54101aacf349d160f9376e3d1773f4cc/src/background.js#L9-L39) 把选择写入 `chrome.storage.local.targetCdn`，在安装、浏览器启动与用户切换时应用规则。[popup.js](https://github.com/l3ss-kk/bilibili-cdn-rewrite-extension/blob/01150d8e54101aacf349d160f9376e3d1773f4cc/src/popup.js#L31-L50) 在切换后刷新当前 `www.bilibili.com` 标签页。

检查的完整源码未实现：媒体正文缓存、并行 Range 调度、前方预取、测速、自动选择、健康退避、扩展自身的失败回原域名机制、playurl 响应解析、UA/Referer 改写或 P2P/mcdn 专项过滤。它没有 content_scripts；规则按请求域名匹配，并非按 BV 页面路径注入。

需要注意：规则是扩展范围的全局规则，选择不是按视频或标签页隔离；页面只自动刷新当前标签。UI 没有“保持原线路/关闭改写”选项。目标不可用时，扩展自身不会自动撤销重定向；播放器自己的重试行为另计。

## 2. 海内存知目前怎样工作

### 在线播放

[playback-network.js](../../src/playback-network.js) 把媒体 Range 分片下载并重组：后台片大小 512 KiB，急需范围约拆成 16 片，页面总槽位 32、后台最多 12。节点变慢时发起竞争副本，先完成者胜出，失败节点退避。

关键区别在同文件的 `register()`（352–359 行）：候选仅来自当前 playurl 的 `baseUrl` 与 `backupUrl` 等字段。它会在清单主备之间调度，不生成对方这四条镜像域名。无法捕获清单时，只能用观察到的原地址。不能将这称为“已经具备对方全部换线路能力”。

[playback-observer.js](../../src/playback-observer.js) 规划当前位置前方约 90 秒、最多 96 MiB 的窗口；[playback-cache.js](../../src/playback-cache.js) 驻留正文最多 128 MiB。播放器再次请求时复用已取回或在途的字节。SIDX 用于真实时间段映射与音视频交集着色；估计器保护针对 B 站内部 localStorage 结构。

### 完整离线缓存

[offscreen.js](../../src/offscreen.js) 结合 [range-downloader.js](../../src/range-downloader.js) 对主备节点探测、并行下载、校验并分块写入 IndexedDB；支持续传、签名地址刷新、双轨合并、本地播放和导出。此链路与对方的纯请求换域名功能不同。

## 3. 差异和各自优势

| 维度 | 对方公开实现 0.6.0 | 海内存知本地 2.15.0 |
| --- | --- | --- |
| 主要手段 | 指定来源请求换到固定镜像 | 并行分片、主备调度、提前加载、本机复用 |
| 清单之外的线路 | 能尝试四个固定目标 | 当前不合成额外目标 |
| 决策 | 用户手动选一条，全局生效 | 在当前清单主备内自动竞争与退避 |
| 正文处理 | 扩展不读取、复制或存储媒体正文 | 页面内存缓存与离线 IndexedDB |
| 页面适配 | 无页面脚本，主要依赖域名和 URL 匹配 | 注入 /video/*、/list/*，依赖请求适配及部分内部结构 |
| 自身失败恢复 | 无自动撤销重定向 | 备用地址、退避、原生请求回退；离线另有恢复 |
| 权限 | activeTab、DNRWithHostAccess、storage | 另需 cookies、downloads、offscreen、alarms、unlimitedStorage 等 |
| 可观测性 | 显示用户选定线路 | 速度、命中、前方就绪、救援、回退、节点等 |
| 额外成本 | 自身不发预热/竞争下载，媒体处理简单 | 预取未观看内容、竞争副本会增加流量与短期内存 |
| 离线 | 无 | 有 |

权限证据：[对方 manifest](https://github.com/l3ss-kk/bilibili-cdn-rewrite-extension/blob/01150d8e54101aacf349d160f9376e3d1773f4cc/manifest.json)、[本地 manifest](../../manifest.json)。本地根 manifest 含开发用 127.0.0.1 权限，发布构建会剥离，比较时不把它计作线上产品需要的权限。权限少是对方单一用途带来的优点，不表示海内存知可以直接删除离线功能所需权限。

## 4. 它值得借鉴的地方

### 4.1 当清单主备都不佳时，扩大候选可能比增加并发有效

条件推断：如果当前默认海外节点及其清单备用线路都很慢，而某个 mirror 节点可用且更快，对方可以跨出原候选集合；海内存知在原集合里增加并发和预取，未必能解决这个瓶颈。如果跨网到 mirror 的路径反而更差，改写则可能降速或失败。

这里的收益来自“换了能用的路径”。不能从域名、作者体验或功能数量推导出日本所有网络上的表现；换主机后原路径、签名、Range、CORS 与内容一致性也需实际检查。

### 4.2 对纯换线路需求，它的实现成本更低

纯 DNR 无需接管页面 fetch/XHR、仿真响应事件、保存正文或适配播放器存储结构。这降低了该项能力的运行开销与故障面。即使没有海内存知的复杂缓存能力，它仍可能解决某些线路本身引起的卡顿。

但它把支持范围限定在两个来源域名和含 `.m4s` 的 URL。其他来源、普通 MP4、HLS 不自动获得同等处理；域名调整后也可能直接不匹配。规则不限定 BV 页面，因此其他页面的匹配请求可能受益，但本次未验证番剧或真正的直播。作者所说“直播回放”不等于实时直播支持。

### 4.3 手动控制可作为诊断逃生口

四个选项让用户能主动尝试不同路径；当前海内存知没有对应入口。不过对方未提供成功状态检测，显示“已切换”只能证明规则更新完成，不能证明媒体请求命中、更快或已经不卡。若借鉴，应显示实际使用节点和可用性，而非只显示设置值。

## 5. 对海内存知的建议

优先做一个可撤销的实验，比较“原清单”与“额外镜像候选”，不要直接恢复全局强制改写或继续堆高并发。仓库 [第三方声明](../../THIRD_PARTY_NOTICES.md) 与 [开发日志](../../开发日志.md) 证明早期存在大陆候选思路，2.9.0 已移除；这是已走过的路线，需要用当前网络证据重新判断价值。

建议顺序：

1. 对同一视频、同一画质/编码、相同 Range，交错测试原地址、清单备用与镜像候选。区分首次请求和重复请求，避免 CDN 热缓存污染结论。记录 HTTP 状态、Content-Range、总长与实际字节一致性，再比较首字节和有效吞吐。
2. 在可用性成立后，比较首次出画、播放卡顿时长、seek 恢复、请求失败率、实际接收总字节与内存；不要只看峰值 MB/s。
3. 若有稳定收益，在现有调度器中加入“经验证的额外候选”：默认原清单，必要时或用户主动选择时探索；失败隔离、自动回退，并维持现有字节校验和取消语义。这样仍能按当前真实目标计算健康度。
4. 若需要轻量入口，可提供“仅换线路”模式；它应有明确的恢复原线路选项、作用范围说明和实际生效证据。先验证需求与线路，再决定是否增加 UI。

不建议把全局 DNR 改写直接叠加在现有引擎下面：页面记录的请求 URL 可能是原主机，Chrome 实际下载却去了另一个主机，节点健康度、统计解释和候选竞争会变得不准确；全局规则还可能影响离线下载和其他标签页。两个插件同时启用也可能发生这种干扰，不能当作各自独立效果的对照实验。

## 6. 本次验证与未覆盖项

- 海内存知：运行 `node --test tests/playback-network.test.mjs tests/playback-observer.test.mjs tests/range-downloader.test.mjs`，55/55 通过。覆盖分片、备用竞争、退避、窗口、取消、校验和提交等逻辑；这不是实时 CDN 性能证明。
- 对方：静态读取完整公开实现；运行 `node .tmp/competitor-research/source/tests/rules.test.mjs`，退出码 0。该测试检查规则构造，不代表 Chrome 实际规则命中或 CDN 可用。
- 未安装或执行对方扩展；未校验商店 CRX 与 GitHub 源码一致性；未作真实线路、番剧、直播、跨扩展兼容性验收。
- 本次只新增比较文档，未修改扩展生产代码、配置或版本。
