# Chrome Web Store 提审文案

本文件是开发者仪表盘（[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)）里要逐项粘贴的内容。
**正文以本文件为准**；改完扩展后请同步这里，`npm test` 会校验摘要与 `manifest.json` 是否一致。

- 对应版本：2.6.3
- 提交包：`dist/bili-buffer-extension-2.6.3.zip`
- 提交前校验：`npm run check && npm test && npm run build`

---

## 0. 必须先做的两个决定

### 0.1 名称与商标（建议改名后再提审）

当前名称为 **Bili 缓冲站**；图标已改为原创「提前一格」蓝青色播放与缓冲分段造型，不再使用电视机与粉色组合。名称与详情页仍需清楚表达非官方身份。
商店政策 [Impersonation & Intellectual Property](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property) 第 1、5 条禁止暗示“获得对方授权或由对方出品”，第 6 条说明可能因此降低曝光。最终是否通过由商店审核决定。

三种处理方式，任选其一后同步 `manifest.json`、`popup.html`、`README.md` 与图标：

| 方案 | 名称 | 风险 | 说明 |
| --- | --- | --- | --- |
| A（推荐） | `缓冲站 · B 站视频缓存助手` | 低 | 只用“B 站”作为兼容性描述（指名性使用），并去掉疑似官方视觉元素 |
| B | `Bili 缓冲站`（保持现状） | 中 | 必须在详情页首段写明“非官方、与哔哩哔哩无隶属关系”，并接受可能被要求整改 |
| C | `缓冲站 · 网页视频离线缓存` | 最低 | 完全不含对方名称，但搜索曝光会明显下降 |

无论选哪个方案，详细描述里都已包含免责声明，请保留。

### 0.2 隐私政策网址

`privacy.html` 需要有一个可公开访问的网址。仓库是公开仓库，最省事的方式是用 GitHub Pages：

1. 仓库 `Settings → Pages`，Source 选 `Deploy from a branch`，branch 选 `main`、目录选 `/ (root)`。
2. 保存后等待约一分钟，隐私政策网址即为
   `https://kihara-ri.github.io/bilibili-buffer-extension/privacy.html`
3. 把这个网址填进仪表盘的 **Privacy policy URL**。
4. 打开确认能正常显示（页面不引用任何外部资源，离线也能打开）。

---

## 1. Store listing → Product details

| 字段 | 填写内容 |
| --- | --- |
| **Item name** | `Bili 缓冲站`（8 字，上限 75 字；改名见 0.1） |
| **Summary** | 与 `manifest.json` 的 `description` 完全一致，见下方 |
| **Category** | `Productivity` |
| **Language** | `Chinese (Simplified)` |

### Summary（≤132 字，与 manifest 一致）

```
提前加载 B 站 CDN 后续内容，并把最高可用画质的音视频合并缓存到本地播放，也可只缓存保留原始音质的音频。
```

### Detailed description

```
Bili 缓冲站把 B 站视频提前缓存到本机，之后可以离线播放或另存为文件。它只在你点击按钮或打开开关后工作，不修改网页内容，也没有服务器。

【播放提前加载】
· 取得播放器首个媒体范围后立即预热：先补初始化区与分段索引，再按当前播放位置挑选前方分段。
· 完整命中时直接用本机数据回给播放器，缺口或格式不匹配时自动回退原始请求。
· 进度条沿用原生控件，只把“已提前加载”的部分单独着色，可自定义颜色或关闭区分。

【完整缓存到本机】
· 按当前账号实际返回的画质缓存，默认选最高可用档位；也可以只缓存音频。
· 音视频两条轨道分别下载后在本机重封装成一个 MP4，不转码；仅音频保留 B 站原始容器与编码（Hi-Res 无损 / 杜比全景声 / AAC）。
· 视频最多 4 路、音频 1 路并发，固定 2 MiB 分块下载；会先比较主备 CDN，遇到签名过期、HTTP 403、限流或临时断网时刷新地址并从最后一个已落盘分块续传。
· 关闭弹窗、切换标签页、关闭原视频页之后下载继续；后台被回收后由看门狗重新接管。

【片库与导出】
· 已缓存的视频集中列在片库中，显示体积与状态；完成项可保存为本地文件或直接删除。
· 再次打开同一个视频时，插件会直接用本机缓存播放，保留原生控制条、倍速、进度与弹幕同步。

【隐私】
· 没有服务器，不收集、不上传任何数据，不含统计、埋点与广告 SDK。
· 只在点击缓存或开启提前加载后，向 B 站视频 CDN 发起与你正常观看时相同的请求。
· 登录态只用于判断“是否已登录”，不读取 cookie 的值。
· 所有缓存与设置都保存在你自己的 Chrome 配置里；删除缓存或卸载扩展即可清除。

【适用与边界】
· 支持标准 BV / av 投稿、分 P 以及带 bvid 的稍后再看页面；番剧、互动视频、课程暂不支持。
· 只使用当前账号本来就有的观看与画质权限，不绕过会员、付费、地区或内容授权限制。
· 需要 Chrome 116 或更高版本。
· 本扩展不是哔哩哔哩官方产品，与哔哩哔哩没有隶属或授权关系；请只缓存你有权观看的内容，并遵守平台条款与版权要求。
```

