## 2.14.1 · 后台下载不再降速，删除任务不再「复活」

- **修复：切走窗口或关掉弹窗后，下载速度骤降、进度停在开头一段**。下载时会顺带把视频开头一段存一份给在线播放复用，这一步原本很耗 CPU；浏览器或系统在后台给扩展降优先级（如 Windows 效率模式）时，它会拖垮下载本身：速度还在跳，百分比却几乎不动。现在这一步改为直接写入本地数据库，几乎不占 CPU。模拟后台降速的对照测试中，开头约 100 MB 的下载速度从约 1.8 MB/s 恢复到约 10 MB/s
- **修复：删除下载中的任务后，记录带着旧进度复活**。之前删除后重新缓存，会从删除前的位置（例如 20%）「续传」，前面的数据却已经没了，删除后马上再点缓存也可能没反应。现在删除会等下载完全停下再清理，重新缓存从头开始
- 无新权限、无新网络请求，隐私说明不变

## 安装与升级

- 推荐从 [Chrome 网上应用店](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam) 安装，自动更新
- 附件 `haineicunzhi-2.14.1.zip`（SHA-256 `02cf95f3878b5d0944a296085802f1cdc40bbb6f5c5a9c13becfa72d35e5a843`）：打开 `chrome://extensions`（开启开发者模式）后直接拖入
- 手动安装的扩展可能在 Chrome 升级后被停用，「没反应」时先确认扩展未被停用
- 升级前因删除问题留下的残缺任务，建议在片库里删掉后重新缓存

完整记录见仓库内 `开发日志.md`。

---

**English** — 2.14.1 fixes two cache bugs. Downloads no longer slow to a crawl when you switch away from the window or close the popup: a CPU-heavy side step that kept a copy of the first part of the video for online playback is now written straight to the local database. Deleting a download in progress no longer brings it back at its old progress, and re-caching starts from the beginning. No new permissions or network requests. Install from the store (recommended) or drag the attached zip into `chrome://extensions` with Developer mode on.
