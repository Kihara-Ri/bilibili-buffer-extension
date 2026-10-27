## 2.14.5 · 滑杆更稳：落定后再切换

- **改进：画质滑杆落定后才切换**。拖动途中名称、体积不再随拖过中点而变；松手后拇指滑到最近档位，停稳才切换并保存。键盘方向键仍立即切换
- **改进：点两档之间不再「飘」**。点按时拇指直接平滑滑向最近的档位，不再先冲到指针处再回弹；指针移动超过 6px 才算拖动
- **改进：去掉回弹**，落档改为无过冲的缓出
- **修复：滑行时蓝色填充拖在拇指后面（拖尾）**
- 无新权限、无新网络请求，隐私说明不变

## 安装与升级

- 推荐从 [Chrome 网上应用店](https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam) 安装，自动更新
- 附件 `haineicunzhi-2.14.5.zip`（SHA-256 `c53a00cd797ce7089c8c883ed24f43d8b4807748a3720fc5dbd76ff3aef880d0`）：打开 `chrome://extensions`（开启开发者模式）后直接拖入
- 手动安装的扩展可能在 Chrome 升级后被停用，「没反应」时先确认扩展未被停用

完整记录见仓库内 `开发日志.md`。

---

**English** — 2.14.5 makes the quality slider steadier: the quality only switches once the thumb has settled (not while you drag past a midpoint), clicking between two tiers glides straight to the nearest one with no overshoot, and the fill no longer trails behind the thumb. No new permissions or network requests.