### Additional fields

| 字段 | 填写内容 |
| --- | --- |
| **Homepage URL** | `https://github.com/Kihara-Ri/bilibili-buffer-extension` |
| **Support URL** | `https://github.com/Kihara-Ri/bilibili-buffer-extension/issues` |
| **Official URL** | 留空（未做站点归属验证） |
| **Mature content** | 不勾选 |

---

## 2. Privacy practices

### 2.1 Single purpose description

```
把哔哩哔哩视频提前缓存到本机，并在原网页播放器中复用这些本地数据，以便离线播放或另存为文件。扩展不提供除此之外的功能：没有广告、没有内容推荐、不修改网页正文、不收集数据。
```

### 2.2 Permissions justification

逐条粘贴。**不要申请清单里没有的权限**；新增权限必须同时更新 `scripts/lib/release-checks.mjs` 的白名单与本节。

| 权限 | 理由（粘贴到对应输入框） |
| --- | --- |
| `activeTab` | 读取当前标签页的地址，用于判断它是否为支持的 B 站视频页，并在弹窗中给出对应的提示。扩展不使用该权限读取页面内容或注入脚本。 |
| `alarms` | 每分钟运行一次看门狗，在 MV3 Service Worker 被浏览器回收后重新接管尚未完成的缓存任务，使长视频下载不会静默中断。 |
| `cookies` | 仅调用 `chrome.cookies.get` 查询 `SESSDATA` **是否存在**，用于显示“已登录 / 未登录”提示并在登录状态变化时刷新面板。不读取、不保存、不传输该 Cookie 的值。 |
| `declarativeNetRequestWithHostAccess` | 通过静态规则（`rules/cdn-headers.json`）为扩展自身发往 B 站视频 CDN 的下载请求补充 `Referer`，以满足 CDN 的防盗链校验。规则限定 `initiatorDomains` 为本扩展 ID，不会影响其他页面或站点发起的请求。 |
| `downloads` | 把用户已缓存的视频或音频保存为用户选择的本地文件。 |
| `offscreen` | 使用 Offscreen Document 在后台继续下载、续传与 MP4 重封装，使关闭弹窗或关闭原视频页后任务仍能完成（MV3 Service Worker 无法持有这类长时间运行的媒体处理）。 |
| `storage` | 保存用户偏好（缓存内容、画质、进度条配色）、缓存任务进度以及弹窗界面快照，使界面在重新打开后立即恢复。 |
| `unlimitedStorage` | 视频缓存保存在 IndexedDB 中，体积很容易超过扩展的默认存储配额；不申请该权限会导致长视频缓存中途写入失败。 |
| 站点访问权限 `https://*.bilibili.com/*` | 读取视频页面信息、在播放页面注入内容脚本、通过页面自身的登录会话请求播放地址。 |
| 站点访问权限 `https://*.bilivideo.com/*` `https://*.bilivideo.cn/*` `https://*.akamaized.net/*` | 从 B 站实际使用的视频 CDN 下载媒体分块。这些域名是播放接口返回的下载地址所在域。 |
| 站点访问权限 `https://*.hdslb.com/*` | 加载封面与头像图片，用于片库列表展示。 |

### 2.3 Remote code

选择 **"No, I am not using remote code."**

