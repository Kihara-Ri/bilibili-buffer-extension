"""Read-only live API probe. Never confirms a login or reports viewing progress."""

import argparse
import json
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPCookieProcessor, HTTPBasicAuthHandler, HTTPPasswordMgrWithDefaultRealm, Request, build_opener


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--work-id")
    parser.add_argument("--url", help="解析一个 BV 号或视频 URL；不加入稍后再看")
    parser.add_argument("--qr", action="store_true", help="检查生成和未扫码状态；不扫描或确认")
    parser.add_argument("--output")
    parser.add_argument("--access-file", help="站点认证 JSON 文件，包含 username/password；不输出凭据")
    args = parser.parse_args()
    handlers = [HTTPCookieProcessor(CookieJar())]
    if args.access_file:
        access = json.loads(Path(args.access_file).read_text(encoding="utf-8"))
        passwords = HTTPPasswordMgrWithDefaultRealm()
        passwords.add_password(None, args.base.rstrip("/") + "/", access["username"], access["password"])
        handlers.append(HTTPBasicAuthHandler(passwords))
    opener = build_opener(*handlers)

    def call(path, payload=None, *, method=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        return opener.open(Request(args.base.rstrip("/") + path, data=body, method=method,
                                   headers={"Content-Type": "application/json", **(headers or {})}), timeout=60)

    result = {}
    try:
        with call("/v1/queue") as response:
            queue = json.load(response)
        result["queue_parts"] = len(queue)
        with call("/v1/login/status") as response:
            result["login_status"] = json.load(response)["status"]
        selected = None
        if args.url:
            with call("/v1/videos/resolve", {"url": args.url}) as response:
                resolved = json.load(response)
            selected = resolved["selected_id"]
            result["resolved_parts"] = len(resolved["parts"])
        identifier = args.work_id or selected or next(item["id"] for item in queue if item.get("cid") and item.get("duration_seconds"))
        with call("/v1/playback", {"work_id": identifier, "quality": 32}) as response:
            plan = json.load(response)
        result["playback"] = {k: plan[k] for k in ("work_id", "cid", "quality", "format", "access")}
        with call(plan["url"], headers={"Range": "bytes=0-65535"}) as response:
            prefix = response.read(65537)
            result["media"] = {"status": response.status, "content_type": response.headers.get("Content-Type"),
                               "content_range": response.headers.get("Content-Range"), "bytes": len(prefix),
                               "mp4_ftyp": prefix[4:8] == b"ftyp"}
        if result["media"]["status"] != 206 or not result["media"]["mp4_ftyp"] or len(prefix) != 65536:
            raise ValueError("range_or_mp4_check_failed")
        with call(plan["url"], method="HEAD", headers={"Range": "bytes=0-1"}) as response:
            result["head"] = {"status": response.status, "content_range": response.headers.get("Content-Range"),
                              "body_bytes": len(response.read())}
        if result["head"]["status"] != 206 or result["head"]["body_bytes"] != 0:
            raise ValueError("head_check_failed")
        if args.qr:
            with call("/v1/login/qr", {}) as response:
                attempt = json.load(response)
            result["qr_generate"] = attempt["status"]
            time.sleep(attempt["poll_after_seconds"] + 0.1)
            with call("/v1/login/qr/" + attempt["attempt_id"]) as response:
                result["qr_poll"] = json.load(response)["status"]
        result["status"] = "passed"
    except HTTPError as exc:
        payload = json.loads(exc.read())
        result.update(status="failed", error={"http_status": exc.code, "code": payload.get("error", {}).get("code", "unknown")})
    except (URLError, OSError, ValueError, StopIteration):
        result.update(status="failed", error={"code": "probe_failed"})
    # Signed URLs, login scan URLs, attempt IDs and cookies are deliberately absent.
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
