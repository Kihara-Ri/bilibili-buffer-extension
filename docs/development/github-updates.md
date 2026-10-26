# GitHub 更新维护说明

## 渠道及首次安装

`npm run build` 生成商店包 `dist/haineicunzhi-<version>.zip` 和 `dist/unpacked/`。关于页提供 GitHub 下载链接，但不含更新页、文件引擎或 GitHub 可选域名权限。商店仍通过审核更新。

`npm run build:github` 生成 `dist/github/unpacked/`、`haineicunzhi-github-<version>.zip` 与 `.update.json`。首次安装需手动解压并加载；以后通过扩展设置的更新入口操作。两种安装 ID 和存储独立，没有片库迁移功能。

## 首次配置签名

本仓库已固定正式公钥，后续构建需要与之匹配的私钥。首次配置新项目时，只有 publicKey 为 null 才运行 `update:key`；已有公钥时不要重新生成。初始化示例与正常构建命令如下：

```sh
npm run update:key -- /安全且有备份的目录/haineicunzhi-update.pem
UPDATE_SIGNING_KEY=/安全且有备份的目录/haineicunzhi-update.pem npm run build:github
```

初始化只写入公开 JWK，私钥以 0600 保存在指定位置且不输出。**勿将私钥放进仓库、扩展、Release 或临时目录，务必离线备份。** 已有公钥时初始化命令拒绝覆盖。构建验证私钥与仓库公钥匹配；普通热更新禁止变更公钥。轮换或遗失需重新发布手动安装版本。

GitHub Release 使用 `v<version>` 正式标签，同时附带上述 ZIP 和 update.json；不要只发布商店 ZIP。检查器只扫描最近 20 条发布，跳过草稿、预发布和没有匹配更新资产的版本。没有签名资产不承诺可热更新。

## 运行流程与边界

- 更新页通过随机 challenge 验证所选目录确实属于当前运行扩展；拒绝开发仓库目录，避免覆盖源代码。
- 文件下载前按需申请 GitHub 四个固定域名。浏览器扩展页发起请求，不携带站点 cookie。目录和恢复文件保留在本机独立 IndexedDB `haineicunzhi-updater-v1`。
- 固定公钥验证 ECDSA P-256 签名，再检查版本、大小、哈希、路径、资源引用、Chrome 版本、权限变化。验证过的 manifest 仅按固定规则保留原 key，并给 CDN 规则增加原 ID，之后按实际输出核对读回内容。
- 更新锁／暂停清单持久化于 storage.local；保存中的 Blob 下载阻止更新。offscreen 关闭异步操作闸门、暂停下载并等待合并完成。所有原文件备份落盘后才改文件，manifest 最后写。v1 不删除旧版额外文件，不改片库数据库。
- 多个更新页共享 Web Lock；写入、恢复、取消和健康提交互斥，防止另一页在写入中恢复造成混写。锁随上下文关闭释放，恢复快照独立持久化。
- runtime.reload 会关闭旧页面。新后台打开续接页，确认目标 manifest 版本和 offscreen 版本后才解锁、清理快照及续传。默认刷新 B 站视频页，让内容脚本使用新版本。
- 每次写入可能重新出现 Chrome 原生授权；开发者模式必须开启。未完成更新有恢复入口，需要重新允许目录写入。若新版本连更新页都无法运行，下载可信 ZIP 覆盖原目录并手动重新加载。
- 自动更新只用于向后兼容的数据格式。不得在健康检查之前进行不可逆迁移；签名发布者仍须测试缓存兼容性。权限扩大／入口变化／信任根轮换要求手动更新。

## 验证

```sh
npm run check
npm test
npm run test:popup
npm run build
npm run test:updater
node tests/run-github-updater.mjs --native
```

最后一项使用独立 Chrome profile、临时发布公钥、拦截的 Release 元数据和签名资产。按输出路径在原生选择器选择测试目录，再点检查、允许 GitHub 域名及更新。验证真实文件替换与 runtime.reload、安装 ID、storage.local 和 IndexedDB Blob 保留，结果在每轮独立的 `.tmp/updater-acceptance-*/verification.json`，最新目录见 `.tmp/github-updater-work/updater-latest.json`。不等同于生产 GitHub Release 或 Windows 验收。无 `--native` 的自动化仅覆盖真实页面／后台、发送方限制和签名构建，不宣称完成原生文件更新。
