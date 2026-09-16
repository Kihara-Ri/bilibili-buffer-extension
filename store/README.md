# 上架资料与提交流程

这个目录是提交 Chrome Web Store 时用到的一切：文案、素材、操作步骤与自检项。
**它不是扩展的一部分**，`npm run build` 只会把 `privacy.html` 打进发布包，本目录不会被复制进 `dist/unpacked`。

```
store/
├── README.md            本文件：提交流程与每版发布步骤
├── listing.md           仪表盘里要逐项粘贴的文案、权限理由与数据披露答案
├── assets/              商店图片素材（脚本生成，需提交）
│   ├── screenshot-1-cache.png     1280×800
│   ├── screenshot-2-assist.png    1280×800
│   ├── screenshot-3-library.png   1280×800
│   └── promo-440x280.png          440×280 小促销图
└── scene/               生成截图用的界面场景（加载真实 popup.html / popup.css / popup.js）
```

---

## 一、图片素材怎么生成

```bash
npm install --no-save playwright   # 已装可跳过
npx playwright install chromium
npm run store:assets
```

（同一套 Playwright 也用于 `npm run icons` 重导图标，以及 `npm run test:popup` /
`npm run test:playback` / `npm run test:extension` 三组浏览器验收。）

脚本做三件事，任何一步不满足都会直接失败，不会生成“看起来还行但和真实界面不符”的图：

1. 用 `store/scene/popup-scene.html` 加载**真实的** popup 界面（只替换 `chrome.*` 返回的演示数据），
   所以截图里的按钮、页签、文案永远来自源码，界面改了重跑一次即可。
2. 断言当前视图没有被裁断（内容高度、页脚位置都在视口内），断言排版没有越界或重叠。
3. 回读生成的 PNG 校验尺寸必须精确等于 1280×800 / 440×280。

配合 `npm test` 里的商店合规测试，可以保证素材存在且尺寸正确。

---

## 二、首次提交步骤

前置：已注册 Chrome Web Store 开发者账号（一次性 5 美元注册费）。

1. **先补两个决定**（见 `listing.md` 第 0 节）：
   - 名称与商标：当前 `Bili 缓冲站` + 电视造型图标与哔哩哔哩商标接近，建议改名后再提审。
   - 隐私政策网址：把仓库 `main` 分支根目录发布为 GitHub Pages，得到
     `https://kihara-ri.github.io/bilibili-buffer-extension/privacy.html`。
2. **跑通校验并出包**
   ```bash
   npm run check && npm test && npm run build
   ```
   最后一步会打印 `发布包检查通过` 与该包的 SHA-256，把 SHA-256 记进本次版本说明。
