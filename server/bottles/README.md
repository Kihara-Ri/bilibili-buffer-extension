# 漂流瓶计数服务

官网「扔一只漂流瓶」一节背后的小服务：记录有多少人觉得海内存知好用，可附带一个预设标签。
扩展本身从不访问它；只有官网 `haineicunzhi.kihara.cn` 会请求。

| 文件 | 去处 |
| --- | --- |
| `bottles.py` | `/opt/haineicunzhi-bottles/bottles.py`（只用 Python 标准库） |
| `haineicunzhi-bottles.service` | `/etc/systemd/system/` |
| `nginx-limit.conf` | `/etc/nginx/conf.d/haineicunzhi-bottles.conf`（`http` 级的限流区） |
| `nginx-location.conf` | 插入 `kihara.cn` 的 443 server 块，放在 `location /` 之前 |

## 接口

`/haineicunzhi/api/bottles`，经 `https://kihara.cn` 的 nginx 反代到 `127.0.0.1:18710`。

- `GET` → `{"total": 42, "tags": {"smooth": 20, "offline": 9, "quality": 1}}`，`Cache-Control: public, max-age=15`。
- `POST`，`Content-Type: application/json`，正文 `{}` 或 `{"tag": "offline"}`（≤ 256 字节）→ `{"accepted": true, ...计数}`。
  同一 IP 当天第二次返回 `accepted: false`，不计数也不报错。
- `POST` 只接受 `Origin` 为官网或 `http://localhost` / `http://127.0.0.1`（本地预览任意端口），否则 403；其他标签或非 JSON 返回 400。
- 跨域头只回给上述来源；`BOTTLES_ORIGINS`（逗号分隔）可覆盖正式来源。

## 隐私约束（改动前必读）

- 不存原始 IP：判重用 `HMAC(密钥, 日期 + IP)`，密钥首次启动随机生成并只存在库里，摘要两天后删除。
- 不写日志：服务自身不打印请求；nginx 对这个路径 `access_log off`。
- 不收自由文本，不用 Cookie。这些承诺写在 `privacy.html` 第 9 节，改行为必须同步改那里。

## 部署（树莓派 rasp5remote）

```bash
sudo install -D -m 644 bottles.py /opt/haineicunzhi-bottles/bottles.py
sudo install -m 644 haineicunzhi-bottles.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now haineicunzhi-bottles
sudo install -m 644 nginx-limit.conf /etc/nginx/conf.d/haineicunzhi-bottles.conf
# 手动把 nginx-location.conf 的内容插到 kihara.cn 443 块的 `location /` 之前（先备份）
sudo nginx -t && sudo systemctl reload nginx
curl -s https://kihara.cn/haineicunzhi/api/bottles
```

数据在 `/var/lib/haineicunzhi-bottles/bottles.sqlite3`（systemd `StateDirectory`）。更新代码只需重新 `install` `bottles.py` 并 `systemctl restart haineicunzhi-bottles`。

## 测试

`node --test tests/bottles-server.test.mjs`（已纳入 `npm test`，没有 `python3` 时跳过）在临时目录起一个服务，检查计数、判重、来源与输入校验。