已经可以静态检查这一点：发布包内不存在 `eval`、`new Function`、`importScripts`、远程 `<script src>` 或内联脚本；
`npm run build` 结束时的 `npm run verify` 会逐文件扫描并失败退出。

### 2.4 Data usage（勾选）

关于“是否收集数据”的判定：Chrome 的定义是**数据离开用户设备**才算收集（[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)）。
本扩展没有任何服务端，所有数据都在本机，因此：

**第一组复选框（收集的数据类型）：全部不勾选。**
如果仪表盘强制要求至少勾选一项，则只勾选 `Authentication information`，并在说明中写明“仅在本机判断登录状态是否存在，不读取值、不传输”。

**第二组认证声明：全部勾选**，并确认以下事实与之相符：

- 不将数据用于与单一用途无关的目的；
- 不出售或转让用户数据；
- 不将数据用于个性化广告、信用评估或借贷判断；
- 不允许人工读取用户数据（因为根本不上传）；
- 遵守 Limited Use 要求（见 `privacy.html` 第 9 节）。

### 2.5 Privacy policy URL

填 `https://kihara-ri.github.io/bilibili-buffer-extension/privacy.html`（见 0.2）。

---

## 3. Graphic assets

素材由脚本生成，规格见 `store/README.md`。全部放在 `store/assets/` 下。

| 素材 | 文件 | 尺寸 | 是否必需 |
| --- | --- | --- | --- |
| Store icon | 用 `assets/icon-128.png` | 128×128 PNG | 必需 |
| 截图 1 | `store/assets/screenshot-1-cache.png` | 1280×800 | 必需（1~5 张） |
| 截图 2 | `store/assets/screenshot-2-assist.png` | 1280×800 | 建议 |
| 截图 3 | `store/assets/screenshot-3-library.png` | 1280×800 | 建议 |
| Small promo tile | `store/assets/promo-440x280.png` | 440×280 | 必需 |
| Marquee promo tile | 未提供 | 1400×560 | 可选 |
| Promo video | 未提供 | YouTube 链接 | 可选 |

截图要求：方角、无内边距（full bleed）、不得模糊或变形、文案量不宜过多。

---

## 4. 给审核员的说明（Reviewer notes）

粘贴到 **Distribution → Reviewer notes**，能显著缩短审核时间：

```
测试步骤（无需登录账号即可验证主体功能）：
1. 打开任意普通投稿视频页，例如 https://www.bilibili.com/video/BV1GJ411x7h7
2. 点击工具栏中的扩展图标；面板会显示当前视频、画质列表和缓存大小。
3. 保持默认“视频 + 音频”，点击居中“缓存”按钮，可看到分块进度与速度；完成后在有缓存的视频页重新打开播放器，会用本地数据播放。
4. 切换到“播放”页签可开关“提前加载”，以及自定义进度条配色（只改颜色，不改交互）。
5. “片库”页签列出已缓存项目，可保存到本地或删除。

说明：
- 扩展只在 B 站视频页与 B 站 CDN 上工作，不修改任何其他网站。
- 无服务器、无账号体系，不收集数据；隐私政策见 Privacy policy URL。
- 不使用远程代码；发布包内无 eval / new Function / 内联脚本（npm run verify 会校验）。
- 若需要验证“最高画质”与无损音频，请使用你自己的账号；扩展只使用账号本身已有的权益。
- 缓存长视频需要较长时间，可先用短视频（数分钟）验证。
```

---

## 5. 提交前检查清单

- [ ] `npm run check` 通过（遍历式语法检查）
- [ ] `npm test` 全部通过（含商店合规测试）
- [ ] `npm run build` 通过，且末尾的 `npm run verify` 输出“发布包检查通过”
- [ ] `manifest.json` 与 `store/listing.md` 中的名称 / 摘要一致
- [ ] 0.1 的名称与商标问题已决定并同步到清单、图标、README
- [ ] `privacy.html` 已可通过公网网址访问，且内容与第 2 节一致
- [ ] `store/assets/` 下的截图与小促销图是最新版本界面
- [ ] 用 `dist/unpacked` 在本地 `chrome://extensions` 里实际加载一次，确认能正常打开弹窗
- [ ] 记录本次提交包 SHA-256（`npm run verify` 会打印）
