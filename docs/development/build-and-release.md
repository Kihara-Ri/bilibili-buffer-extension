# 热更新、构建与发布

> 适用版本：v2.13.0 · 最后核对：2026-10-24
> 对应实现：`scripts/dev-reload-server.mjs`、`src/dev-reload.js`、`scripts/build-release.mjs`、`scripts/verify-release.mjs`、
> `scripts/lib/release-checks.mjs`、`scripts/lib/zip.mjs`、`scripts/build-icons.mjs`、`scripts/build-site.mjs`。
> 商店提审的操作步骤见 [store/README.md](../../store/README.md)。

## 1. 开发态热更新

`npm run dev` 启动只监听 `127.0.0.1:17321` 的本机服务：

1. 递归监听仓库文件，变化后（去抖）生成新的 `revision`；
2. Offscreen 每 750 ms 请求 `/health`；
3. 发现 `revision` 变化后通知 Service Worker；
4. Service Worker 把待刷新的 revision 写入 `chrome.storage.local["devReloadPendingRevisionV2"]`，然后调用 `chrome.runtime.reload()`；
5. 新的 Service Worker 启动后消费这个标记，只刷新已打开的 B 站视频 / 列表页；
6. 页面刷新后，MAIN、ISOLATED 和普通内容脚本重新注入。

Manifest 里固定的 `key` 让扩展 ID 保持不变；IndexedDB 归属于这个 ID，所以热更新不会删除片库或断点。

**验证重载真的生效**：`npm run test:extension` 在独立的临时 Chromium profile 里加载生产 manifest，临时改动 bundle 标记后调用 `runtime.reload`，刷新受测页，校验新标记与 SHA-256，最后恢复 bundle 并删除 profile。这个 profile 必须开启开发者模式，否则新版 Chromium 会在 reload 时以 `unsupportedDeveloperExtension` 禁用扩展——这不是扩展本身的故障。

**dev 与生产隔离**：热更新代码只在 `src/dev-reload.js` 里，不进入 manifest 的内容脚本列表；构建时被删除（见下节）。

## 2. 发布构建

`npm run build` 生成 `dist/unpacked/` 与 `dist/haineicunzhi-<version>.zip`，然后自动运行 `npm run verify`。构建脚本会：

- 删除 `src/dev-reload.js`，并从 background 与 offscreen 里剥离热更新的 import 与调用；
- 通过 `toReleaseManifest`（`scripts/lib/release-checks.mjs`）删除 `key` 字段和 `http://127.0.0.1/*` 主机权限——开发态与发布态清单共用同一份变换规则，构建和校验不会各维护一套；
- 复制 `privacy.html`（弹窗页脚指向它，离线也能打开）；
- 校验 manifest 引用的文件都存在；
- 用 `scripts/lib/zip.mjs`（Node 内置 zlib，不依赖系统 `zip`，Windows 同样可用）写出 zip：条目按路径排序、时间戳固定为 `SOURCE_DATE_EPOCH`（默认 2026-01-01）、不写权限位。同一份源码重复构建逐字节相同。

`scripts/verify-release.mjs` 用同一模块读回 zip，逐字节核对它与 `dist/unpacked` 一致，并打印 SHA-256。

## 3. 上架合规

Chrome Web Store 的政策要求与代码之间有几处「改代码就会踩到」的耦合。

### 3.1 扩展 ID 必须与 DNR 规则一致

`rules/cdn-headers.json` 用 `condition.initiatorDomains` 把「补 B 站 Referer」限定在本扩展自己发起的请求上，而 DNR 对扩展请求匹配的是**扩展 ID 这个主机名**。

| ID | 值 | 来源 |
| --- | --- | --- |
| 本地开发 ID | `ppoagkhgdcfchiodhgadpenibndbnhcj` | 由 `manifest.json` 的 `key` 推导（公钥 DER 的 SHA-256 前 16 字节，每个半字节映射到 a–p） |
| 商店 ID | `bjegpandnhmeinmennpfpkholhmbllam` | 商店分配，`STORE_EXTENSION_ID` |

因此：

