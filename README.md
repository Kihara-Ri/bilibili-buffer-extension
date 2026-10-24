<div align="center">

<img src="assets/icon-128.png" width="96" height="96" alt="海内存知图标">

# 海内存知

[English](README.en.md) · **简体中文**

**海内存知**己，天涯若比邻。

在海外看 B 站的 Chrome 扩展：**播放时提前加载、少转圈，也能把视频完整存到本机离线看**。<br>
沿用 B 站原生播放器，不转码、无服务器，数据全部留在本机。

<sub><i>English name: <b>Kindred Afar</b>. The extension follows Chrome's language, and there is an <a href="README.en.md">English README</a>.</i></sub>

[![Chrome 商店](https://img.shields.io/chrome-web-store/v/bjegpandnhmeinmennpfpkholhmbllam?label=Chrome%20%E5%95%86%E5%BA%97&color=2bb3e6&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam)
[![用户](https://img.shields.io/chrome-web-store/users/bjegpandnhmeinmennpfpkholhmbllam?label=%E7%94%A8%E6%88%B7&color=0d425d)](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam)
[![Release](https://img.shields.io/github/v/release/Kihara-Ri/bilibili-buffer-extension?label=Release&color=e9a15b)](https://github.com/Kihara-Ri/bilibili-buffer-extension/releases)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-1587c6)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-12303d)](LICENSE)

[**官网**](https://haineicunzhi.kihara.cn) · [**添加到 Chrome**](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam) · [隐私说明](https://haineicunzhi.kihara.cn/privacy.html) · [English site](https://haineicunzhi.kihara.cn/en/) · [投喂作者](https://haineicunzhi.kihara.cn/#tip)

</div>

![海内存知：把 B 站视频提前存到身边](store/assets/marquee-1400x560.png)

> [!NOTE]
> 界面跟随 Chrome 语言：中文（简繁）显示中文，其余显示英文（英文名 **Kindred Afar**）。

## 安装

> [!TIP]
> **从 Chrome 网上应用店安装（推荐）**：打开[商店页面](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam)，点「添加至 Chrome」。之后会自动更新。

<details>
<summary>手动安装 zip（商店版本还没跟上，或者想试最新改动时）</summary>

1. 下载 [Releases](https://github.com/Kihara-Ri/bilibili-buffer-extension/releases) 里的 `haineicunzhi-<version>.zip`，或克隆本仓库。
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」。
3. 把 zip 直接拖进页面，或用「加载已解压的扩展程序」选择仓库目录。

> **注意**：手动安装的扩展可能在 Chrome 升级后被停用；插件「没反应」时，先到 `chrome://extensions` 确认它没有被停用。

</details>

## 它能做什么

在海外看 B 站，常见三个麻烦：播放频繁转圈、自动画质被莫名压低、想保存视频没有好办法。海内存知各给一条路：

| | |
| --- | --- |
| ![缓存当前视频](store/assets/screenshot-1-cache.png) | **存到本机，断网也能看**<br>按当前账号可用的最高画质（AV1 / HEVC / AVC）缓存，音视频在本机合成一个 MP4，不转码。开始后可以关掉视频页，扩展在后台下完，中断了会自己续上。也可以只存音频（Hi-Res 无损优先）。再打开已缓存的视频会自动切到本地播放，弹幕、倍速照常。 |
| ![播放时提前加载](store/assets/screenshot-2-assist.png) | **边看边提前加载，少转圈**<br>播放时把前方约 90 秒先取回来，拖进度条也不用重新等；提前就绪的部分在进度条上单独着色。节点慢时自动换备用地址，并防止一次慢样本把之后的自动画质拖低。 |
| ![片库](store/assets/screenshot-3-library.png) | **片库统一管理**<br>所有缓存任务都在「片库」里：暂停、继续不需要打开原视频；完成的可以导出文件或删除，删错了能撤销。Chrome 升级后若有能力失效，「浏览器自检」会列出具体哪一项。 |

> [!IMPORTANT]
> **适用范围**：标准 BV / av 投稿、分 P 与稍后再看页；番剧、互动视频等暂不支持。不能绕过大会员、付费或地区限制，一切以当前账号的实际权益为准。

<details>
<summary>实现要点（给好奇的人）</summary>

- 提前加载：拿到播放器首个媒体请求后，多个 Range 分片并行流水线预热前方窗口；播放器请求完整命中时直接用本机数据回应，缺口拆片补齐并复用在途分片。
- 进度条着色按 SIDX 真实分段索引映射到时间轴，不是按字节比例估算。
- 页面内存缓存驻留上限 128 MiB，前方窗口另按 96 MiB 封顶；关闭开关即取消预热并清理。
- 完整缓存分块写入 IndexedDB 事务，连续提交后才计入进度；播放地址失效自动刷新，后台自动恢复。

```mermaid
flowchart LR
  UI["弹窗<br>当前视频 · 片库"] --> SW["Service Worker<br>识别视频 · 消息路由 · 恢复任务"]
  SW --> OFF["Offscreen<br>分块下载 · 合成 MP4"]
  OFF <--> DB[("IndexedDB<br>本机缓存")]
  OFF --> CDN["B 站媒体 CDN"]
  MAIN["页面主世界观察器<br>提前加载 · 进度条着色"] --> CDN
  SW <--> CS["内容脚本<br>登录会话 · 本地播放"]
  OFF -->|已缓存的视频| CS
```

完整设计见 [技术文档.md](技术文档.md)。

</details>

## 隐私

没有服务器、没有遥测，登录态只在本机使用，Cookie 原文从不展示或保存。详见[隐私说明](privacy.html)。

## 开发

```bash
npm install        # 首次
npm run dev        # 热更新：修改代码约 1 秒内自动重载已加载的扩展与 B 站页面
npm test           # 单元与上架合规测试
npm run check      # 语法检查 + Chrome 版本兼容门禁
npm run build      # 生成 dist/unpacked 与 dist/haineicunzhi-<version>.zip（含上架体检）
npm run site:preview  # 构建官网并在 http://127.0.0.1:4310 预览（npm run test:site 做浏览器检查）
npm run test:chrome  # 下载与本机 Chrome 同版本的 Chrome for Testing，跑全部浏览器套件
npm run test:live    # 联网：真实 Chromium 加载扩展，对真实 B 站视频跑完整缓存并播放结果
```

> [!NOTE]
> 在 WSL 里开发时请安装 **Linux 版 Node（≥ 22.2）** 再用 npm。Windows 版 npm 通过 `cmd.exe` 执行脚本，而 `cmd.exe` 不支持 `\\wsl.localhost\...` 作为工作目录，会静默退回 `C:\Windows`；`npm test` 因此会直接报「找不到 scripts/run-tests.mjs」。暂时只有 Windows 版 Node 时，可以绕过 npm 直接运行脚本，例如 `node.exe scripts/run-tests.mjs`。

## 许可证

[GPL-3.0](LICENSE)。可以自由使用、修改和再分发；基于本项目再发布的版本也须以 GPL-3.0 开源。参考项目的许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 文档

- [技术文档.md](技术文档.md) — 架构、消息契约、存储、权限、术语与已知边界；**想了解实现细节从这里进**
- [docs/](docs/README.md) — 专题文档索引：现状（完整缓存、提前加载、弹窗等）、开发（构建、测试、浏览器兼容）与冻结的历史记录
- [开发日志.md](开发日志.md) — 每个版本改了什么、为什么、怎么验证
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — 参考项目与许可声明
- [store/](store/) — Chrome Web Store 提审资料

当前版本 2.13.0。版本历史见[开发日志](开发日志.md)与 [Releases](https://github.com/Kihara-Ri/bilibili-buffer-extension/releases)。问题与建议请提 [Issue](https://github.com/Kihara-Ri/bilibili-buffer-extension/issues)。
