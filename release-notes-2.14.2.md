## 2.14.2 · 4K 下载不再卡在队头，暂停与删除更顺手

- **修复：大视频下到 15%~20% 后速度掉到几百 KB/s、百分比不动**。视频必须按顺序存盘，最前面的一小块碰上一条极慢但不断开的连接时，后面下好的部分只能干等。现在会对这一块换个节点再请求一次，谁先下完用谁，速度与进度恢复正常
- **修复：所有画质卡片显示同一个体积**。缓存过某一档后，其他画质也显示成那一档的大小；现在每档按自己的码率估算
- **修复：删除未下载完的视频后点「缓存」，按钮转一圈又变回「缓存」**。删除后 6 秒的撤销期内对同一画质点「缓存」，现在等同于撤销删除，从原进度继续
- **改进：暂停与出错保持下载中的样式**。不再变回粉色按钮，显示「已暂停 N%」和已缓存大小；右侧圆钮变成「继续」
- **改进：主按钮加入漂流瓶元素**。进度条前沿是一道缓慢起伏的水波（暂停时停住，系统开启「减少动态效果」时静止）；「缓存」与「已缓存」前各有一只漂流瓶
- 无新权限、无新网络请求，隐私说明不变

## 安装与升级

- 推荐从 [Chrome 网上应用店](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam) 安装，自动更新
- 附件 `haineicunzhi-2.14.2.zip`（SHA-256 `27808dae3d63e6ca25920b091f77d207dad738390333519c4eade3513f5e4dbc`）：打开 `chrome://extensions`（开启开发者模式）后直接拖入
- 手动安装的扩展可能在 Chrome 升级后被停用，「没反应」时先确认扩展未被停用

完整记录见仓库内 `开发日志.md`。

---

**English** — 2.14.2 fixes large downloads that slowed to a few hundred KB/s with progress stuck around 15–20%: when the first pending chunk is stuck on a slow connection, it is now requested again from another node, and whichever copy finishes first wins. Quality cards now show their own estimated size instead of the cached quality's size, and clicking Cache during the 6-second undo window after deleting an unfinished video now restores it instead of flickering back. Paused and failed downloads keep the in-progress look with a Resume button, and the cache button gains small message-in-a-bottle touches: a gentle wave on the progress edge (still when paused or with reduced motion) and a bottle next to Cache and Cached. No new permissions or network requests.