- 删除或更换 `key` 会改变本地开发 ID，开发版规则立即失效，CDN 开始返回 403；
- 商店包不能带 `key`：已发布商品的公钥由商店持有，上传带开发 key 的包会被拒收（「清单中 "key" 字段的值与当前内容不符」）。`toReleaseManifest` 构建时剔除它，`checkManifestFields(…, { release: true })` 拒绝残留；
- 两个 ID 都必须写进每条规则的 `initiatorDomains`，缺了商店 ID，商店安装版的 CDN 与 API 请求补不上 Referer；
- 规则里写成站点域名（如 `www.bilibili.com`）就变成修改网页自己的请求，属于越权。

`checkDnrRules` 会拒绝以上情况。不要手工推算 ID，用 `node scripts/verify-release.mjs` 或测试里的 `extensionIdFromKey`。

### 3.2 权限最小化

`ALLOWED_PERMISSIONS` 是权限白名单，`npm run verify` 对发布清单做硬校验，出现白名单外的权限直接失败。新增权限时必须同时更新白名单、`store/listing.md` 的理由表、[技术文档的权限表](../../技术文档.md#5-权限)，并在提交信息里说明用途。

### 3.3 名称的呈现：诗句连读

名字取自「海内存知己，天涯若比邻」，各处都让主名与诗句连读，而不是「名字 + 副标题」：

- **弹窗页眉**：一个 `h1` 里，`.brand-name`「海内存知」紧贴 `.brand-verse`「己，天涯若比邻」，同字号、同字距、无间隙，只靠字重（650 / 400）与颜色（`--ink-soft`，浅深色都约 4.5:1）区分。缩小字号或加间距会让「己」脱离上半句；不用 `opacity` 减弱，因为它随底色漂移。
- **商店截图左栏与小促销图**：空间够时按诗句断行，「海内存知**己**」一行（「己」减弱），「天涯若比邻」另起一行。
- **商店 Item name** 不能排版，仍是纯文本「海内存知」；诗句放在详细描述第一行。
- `tests/run-popup-stability.mjs` 断言页眉两段同一行、间隙 < 3px、同字号、字重和颜色不同、不压住设置按钮。

### 3.4 图标

「漂流瓶」矢量图标：浮在海浪上的蓝色漂流瓶，琥珀色瓶塞，瓶内半瓶深蓝色的水（水位 = 已缓存，水面保持水平、用瓶身轮廓裁剪），上面一个白色播放键，取意视频漂洋过海、已经存在身边。播放三角不随瓶身倾斜、始终水平朝右——随瓶身旋转会被读成下载箭头。

- 母版只有填充路径与裁剪路径，没有位图、字体、滤镜或外部资源。小尺寸母版 `icon-small.svg` 去掉海浪与玻璃高光、水面改为直线、放大瓶身与播放三角，保证 16 像素仍能看出「瓶 + 播放」。
- Chrome 的 manifest 图标不支持 SVG，实际加载由 `scripts/build-icons.mjs` 从母版渲染的 PNG。
- Chrome 建议 128 画布内放 96×96 图形、四周 16 像素透明——工具栏图标会叠在深色或彩色底上，不透明底色会变成突兀的方块。自检规则：四角 alpha 必须为 0，48 / 128 的留白不少于 12.5%，16 / 32 至少留 1 像素。

### 3.5 隐私与数据处理

扩展没有服务端，所有数据都在本机。为了让这一点在审查与用户侧都可验证：

- `privacy.html` 是唯一的数据处理说明，同时打包进扩展（弹窗页脚常驻入口）并随官网发布；
- 页面自包含（无外部脚本与样式），离线打开和商店抓取都能正常显示；
- Limited Use 声明以连续原文出现，不被标签切断；
- 2026 年 7 月的政策更新要求「安装后也要显著披露数据处理方式」，这是弹窗常驻页脚的由来。

### 3.6 校验分层

| 层 | 位置 | 覆盖 |
| --- | --- | --- |
| 语法 | `scripts/check-syntax.mjs` | 对仓库所有 `.js` / `.mjs` 跑 `node --check` |
| 规则 | `scripts/lib/release-checks.mjs` | 纯函数判断，有单元测试喂坏样本，防止条件写反后「永远通过」 |
| 单元 | `tests/store-compliance.test.mjs`、`tests/icon-compliance.test.mjs`、`tests/release-zip.test.mjs` | 真实文件符合要求 + 坏样本必须被拒；`store/listing.md` 与 manifest 的描述、权限、素材一致 |
| 发布包 | `scripts/verify-release.mjs` | 对 `dist/unpacked` 与 zip 做文件级检查，打印 SHA-256 |

## 4. 官网 haineicunzhi.kihara.cn

官网是纯静态页面，源码在 `site/`，由 `scripts/build-site.mjs` 构建到 `dist/site/`；`.github/workflows/pages.yml` 在每次推送 `main` 时发布到 GitHub Pages（自定义域名 `haineicunzhi.kihara.cn`，DNS 为指向 `kihara-ri.github.io` 的 CNAME）。

- **中英双语**：中文首页 `site/index.html` 输出到 `/`，英文页 `site/en/index.html` 输出到 `/en/`，两页结构一一对应（测试比对分节），用 `hreflang` 互指，`x-default` 指向英文；顶栏有语言切换。中文首页对浏览器语言不含中文的访客显示一行英文入口（`site.js`），只提示不跳转。英文页的演示弹窗用 `?lang=en` 渲染英文界面，社交预览图用 `og-en.png`（英文顶部宣传图），更新记录仍为中文标题并注明。隐私说明沿用 `privacy.html`（末尾已有英文版）。
- **内容来自仓库**：版本号读 `manifest.json`；页尾折叠的「更新记录」取 `开发日志.md` 里最近 8 个 `## x.y.z · 标题` 小节的标题（只认这种格式，汇总类小节不进网站），完整日志链接到 GitHub；`privacy.html` 原样发布，旧地址 `kihara-ri.github.io/bilibili-buffer-extension/privacy.html` 由 GitHub 跳转到新域名。
- **真实弹窗演示**：复用 `store/scene` 场景夹具，只复制 `src/popup.js` 静态 import 到的模块；后台、Offscreen、内容脚本和热更新代码不会出现在网站上。演示与页面同源，页面按弹窗内容高度调整 iframe，窄屏时整体缩放。
- **投喂**：`#tip` 一节放作者的支付宝收款码（`site/assets/alipay-qr.png`，金额由付款人填写）和四张菜单卡片（甜筒 ¥5 / 薯条 ¥10 / 咖啡 ¥20 / 随你心意）。图标是 `site/index.html` 里自绘的 SVG symbol，刻意不用餐饮品牌标识，以免被误认为商业合作。触屏设备另显示「打开支付宝投喂」按钮，链接 `ALIPAY_URL`（即二维码内容）。页面明确写明自愿、不解锁任何功能；扩展本身不含任何打赏入口。
- **顶栏随滚动变色**：压在深海蓝首屏上时为深底白字；首屏底边滑过顶栏下方的 120px 内，底色混合成正文底色，过半时文字与描边一次切成深色（`site.js` 写 `--bar-mix` 与 `.is-light`）。底色跳过 45%–75% 的中灰段，因为那里白字和深字都不够读。深色模式下正文本身是深色，顶栏保持深色；没有脚本时退回深色顶栏。仍不用 `backdrop-filter`。
- **不加载第三方资源**：没有网络字体、统计或 CDN 脚本。扩展也从不访问官网域名，`host_permissions` 不变。
- **测试**：`tests/site-build.test.mjs`（纳入 `npm test`）校验占位符、GitHub 入口、更新记录首条等于当前版本、本地引用都存在、无第三方资源、演示不含后台代码；`npm run test:site` 对中英文两页在 320 / 375 / 1280 宽度下检查无横向滚动、顶栏元素不重叠、顶栏在首屏 / 变色中段 / 正文处（浅色与深色模式）的文字对比度，并检查英文入口提示只对非中文浏览器显示、演示加载且高度贴合、诗句不被拆行、减少动态时无动画、深色模式生效。
