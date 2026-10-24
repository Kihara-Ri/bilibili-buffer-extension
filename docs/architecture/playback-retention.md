# 播放位置感知的内存回收

> 适用版本：v2.13.0 · 最后核对：2026-10-24
> 对应实现：`src/playback-cache.js` 的 `retain` / `release` 与回收逻辑，`src/playback-observer.js` 的 `updateRetentionHints`。
> 本文只讲「128 MiB 满了先丢哪些」；命中、请求适配和预热调度见[播放提前加载](playback-assist.md)。

## 1. 为什么不用简单 FIFO

只按插入顺序回收有三个问题：

1. **保护不了正在播放的数据**：刚预热的初始化区或当前窗口可能因为插入不算最早，被后来的大块挤掉；离播放位置很远的旧段反而留着。
2. **分不清活动轨道**：切清晰度后，旧 CDN 地址的整条数据仍和当前轨同级竞争。
3. **感知不到拖动**：拖动后前方窗口整体平移，FIFO 不知道新窗口在哪。

所以引入**保留提示（retention hint）**：观察器把「正在看哪条轨、哪个时间点、前后窗口多大」告诉缓存，缓存据此给块分级。提示只改变**回收顺序**，不放松 128 MiB 硬上限。

## 2. 分级与回收顺序

回收时每个驻留块归入一个层级，数字越小越先回收：

| 层级 | 含义 |
| --- | --- |
| 0 | 非活动资源：没有提示，或提示为 `active: false`，优先整条清理 |
| 1 | 活动轨道，但既不在初始化 / 索引区，也不在窗口内 |
| 2 | 活动轨道的初始化 / 索引区，以及 `[position − rewind, position + ahead]` 覆盖的字节 |

同一层级内，先回收离最近保护区**字节距离更远**的块；距离相同按插入顺序。排序键 `(tier, −distance, order)` 全部来自缓存内部状态，结果确定可复现，不依赖时间戳、随机数或 Map 遍历顺序。

**保护不阻止回收**：整个池子都在保护区而总量仍超上限时，层级 2 之间继续按「先远后近、再按插入顺序」回收，直到 `stats.bytes <= limit`。

资源条目数上限（32 个）用同样的偏好：先丢非活动条目，全部活动时丢最早插入的。条目被整体丢弃时同步删除它的提示。

## 3. 时间如何换算成字节

### 3.1 有 SIDX：用真实分段

把窗口 `[position − rewind, position + ahead]` 与各段的 `[timeStart, timeEnd)` 求交，命中的段转成字节区间；初始化 / 索引区固定为 `[0, 首段起点)`。窗口跨越段边界时取并集，不会只保护半段。

### 3.2 无 SIDX：按比例回退

```text
perSecond    = total / duration
保护字节窗口 = [floor((position − rewind) × perSecond), min(total, ceil((position + ahead) × perSecond))]
初始化区     = [0, min(total, 1 MiB))       （1 MiB 是索引探测上限）
```

这个比例估算**只用于回收顺序**，不用于着色或宣称命中。时长未知时不做字节回退，只保护头部。

## 4. 观察器怎样刷新提示

`updateRetentionHints()` 读取正在播放（或第一个）`<video>` 的 `currentTime` 与 `duration`，然后对每条轨道：

- `active === false` → `release(url)`；
- 否则 → `retain(url, { active: true, position, ahead: 90, rewind: 5, duration, protectInit: true })`。

前方窗口与规划器共用 `LEAD_SECONDS = 90`；回看窗口 `RETENTION_REWIND_SECONDS = 5`，覆盖拖动后的小幅回退，又不保护过多历史。

刷新时机：

- 每次重绘进度条之前（按帧，隐藏标签页不画）；
- 500 ms 规划定时器里——标签页隐藏、帧回调暂停时也能持续跟上播放位置。

生命周期：

- 切换视频 / 分 P、关闭开关 → `playbackCache.clear()`，同时清空资源与提示；关闭后继续运行的重绘不会重建保护；
- 切换清晰度 / CDN → 旧轨道失活，提示被 `release`；
- 轨道 5 分钟没有活动且没有在途分片 → 先 `release` 再删除轨道（30 秒巡检一次）。

## 5. 接口

`window.__biliBufferCache` 上的保留相关方法：

| 方法 | 用途 |
| --- | --- |
| `retain(url, hint)` | 刷新某 URL 的提示，`hint = { active, position, ahead, rewind, duration, protectInit }` |
| `release(url)` | 删除单条提示 |
| `clearRetention()` | 清空全部提示 |

提示按 URL 隔离，最多 64 条，超出时淘汰最早写入的；`clear()` 同时清空提示。

## 6. 验证

| 文件 | 覆盖 |
| --- | --- |
| `tests/playback-retention.test.mjs` | 初始化 + 窗口保留、远离 / 非活动先回收、保护区满时仍守住上限、无 SIDX 比例回退、插入顺序确定性、`release` 与清理后不残留 |
| `tests/playback-retention-observer.test.mjs` | 观察器传入当前位置与时长、拖动跟随、切清晰度释放旧轨、切分 P 清空、500 ms 定时器独立刷新、关闭后不重建保护、真实缓存按提示回收 |

这些是 Node 单元与内存集成测试，不代表真实 B 站线路上的内存或性能。

## 7. 不做的事

- 提示不改变命中语义、请求回退、预热调度或网络策略；
- 不做帧级（关键帧、音视频配对）保护。
