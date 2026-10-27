# rasp5remote 部署与回滚

2026-10-27 已部署，公共 API 地址 `https://bilibili.kihara.cn`。域名 DNS 已指向现有服务器，使用 Nginx、Let’s Encrypt 和 systemd，无容器或 Python 第三方运行时依赖。

- 代码：`/opt/bilibili-content/releases/20261027-initial`，`/opt/bilibili-content/current` 为发布软链。
- 服务：`bilibili-content.service`，自动启动；Python 仅监听 `127.0.0.1:18711`。
- 数据：`/var/lib/bilibili-content/`，数据库与 B 站登录态独立于发布目录；DynamicUser、目录 0700、UMask 0077。
- Nginx：`/etc/nginx/sites-available/bilibili.kihara.cn`，通过 sites-enabled 软链加载；Host 重写为回环地址，保留浏览器 Origin。只接受显式 HTTPS Origin。
- TLS：`/etc/letsencrypt/live/bilibili.kihara.cn/`，certbot.timer 自动续期；deploy 钩子 `bilibili-content-nginx` 在证书续期后验证并重载 Nginx。
- 独立站点认证：HTTP Basic，账号 kihara；强随机密码由服务器生成，仅落在私人配置文件 `~/.config/bilibili-content/access.json`（0600），Nginx 只保存 bcrypt 哈希。密码不属于 B 站账号，也不会被转发给 Python 或 B 站。

首次访问手机浏览器会要求站点账号密码；随后前端复用服务端的 B 站登录态。当前尚无前端或二维码控件，根路径显示服务 JSON。Claude Code 可直接在此域名同源接入 `/v1/*`，无需更改 API 路径。前端目录或静态站点路由应另行配置，媒体和 API 继续走此代理并保留认证。

验证命令：

```sh
ssh rasp5remote 'systemctl status bilibili-content.service --no-pager'
ssh rasp5remote 'curl -fsS http://127.0.0.1:18711/health'
# 公网未认证必须是 401，且不能跳过证书校验
curl -I https://bilibili.kihara.cn/health
# 凭据文件不打印到日志
python3 server/content/smoke.py --base https://bilibili.kihara.cn --url BV1TUno6bEwA --qr --access-file /private/path/access.json
```

已验证：本机与服务器各 57 项单元/接口测试；公网可信 TLS、认证拒绝、公共视频解析、真实 MP4 Range 206、HEAD、QR 生成与未扫码轮询。尚未验证：用户扫码确认后的登录保存、账号同步真实链路、iPhone 原生播放器、前端界面。公共视频测试得到匿名 quality=16，不能据此宣称账号高清可用。

后续发布只上传源码到新的 release 目录，在服务器运行测试后切换 current，再 `sudo systemctl restart bilibili-content`。保持数据目录、站点密码及证书独立。不能同步开发者本机 data/ 或 Cookie。正式启用域名前，先用 nginx-acme.conf 申请证书，再配置站点认证、启动服务并安装 nginx.conf；永远不要先暴露未经认证的账号接口。

回滚：如某次发布测试失败，current 指回上一版本并重启服务；不要删除数据或登录态。初次部署需要整体停用时，移除 `/etc/nginx/sites-enabled/bilibili.kihara.cn` 软链，`sudo nginx -t && sudo systemctl reload nginx`，再 `sudo systemctl disable --now bilibili-content`。证书、数据和凭据保留用于恢复；不影响其他站点。
