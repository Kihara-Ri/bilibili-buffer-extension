#!/usr/bin/env python3
"""官网「扔一只漂流瓶」计数服务。

只做一件事：记录有多少人觉得海内存知好用（可附带一个预设标签），并把总数公开给官网。
设计约束（改动前先读 server/bottles/README.md）：
- 只用 Python 标准库（http.server + sqlite3），部署机器上不需要装任何依赖；
- 只监听 127.0.0.1，由 nginx 反代到 https://kihara.cn/haineicunzhi/api/，TLS 与限流都在 nginx；
- 不保存原始 IP：同一 IP 每天只能扔一只，判重用「IP + 当天日期」的 HMAC，密钥随机生成、只存在本库，
  两天后连哈希一起删除；nginx 对这个路径关闭了访问日志；
- 不用 Cookie，不收自由文本，只接受下面三个预设标签之一（或不带标签），不需要审核。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PATH = "/haineicunzhi/api/bottles"
TAGS = ("smooth", "offline", "quality")
MAX_BODY = 256
# 官网正式域名；本地预览（npm run site:preview）走 localhost / 127.0.0.1 的任意端口。
DEFAULT_ORIGINS = "https://haineicunzhi.kihara.cn"
LOCAL_HOSTS = {"localhost", "127.0.0.1"}


def utc_day(now: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if now is None else now, timezone.utc).strftime("%Y-%m-%d")


class Store:
    """SQLite 存储。所有写入在同一把锁里完成：访问量极小，串行最简单也不会丢计数。"""

    def __init__(self, path: str):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bottles (id INTEGER PRIMARY KEY, tag TEXT, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS throttle (digest TEXT PRIMARY KEY, day TEXT NOT NULL);
            """
        )
        row = self.db.execute("SELECT value FROM meta WHERE key = 'secret'").fetchone()
        if row is None:
            secret = secrets.token_hex(32)
            self.db.execute("INSERT INTO meta (key, value) VALUES ('secret', ?)", (secret,))
        else:
            secret = row[0]
        self.secret = bytes.fromhex(secret)

    def counts(self) -> dict:
        rows = self.db.execute("SELECT tag, COUNT(*) FROM bottles GROUP BY tag").fetchall()
        tags = {tag: 0 for tag in TAGS}
        total = 0
        for tag, count in rows:
            total += count
            if tag in tags:
                tags[tag] = count
        return {"total": total, "tags": tags}

    def throw(self, ip: str, tag: str | None, now: float | None = None) -> bool:
        """扔一只瓶子；同一 IP 当天已经扔过就返回 False（不计数，也不报错）。"""
        day = utc_day(now)
        digest = hmac.new(self.secret, f"{day}\n{ip}".encode(), hashlib.sha256).hexdigest()
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                # 过期的判重哈希随写入顺手清掉：只保留今天和昨天（跨时区的「当天」边界）。
                self.db.execute("DELETE FROM throttle WHERE day < ?", (utc_day((now or time.time()) - 86400),))
                if self.db.execute("SELECT 1 FROM throttle WHERE digest = ?", (digest,)).fetchone():
                    self.db.execute("COMMIT")
                    return False
                self.db.execute("INSERT INTO throttle (digest, day) VALUES (?, ?)", (digest, day))
                self.db.execute("INSERT INTO bottles (tag, created_at) VALUES (?, ?)", (tag, int(now or time.time())))
                self.db.execute("COMMIT")
                return True
            except Exception:
                self.db.execute("ROLLBACK")
                raise


def allowed_origin(origin: str, allowed: set[str]) -> bool:
    if origin in allowed:
        return True
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    return parts.scheme == "http" and parts.hostname in LOCAL_HOSTS and not parts.path


def make_handler(store: Store, allowed: set[str]):
    class Handler(BaseHTTPRequestHandler):
        server_version = "bottles"
        sys_version = ""

        def log_message(self, *args):  # 不写任何请求日志（含 IP）。
            pass

        def cors(self) -> bool:
            origin = self.headers.get("Origin", "")
            if origin and allowed_origin(origin, allowed):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                return True
            return False

        def reply(self, status: int, payload: dict | None = None, cache: str = "no-store"):
            body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
            self.send_response(status)
            self.cors()
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            if payload is not None:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if self.path != PATH:
                return self.reply(404, {"error": "not_found"})
            self.send_response(204)
            if self.cors():
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            if self.path != PATH:
                return self.reply(404, {"error": "not_found"})
            # 短缓存：计数不需要秒级准确，同一访客来回刷新不必每次都打到树莓派。
            self.reply(200, store.counts(), cache="public, max-age=15")

        def do_POST(self):
            if self.path != PATH:
                return self.reply(404, {"error": "not_found"})
            # 只有官网（或本地预览）能扔瓶子：别的网站嵌的脚本带着自己的 Origin，直接拒绝。
            if not allowed_origin(self.headers.get("Origin", ""), allowed):
                return self.reply(403, {"error": "origin"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = MAX_BODY + 1
            if length < 0 or length > MAX_BODY or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self.reply(400, {"error": "body"})
            try:
                data = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self.reply(400, {"error": "json"})
            tag = data.get("tag") if isinstance(data, dict) else None
            if tag is not None and tag not in TAGS:
                return self.reply(400, {"error": "tag"})
            # 部署时只监听 127.0.0.1，X-Real-IP 由 nginx 写入；直连调试时退回 socket 地址。
            ip = self.headers.get("X-Real-IP") or self.client_address[0]
            accepted = store.throw(ip, tag)
            self.reply(200, {"accepted": accepted, **store.counts()})

    return Handler


def main() -> int:
    port = int(os.environ.get("BOTTLES_PORT", "18710"))
    db_path = os.environ.get("BOTTLES_DB", "bottles.sqlite3")
    allowed = {item.strip() for item in os.environ.get("BOTTLES_ORIGINS", DEFAULT_ORIGINS).split(",") if item.strip()}
    store = Store(db_path)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store, allowed))
    # 测试用端口 0 让系统分配，这里把实际端口打出来供调用方读取。
    print(f"listening {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
