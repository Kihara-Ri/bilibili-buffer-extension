# 浏览器版本兼容与自检

> 适用版本：v2.8.8。本文说明扩展如何应对 Chrome 自身的更新，以及 2026-09-23
> 「Chrome 升到 154 后插件不可用」这次故障的结论。相关实现见
> `browser-compat.json`、`scripts/check-browser-compat.mjs`、`scripts/test-chrome.mjs`、
> `src/health-check.js`。

## 1. 这次故障的结论

**现象**：Chrome 升到 154 后，插件完全不可用（弹窗打不开、网页侧没有加速、图标点不动）。

**排查结论**（三条都是可复核的事实，不是推测）：

1. **扩展代码与 Chrome 154 兼容。** 用与本机 Chrome 同构建的 Chrome for Testing 154.0.8037.57
   实际加载扩展验证：MAIN/ISOLATED 注入、播放加速、页面缓存命中、Offscreen 离线下载、
   IndexedDB 落盘、下载预算租约、DNR 规则集全部正常；仓库四个浏览器套件在 154 上全绿。
2. **真正原因是扩展在 Chrome 里被停用了。** 用户配置里
   `extensions.settings.ppoagkhgdcfchiodhgadpenibndbnhcj` 的 `disable_reasons = [1]`
   （`DISABLE_USER_ACTION`），安装形态是解包安装
   （`Profile 1/UnpackedExtensions/bili-buffer-extension-2.8.7_FQlf2e`，`location = 4`）。
   扩展一旦被停用，内容脚本、DNR 规则、Service Worker 全部不运行，表现就是「插件没反应」。
   解包扩展是 Chrome 可以停用的安装形态；同为解包安装的 `b站延拓` 未出现在受影响的记录里。
   **本次没有证据能区分这次停用是 Chrome 的提示流程造成、还是手动点击造成**，
   但恢复方式相同：`chrome://extensions` 打开开发者模式并重新启用。
3. **为什么没人提前发现。** 仓库的浏览器验收跑在 Playwright 自带的 Chrome for Testing 153 上，
   比用户的 154 低一档；而覆盖弹窗与离线下载的 `npm run test:popup` 自 2026-09-22
   引入共享下载预算后就一直是失败的（见第 3 节）。两件事叠加，等于「验收全绿」与
   「插件不可用」可以同时成立。

## 2. 版本兼容门禁

- `browser-compat.json` 记录**已被人工验收过的 Chrome 主版本**，每条包含验收时的具体构建号、
  日期与证据。这是「跑过了」的可复核记录，而不是一句声明。
- `npm run check` 会同时跑语法检查和 `scripts/check-browser-compat.mjs`：本机 Chrome、
  或验收实际使用的浏览器跑到未验收的主版本时**直接失败**，并打印下一步命令。
  探测不到浏览器（纯 CI）时明确跳过，不假装通过。
- `npm run test:chrome`：读取本机 Chrome 版本，从 Chrome for Testing 取**同构建/同主版本**的
  浏览器（缓存在 `.tmp/cft-cache/`），再依次跑 `browser-compat.json` 里列出的全部浏览器套件，
  通过 Playwright 的 `executablePath` 覆盖（见 `scripts/lib/browser-launch.mjs`）。
  这套流程就是本次故障后人工执行的排查动作，现在是一条命令。
- **为什么不是把 `minimum_chrome_version` 调高**：该字段表达的是「API 下限」
  （`runtime.getContexts` 需要 116），把它写成当前浏览器版本会挡住本来可用的旧版本用户。
  版本漂移是**上限**问题，用验收门禁解决更准确。

Chrome 更新后的标准动作：

```bash
npm run test:chrome     # 在本机 Chrome 同版本上重跑全部浏览器套件
# 通过后把版本与构建号写入 browser-compat.json 的 verified 列表
npm run check           # 门禁复检
```

## 3. 浏览器验收夹具不再与后台实现漂移

2.8.2 引入跨标签与离线共享请求预算后，`tests/offscreen-integration.mjs` 与
`tests/offscreen-merge-integration.mjs` 的消息桩仍只回 `{ ok: true }`——下载器拿不到
`lease`，会一直等到 15 秒预算超时，于是套件在「下载完成」处静默超时。
因为浏览器套件不在 `npm test` 里，这个红灯持续存在而无人察觉。

修法是让夹具**复用生产状态机**而不是复制一份策略：

- `tests/fixtures/fake-budget.mjs` 直接调用 `src/request-budget.js` 的 `transitionBudget`，
  夹具只提供消息入口，因此后台改预算策略时夹具不会再次漂移。
- 两个夹具同时断言「申请过租约」与「正文结束后归还租约」，把这条链路写进测试，
  而不是只求任务能跑完。

## 4. 运行期自检

`src/health-check.js` 探测扩展真正依赖的浏览器能力，结论存
`chrome.storage.local` 的 `browserHealthV1`（6 小时复用，`chrome_update` 时强制刷新）：

| 检查项 | 失效后果 |
| --- | --- |
| `storage.local` | 配置与快照无法保存 |
| `storage.session` | 共享下载预算无法持久化，授予会失败 |
| 本地缓存数据库（真实开库一次） | 离线缓存与源范围镜像不可用 |
| `declarativeNetRequest` 静态规则集 | CDN 请求缺 Referer，下载被拒 |
| `offscreen` + `runtime.getContexts` | 无法后台持续下载，或重复创建文档 |
| `downloads` | 无法保存到本地 |
| `cookies` | 无法判断 B 站登录态 |
| 浏览器版本 | 低于 `manifest.minimum_chrome_version` |

行为约定：

- 探测**只读能力**：不发网络请求、不读 Cookie 原始值；存储探测只写一个随即删除的自检键。
- 任何单项失败都只影响该项结论，自检自身永不抛错；单项探测有 3 秒超时，不拖住弹窗。
- 弹窗只在**发现失败或读不到结论**时显示「浏览器自检」区块（列出失败项 + 重新检测按钮），
  正常时完全不出现，避免制造焦虑。列表按 `data-health-check` 稳定 ID 复用节点，
  结论签名不变就不重建。
- 自检**无法**发现「扩展被停用」——被停用的扩展不运行任何代码。所以区块里固定写明
  `chrome://extensions` 的排查入口，README 也保留同样的说明。

## 5. 验证

```bash
npm run check          # 语法 + Chrome 版本兼容门禁
npm test               # 含 tests/health-check.test.mjs
npm run test:chrome    # 与本机 Chrome 同版本的四个浏览器套件
```

浏览器侧覆盖：`tests/run-popup-stability.mjs` 会模拟能力缺失，断言自检区块出现、
列出失败项、重复检测不重建节点、能力恢复后收起。
