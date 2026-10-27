"""独立内容引擎命令行；接口与脚本都不包含前端或模型供应方。"""

import argparse
import getpass
import json
import sys
from pathlib import Path

from .bilibili import BiliClient, BiliError, HttpTransport
from .credentials import login, read_session
from .library import Library
from .store import ContentStore


def main(argv=None, *, default_data=None):
    """运行 CLI；仓库入口显式指定私有数据目录，安装后的 CLI 默认使用当前 data/。"""
    directory = Path(default_data) if default_data else Path.cwd() / "data"
    parser = argparse.ArgumentParser(description="Bilibili read-only content engine")
    parser.add_argument("--db", default=str(directory / "content.sqlite3"))
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "login", "account-status", "sync-watchlater", "subtitles"):
        command = sub.add_parser(name)
        command.add_argument("--session-file", default=str(directory / "credentials" / "bilibili.json"))
        if name == "serve":
            command.add_argument("--port", type=int, default=8765)
            command.add_argument("--allow-origin", action="append", default=[])
        elif name == "sync-watchlater":
            command.add_argument("--page-size", type=int, default=20)
            command.add_argument("--max-pages", type=int, default=20)
        elif name == "subtitles":
            command.add_argument("--limit", type=int, default=5)
            command.add_argument("--force", action="store_true")
    sub.add_parser("queue")
    command = sub.add_parser("content")
    command.add_argument("work_id")
    command = sub.add_parser("capture")
    command.add_argument("file")
    args = parser.parse_args(argv)
    store = None
    try:
        if args.command == "serve":
            from .server import serve
            serve(args.db, args.port, session_path=args.session_file, allowed_origins=args.allow_origin)
            return 0
        if args.command == "login":
            result = login(getpass.getpass("仅在本机粘贴 B站 Cookie（不回显）："), args.session_file)
        else:
            store = ContentStore(args.db)
            library = Library(store)
            if args.command in ("sync-watchlater", "subtitles", "account-status"):
                client = BiliClient(HttpTransport(read_session(args.session_file)))
                if args.command == "account-status":
                    result = {"status": "connected", "account": client.identity()}
                elif args.command == "sync-watchlater":
                    result = library.sync(client, page_size=args.page_size, max_pages=args.max_pages)
                else:
                    result = library.collect_subtitles(client, limit=args.limit, force=args.force)
            elif args.command == "queue":
                result = library.queue()
            elif args.command == "content":
                result = store.get_work(args.work_id)
            else:
                path = Path(args.file)
                if path.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError("capture file exceeds 8 MiB")
                result = library.import_capture(json.loads(path.read_text(encoding="utf-8")))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2 if isinstance(result, dict) and result.get("status") in (
            "incomplete", "auth_required", "rate_limited", "invalid_response", "network_error") else 0
    except BiliError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": str(exc)}}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (ValueError, TypeError, KeyError, OSError):
        print(json.dumps({"error": {"code": "invalid_request", "message": "参数、文件或本机登录态不可用。"}}, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        if store:
            store.close()
