# Guided GitHub Update Implementation Plan

> **For agentic workers:** Use executing-plans to implement the approved workflow in this session. Steps use checkbox syntax. The user approved implementation with「这样做」; no commit or release is requested.

**Goal:** 首次帮助用户连接正确安装文件夹，后续记住并复用；源码安装不提供不能成功的安装入口。

**Architecture:** 用现有 distribution 构建标记区分源码／GitHub／商店。抽出只在授权范围内工作的有界目录查找，沿用随机探针证明真实运行目录。页面用稳定节点呈现首次连接、已连接、待授权和恢复状态。

**Tech Stack:** MV3、原生 JS/HTML/CSS、File System Access、IndexedDB、Node test、Playwright Chromium。

**Spec:** 本会话批准的三步流程：识别安装方式；安装位置入口与图示、允许上级目录查找；记住目录后一键更新。

## Global Constraints

- 不新增权限、依赖，不改版本，不提交或发布；保留已有并行修改。
- 商店包继续剔除更新引擎；源码安装只检查版本、提供源码说明。
- 不静默获取权限；只扫描用户选定范围，保留仓库覆盖保护和运行目录探针。
- 目录授权可能失效；不把旧句柄视为当前授权，不把探针失败视为连接成功。

## Review Focus

- 同版本副本：必须探针证明运行目录，不能只比较 manifest。
- 大文件夹／拒绝读取：限制深度和条目数，扫描不完整不宣布未找到。
- 已保存句柄失效：重新授权或重新连接，不自动弹选择器。
- 扫描期间取消／多次点击：禁用按钮并保留原节点与已连接目录。
- 存在恢复事务：保留恢复入口，不被引导状态覆盖。

## Task 1: 有界查找目录

**Files:** `src/github-update-files.js`、新增 `src/github-update-directory.js`、`tests/github-update-directory.test.mjs`。

**Interfaces:** `connectInstallDirectory(selected, {manifest, readResource}) -> Promise<FileSystemDirectoryHandle>`；`inspectInstallDirectory(directory, {manifest}) -> Promise<object>`。

- [x] 写失败测试：直接连接、上级找到真实目录、同版本副本探针失败、仓库跳过／拒绝、深度／条目上限、访问拒绝不误报未找到。
- [x] 运行测试观察失败，再实现深度 3、最多 200 条目的 BFS；只对匹配候选写入并清理探针。
- [x] 单测通过，保留既有 bindInstallDirectory 行为。

## Task 2: 引导与记忆目录

**Files:** `update.html`、`update.css`、`src/github-updater-page.js`、`src/locales/{zh-CN,en}.js`、`tests/run-github-update-check.mjs`。

- [x] 浏览器先断言源码页隐藏连接／安装入口；GitHub 页有三步引导与当前扩展详情链接。
- [x] 实现安装方式分流、图示、连接按钮和上级目录查找；选择器复用旧目录 startIn。
- [x] 已连接时折叠引导，显示文件夹和权限状态，授权失效在更新点击时重新授权；加载时不弹权限窗口。
- [x] 浏览器验证选择上级、错误目录、旧句柄、持久化重开、扫描期间按钮身份与 pending、源码检查和恢复入口。

## Task 3: 验证与文档

**Files:** `docs/development/github-updates.md`、`开发日志.md`。

- [x] 执行 `npm test`、`npm run check`、`npm run build`、`npm run test:updater`。
- [x] 检查桌面／窄屏／中英文截图，记录原生选择器及生产安装未执行的边界。
- [x] 更新维护说明和开发日志；展示截图，不提交／推送／发布。

## Execution record

- Ruling: 沿用当前会话已修改的工作目录，不另建缺失前序修复的干净 worktree；用户批准的是本地连续改进。已有其他项目／文档改动保持不动。
- Ruling: 源码更新说明在本页展开，避免依赖尚未发布的远端文档锚点。
- Task 1: complete — 查找／文件模块测试通过，仓库保护与探针保留。
- Task 2: complete — Chromium 156.0.8078.4 回归通过；独立审查发现的失效目录提示及源码恢复入口两项 P2 已补回归并修复。
- Task 3: complete — 312 项单测、check、store build/verify、updater 浏览器回归通过；最终截图在 `.tmp/update-check-B4MbF5/`，源码截图在 `.tmp/update-check-b1H72f/`。实测核对 Chrome“加载来源”标签与可点击路径。原生选择器、首次授权弹框及生产物理目录更新未重新验收。