3. **上传**
   - 打开 [开发者仪表盘](https://chrome.google.com/webstore/devconsole) → `Add new item`，
     上传 `dist/bili-buffer-extension-<version>.zip`。
   - 上传后 `Package` 页点 `View public key`，确认它的 ID 与
     `rules/cdn-headers.json` 里的 `initiatorDomains` 一致。**不一致就必须停下**：
     防盗链 `Referer` 规则会失效，缓存会开始大面积 403。
     本地可以直接核对：`node -e 'const c=require("crypto");const k=require("./manifest.json").key;const d=c.createHash("sha256").update(Buffer.from(k,"base64")).digest().subarray(0,16);console.log([...d].map(b=>String.fromCharCode(97+(b>>4))+String.fromCharCode(97+(b&15))).join(""))'`
   - 若想让商店沿用本地开发 ID，保持 `manifest.json` 里的 `key` 不变即可；
     删掉 `key` 会换 ID，已有用户的缓存与 DNR 规则都会跟着失效。
4. **填 Store listing**：按 `listing.md` 第 1 节逐项粘贴。
5. **填 Privacy practices**：按 `listing.md` 第 2 节逐项粘贴；权限列表必须与 `manifest.json` 完全一致，
   多出来的权限请删权限而不是编理由。
6. **填 Distribution**：访问范围、可见性，以及 Reviewer notes（`listing.md` 第 4 节）。
7. **提交审核**。首次审核通常几天；被驳回时先看驳回理由属于哪一条政策，
   改完在 `listing.md` 里补一句记录，再重新提交。

---

## 三、每个后续版本要做什么

1. 改功能 → 同步测试与文档（`README.md`、`技术文档.md`、`开发日志.md`）。
2. 同步版本号：`manifest.json` 与 `package.json` 必须一致（`npm run verify` 会校验）。
3. 若界面有变化：`npm run store:assets` 重新出图，并在 `listing.md` 里核对文案。
4. 若新增权限：同时更新 `scripts/lib/release-checks.mjs` 白名单与 `listing.md` 的权限理由表，
   并在提交信息里写明用途。
5. `npm run check && npm test && npm run build`。
6. 在 `开发日志.md` 写清本版改了什么、为什么、怎么验证，附上包内 SHA-256。
7. 更新商店的详细描述（如果有面向用户的变化）与变更记录，然后上传新包。

---

## 四、常见驳回原因与对应防线

| 政策 | 本项目的防线 |
| --- | --- |
| 单一用途（Quality Guidelines） | 扩展只做“缓存 B 站视频并复用本地数据”一件事，无广告、无推荐、不修改网页正文 |
| 权限最小化（Minimum Permissions） | 8 个权限逐条写明用途；`npm run verify` 对权限白名单做硬校验，新增权限会直接失败 |
| 数据使用与披露（Limited Use / Disclosure） | 无服务端、不上传数据；`privacy.html` 写明数据去向与 Limited Use 声明；弹窗页脚常驻隐私入口 |
| 远程代码（Remote Code） | 发布包内无 `eval` / `new Function` / `importScripts` / 远程或内联脚本，`npm run verify` 逐文件扫描 |
| 知识产权与假冒（Impersonation & IP） | **当前最大风险**：名称与图标需按 `listing.md` 第 0.1 节处理，截图与详情页均带“非官方”声明 |
| 关键词堆砌（Keyword Spam） | 摘要与详细描述只描述真实功能，不堆叠无关关键词 |
| 图片规范 | 素材由脚本生成并强制校验尺寸；截图 1280×800 方角无内边距 |
| 清单字段超限 | `npm run verify` 校验名称 ≤75 字、描述 ≤132 字、图标四尺寸齐全且带透明留白 |

---

## 五、发布包检查覆盖了什么

`npm run build` 结尾自动执行 `npm run verify`（也可单独 `npm run verify`），逐项检查：

- 清单：MV3、版本与 `package.json` 一致、名称与描述字数、`key` 存在；
- 图标：16/32/48/128 齐全、尺寸正确、四角透明、图形留白符合 Chrome 图标规范；
- 权限：只允许白名单内的权限、`host_permissions` 全为 https 且不含本地地址；
- 代码：无开发态热更新残留、无 `eval` / `new Function` / `importScripts` / 内联脚本 / 远程脚本；
- 规则：DNR 的 `initiatorDomains` 与 `key` 推导出的扩展 ID 一致；
- 压缩包：`manifest.json` 在根目录、无 `.DS_Store` / `_metadata` / 多层嵌套目录、版本一致；
- 打印包体大小与 SHA-256。

发布包可复现：构建在打包前统一所有文件的 mtime 与权限位（可用 `SOURCE_DATE_EPOCH` 覆盖），
并按排序后的文件列表打包（`zip -r .` 的遍历顺序依赖文件系统），
因此同一份源码重复 `npm run build` 会得到字节完全相同的 zip，
记录下来的 SHA-256 才能真正用来核对“商店里的包就是这个提交构建出来的”。

判断逻辑在 `scripts/lib/release-checks.mjs`，有单元测试覆盖“坏样本必须被拒绝”，避免检查条件写反而永远通过。
