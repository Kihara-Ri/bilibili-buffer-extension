"""本机登录凭证存储；Cookie 不进入内容结果、模型或接口返回。"""

import json
import os
import stat
from pathlib import Path

from .bilibili import BiliClient, HttpTransport, parse_cookie
from .schema import require


def read_session(path):
    path = Path(path)
    require(not path.is_symlink() and path.is_file(), "本机登录文件不存在或不可用，请运行 login。")
    require(stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, "登录文件权限过宽；请在本机设为 600。")
    require(path.stat().st_size <= 65536, "登录文件过大。")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return parse_cookie(data["cookie"])
    except (ValueError, KeyError, TypeError):
        raise ValueError("本机登录文件格式无效，请重新登录。") from None


def login(cookie, path):
    cookie = parse_cookie(cookie)
    identity = BiliClient(HttpTransport(cookie)).identity()
    path = Path(path)
    require(not path.parent.is_symlink() and not path.is_symlink(), "登录文件不能使用符号链接。")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(stat.S_IMODE(path.parent.stat().st_mode) & 0o077 == 0,
            "请使用权限为 700 的独立登录目录，避免更改已有目录权限。")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump({"version": 1, "account": identity, "cookie": cookie}, stream, ensure_ascii=False)
    return {"account": identity, "session_file": str(path), "status": "connected",
            "storage": "本地明文文件，目录 700 / 文件 600；不进入模型请求。"}
