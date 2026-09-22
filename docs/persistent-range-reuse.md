# 持久化源范围复用（离线已下载字节 → 在线播放）

> 对应实现：`src/source-range-store.js`（镜像与校验）、`src/offscreen.js` 的 `createSourceMirror`、
> `src/playback-reuse.js`（页面侧）、`src/playback-bridge.js`、`src/background.js` 的 `SOURCE_RANGE` 分支、
> `src/playback-observer.js` 的 `loadPlayerRange`。
> 本文只描述这项能力；页面内存缓存本身见 [播放缓存设计](playback-cache-design.md)，
> 缺口拼接见 [部分缓存复用](partial-cache-reuse.md)。

## 1. 目标与边界

离线缓存已经把原始 CDN 字节写进 IndexedDB。播放同一个视频时，这些字节本可以直接服务播放器的 Range 请求，
但原实现的页面缓存只认「本次会话内存里的字节」+「本次会话已验证的 URL」，两者之间没有通道。

本次打通的方向是**单一方向**：

```text
offscreen 离线下载（逐字节校验过的源范围）
        │  SOURCE_RANGE{op:write}
        ▼
   Service Worker 镜像（IndexedDB，64 MiB / 256 行 / ≤1 小时）
        │  SOURCE_RANGE{op:read}
        ▼
隔离桥 → 页面 playback-reuse → 观察器 loadPlayerRange → 播放器 206
```

**明确不做**（并已在测试中固定）：

- 不从页面往离线片库回写字节：离线分块要求从 0 连续推进，页面请求范围是任意的，
  混入会产生第二写者与半成品风险。
- 不把合并 MP4、抽取的音轨或任何 `createChunkWriter` 产物当作源范围。镜像只挂在
  `range-downloader` 的 `onVerifiedRange` 上，而该回调只出现在两个「源范围下载」调用点。
- 不做带宽整形，也不改变并发与预算：复用命中根本不发起网络请求。

## 2. 内容身份：路径 + 总长，而不是签名

| 维度 | 参与匹配 | 说明 |
| --- | --- | --- |
| `pathname` | 是 | B 站媒体路径含 cid 与流编号，是文件身份 |
| `total` | 是 | 必须与站点观测到的总长完全相等 |
| 主机 | 否 | 与既有 `playback-routes.js`「主备 CDN 同文件」的假设一致 |
| 查询串 / 签名 | 否 | 但写入与读取都必须命中**未过期的签名 URL** |
| 账户 | 是 | 分区键来自 SESSDATA 的不可逆摘要 |
| 清晰度 / 编码 | 否 | 已由 pathname 区分，不做额外归一化 |

`deadline`/`expires` 已过期、非媒体主机、带账号信息或 hash、`end > total`、
单范围超过 2 MiB 的请求一律拒绝。签名有效期也是镜像行的存活上限（最多 1 小时）。

## 3. 账户隔离

- 分区键 = `SHA-256(SESSDATA 值)` 的前 32 位十六进制；**原始 cookie 值不落盘、不进消息、不进日志**。
- 写入与读取各自重新计算分区；读取完成后再校验一次，若期间账户已切换或签名失效，已读出的字节也不会交付。
- 无 SESSDATA（未登录）使用 `anonymous` 分区，仍然可用，但只服务匿名会话写入的字节。

## 4. 有界性

| 边界 | 值 | 位置 |
| --- | --- | --- |
| 镜像总字节 | 64 MiB | `SOURCE_LIMIT`，按最旧优先回收 |
| 行数 | 256 | `SOURCE_ROWS` |
| 单行范围 | 2 MiB | `SOURCE_RANGE_LIMIT` |
| 单次读取 | 4 MiB | `SOURCE_READ_LIMIT`，超限直接未命中 |
| 每下载任务镜像配额 | 96 MiB | `createSourceMirror` 的 `budget` |
| 页面在途读取 | 1 | `playback-reuse.js` 的 `inFlight` |
| 会话授权地址表 | 256 条 | `MAX_URLS`，超出淘汰最早 |
| 消息大小 | ≤ 2 MiB 原文（base64 约 2.7 MB） | 桥与后台各自校验 |

镜像写入串行、失败静默：连续 3 次失败即在本下载任务内熔断，绝不影响下载主流程。

## 5. 读取语义

**只有连续覆盖才交付。** 读取按 `start` 排序后逐行推进游标，遇到孔洞立即整体判未命中——
不存在「先返回已有部分、稍后补洞」。所有字节长度必须精确等于请求长度。

页面侧还有两道自己的闸门：

1. 地址必须出现在**本次会话 playurl** 的媒体字段里（`baseUrl`/`backupUrl`/`base_url`/`backup_url`，含数组形式）；
2. 请求必须闭区间、已知总长、≤ 4 MiB，且同一时刻只有一个在途读取。

任何一步不满足都返回「未命中」，随后完全走原有网络路径（含原生回退）。
配套的失败保护：桥超时 1.5 秒、回包晚于 1.4 秒丢弃、连续 3 次超时后暂停 60 秒，
避免每个播放请求都白等一次。

## 6. 已知限制

- 首次请求通常拿不到该 URL 的总长（要等站点自己的 `Content-Range` 或 playurl 的 `size` 字段），
  因此**同一个 URL 的第一次请求一般不会命中**，命中从第二次开始。
- 复用命中不计入 CDN 吞吐样本、节点健康度与黄色进度条（另有 `reuseHits` / `reuseMB` 统计）。
- 删除某个离线视频不会立即清理它的镜像行；镜像行由签名有效期与 LRU 上限共同约束（≤1 小时、≤64 MiB）。
- 镜像会给离线缓存额外写入最多 64 MiB 的重复字节，这是刻意的磁盘换播放延迟权衡。
- 只覆盖 IndexedDB 可用的环境；镜像不可用时功能整体降级，不报错、不阻塞。

## 7. 验收证据

| 覆盖 | 位置 |
| --- | --- |
| 跨主机按路径复用、孔洞/总长拒绝、签名与主机校验、写入身份、账户隔离、读取上限与行数淘汰、合成字节隔离 | `tests/source-range-store.test.mjs` |
| 页面→桥→镜像整链读取、未授权地址不发请求、长度不一致不交付、超时与熔断、发送者身份 | `tests/playback-reuse.test.mjs` |
| 观察器命中短路网络并单独计数、未命中/模块缺失走原网络路径 | `tests/playback-reuse.test.mjs` |
| 真实浏览器 IndexedDB：写入、跨主机命中、孔洞、总长不符、账户隔离、页面无权写入、清理 | `node tests/run-existing-reuse-probe.mjs <pid> <tab>` |

```bash
npm run check
npm test
npm run build
node tests/run-existing-reuse-probe.mjs <pid> <tab>   # 可选：用户现有 Chrome
```

浏览器探针是**受控正确性验证**，不是测速，也不能代替真实播放回归。
