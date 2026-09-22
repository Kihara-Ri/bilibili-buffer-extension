# 兼容与回退

> 适用版本：v2.8.7。本文汇总「能力缺失」与「运行期失败」两类情况下插件的行为承诺，
> 以及对应的自动化证据。对应实现分散在 `src/playback-reuse.js`、`src/source-range-store.js`、
> `src/source-mirror.js`、`src/playback-cache.js`、`src/playback-observer.js`、`src/playback-bridge.js`。

## 1. 原则

1. **任何增强能力都不得成为播放的前置条件。** 缺失、超时、异常、未授权一律退化为
   「这次不走优化」，由原有网络路径（含浏览器原生回退）接管。
2. **不抛错给页面。** 观察器与缓存适配器在注入期就必须能加载成功；运行期错误只记统计。
3. **不改变默认行为与权限。** 新增模块不引入新权限，也不调整既有默认配置。
4. **失败要有上限。** 每个新增通道都有超时、单在途与熔断，避免「每次都白等一次」。

## 2. 能力矩阵

| 缺失的能力 | 影响的能力 | 行为 | 证据 |
| --- | --- | --- | --- |
| `indexedDB` / `open` 不可用 | 持久源范围复用 | 镜像仓库返回恒空实现，读写都判未命中，`clear()` 仍安全 | `tests/playback-compat.test.mjs` |
| 镜像仓库抛错（隐私模式、配额异常） | 持久源范围复用 | 写入/读取都返回未命中，不向上抛 | 同上 |
| `atob` / `btoa` / `window.postMessage` 缺失 | 页面侧复用读取 | 读取器直接返回未命中，不注册消息监听 | 同上 |
| `crypto.randomUUID` 缺失 | 页面侧复用读取 | 回退到时间戳 + 计数器 ID，仍完成读取 | 同上 |
| `MutationObserver` 缺失 | 视频元素补扫 | 观察器照常加载，1 秒定时器继续扫描 | 同上 |
| Playwright/桥不可用、`chrome.runtime.sendMessage` 失败 | 复用读取 | 桥回未命中；页面等满超时后走网络 | 同上 |
| `BiliPlaybackReuse` 模块整体缺失 | 持久源范围复用 | 观察器不尝试复用，直接走网络 | `tests/playback-reuse.test.mjs` |
| 请求预算服务不可用 | 在线加速 | 交原生回退（离线走错误重试），不自发本地预算 | `tests/request-budget*.test.mjs` |
| `window.fetch` / `XMLHttpRequest` 缺失 | 缓存适配器 | 适配器不安装，全部走原生 | `tests/playback-cache*.test.mjs` |

## 3. 失败上限与熔断

| 通道 | 超时 | 熔断 | 恢复 |
| --- | --- | --- | --- |
| 页面 → 桥 → 镜像读取 | 1.5 秒 | 连续 3 次失败暂停 60 秒 | 任意一次成功清零计数 |
| 桥 → 后台回包 | 1.4 秒（迟到即丢） | — | — |
| 离线镜像写入 | 串行队列 | 同一下载任务连续 3 次失败即停写 | 新任务重新开始 |
| 请求预算 RPC | 2 秒 / 15 秒总等待 | 失败即回退原生或重试 | 下一次请求重试 |
| 缓存→网络回退 | 沿用节点超时与截止时间 | 403 短封、其他指数退避 | 健康度按成功请求恢复 |

**取消语义**：观察器的 `loadPlayerRange` 先校验 `signal.aborted`、`cfg.mode` 与页面世代，
再尝试复用；取消或导航后不写入页面缓存、不交付旧字节、不回退原请求。

## 4. 重复安装与幂等

- `playbackCache.install()` 只生效第一次，重复调用不会替换 `loadRange`。
- 镜像写入以 `(source, partition, start)` 为行 ID，重复写入同一范围是覆盖而非新增。
- 桥对非法 `rpcId`、缺字段或类型错误的请求静默丢弃，不转发、不回包、不带额外字段。

## 5. 默认配置与权限

- `ASSIST_DEFAULTS`：`mode=always`、`maxConcurrency=32`、`cdnMode=original`、`networkPolicyVersion=3`，
  与 2.8.0 以来一致；`sanitizeAssistConfig({})` 仍解析出同样的默认值。
- `manifest.permissions` / `host_permissions` 未新增条目；热重载入口仍不在生产注入列表。
- 新模块顺序固定为 `playback-cache → routes → network → request-budget-client → playback-reuse → observer`，
  保证观察器读取 `BiliPlaybackReuse` 时它已就绪。

## 6. 验证

```bash
npm test
npm run check
npm run build
node tests/run-existing-reuse-probe.mjs <pid> <tab>   # 可选：用户现有 Chrome
```

`tests/playback-compat.test.mjs` 覆盖上表的能力缺失、重复安装与写入、桥失败与迟到回包、
取消顺序、默认配置与权限；`tests/playback-reuse.test.mjs` 覆盖超时熔断与模块缺失回退。
这些是 Node VM 级与真实浏览器受控验证，不代表真实 B 站线路的端到端播放回归。
