# 浏览器版本兼容与自检

> 适用版本：v2.13.0 · 最后核对：2026-10-24
> 对应实现：`browser-compat.json`、`scripts/check-browser-compat.mjs`、`scripts/test-chrome.mjs`、
> `scripts/lib/browser-compat.mjs`、`scripts/lib/browser-launch.mjs`、`src/health-check.js`。
> 这套机制源于 2026-09-23 的一次故障，经过见 [Chrome 154 故障记录](../history/2.8.8-chrome-154-incident.md)。

Chrome 自己会更新，扩展代码不变也可能出问题。这里有两道防线：开发侧的**版本门禁**，运行侧的**能力自检**。

## 1. 版本门禁

- `browser-compat.json` 记录**人工验收过的 Chrome 主版本**，每条包含具体构建号、日期与证据，以及需要跑的浏览器套件（`test:playback`、`test:network`、`test:popup`、`test:extension`）。
- `npm run check` 包含 `scripts/check-browser-compat.mjs`：本机 Chrome 或验收所用浏览器跑到未验收的主版本时**直接失败**，并打印下一步命令。探测不到浏览器（纯 CI）时明确跳过，不假装通过。
- `npm run test:chrome` 读取本机 Chrome 版本，从 Chrome for Testing 取**同构建或同主版本**的浏览器（缓存在 `.tmp/cft-cache/`），通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 换掉 Playwright 默认浏览器，依次跑全部套件。套件里的 `node …` 步骤由它直接执行、不经过 npm，避开 Windows `cmd.exe` 不支持 WSL UNC 工作目录的问题。
- **Windows 上读版本**：`chrome.exe --version` 在 Windows 不输出任何内容。门禁从安装目录读取——正式版的版本号子目录（如 `155.0.8059.85/`）、Chrome for Testing 的 `<版本>.manifest`；仍读不到时明确报「读不到版本号」，不伪造版本。
- **为什么不调高 `minimum_chrome_version`**：这个字段表达 API 下限（`runtime.getContexts` 需要 116），写成当前浏览器版本会挡住本来能用的旧版本用户。版本漂移是**上限**问题，用验收门禁解决更准确。

Chrome 更新后的标准动作：

```bash
npm run test:chrome     # 在与本机 Chrome 同版本的浏览器上重跑全部浏览器套件
# 通过后把主版本、构建号、日期与证据写入 browser-compat.json 的 verified 列表
npm run check           # 门禁复检
```

## 2. 运行期自检

`src/health-check.js` 探测扩展真正依赖的浏览器能力。结论存在 `chrome.storage.local["browserHealthV1"]`，6 小时内复用；`onInstalled` 的 `chrome_update` 或扩展更新时强制刷新。

| 检查项 | 失效后果 |
| --- | --- |
| `storage.local` | 配置与快照无法保存 |
| `storage.session` | 弹窗快照无法跨 Service Worker 休眠保存，打开弹窗需重新请求 |
| 本地缓存数据库（真实开库一次） | 离线缓存与源范围镜像不可用 |
| `declarativeNetRequest` 静态规则集 | CDN 请求缺 Referer，下载被拒 |
| `offscreen` + `runtime.getContexts` | 无法后台持续下载，或重复创建文档 |
| `downloads` | 无法保存到本地 |
| `cookies` | 无法判断 B 站登录态 |
| 浏览器版本 | 低于 `manifest.minimum_chrome_version` |

行为约定：

- **只读能力**：不发网络请求、不读 Cookie 原值；存储探测只写一个随即删除的自检键。
- **永不抛错**：任何单项失败只影响该项结论；单项 3 秒超时，不拖住弹窗。
- **界面**：设置里的「浏览器自检」始终显示结论（「全部正常（Chrome 版本）」或失败项列表），可以「重新检测」。失败或读不到结论时，主视图顶部额外出现提示条，齿轮带红点。结论签名不变就不重建列表，保持节点身份与焦点。
- **发现不了「扩展被停用」**：被停用的扩展不运行任何代码。所以设置里固定写明到 `chrome://extensions` 排查，README 也保留同样的说明。

## 3. 验证

```bash
npm run check          # 语法 + 版本门禁
npm test               # 含 tests/health-check.test.mjs
npm run test:chrome    # 与本机 Chrome 同版本的四个浏览器套件
```

`tests/run-popup-stability.mjs` 模拟能力缺失，断言自检提示出现、列出失败项、重复检测不重建节点、能力恢复后收起。
