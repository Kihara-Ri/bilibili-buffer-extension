"""本机内容获取 API；不提供 UI、控件、发现排序或模型调用。"""

import json
import secrets
import sys
from pathlib import Path
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from .store import ContentStore
from . import __version__
from .schema import encoded, require
from .bilibili import BiliError, BiliClient, HttpTransport
from .credentials import read_session
from .playback import Playback

MAX_BODY = 2 * 1024 * 1024

ERROR_STATUSES = {"auth_required": 401, "blocked": 403, "media_forbidden": 403,
                  "origin_forbidden": 403, "rate_limited": 429, "poll_too_fast": 429,
                  "poll_too_soon": 429, "too_many_attempts": 429, "attempt_not_found": 404,
                  "invalid_owner": 400, "credential_error": 409,
                  "invalid_range": 416, "unsupported_media": 422, "missing_media_identity": 422,
                  "media_changed": 409, "playback_expired": 410, "media_unavailable": 404}


def dispatch(store, method, path, payload, *, playback=None, login_service=None, owner="", session_path=None):
    from .library import Library
    library = Library(store)
    if method == "GET":
        if path in ("/", "/health"):
            return {"status": "ok", "version": __version__, "service": "bilibili-content-engine"}
        if path == "/v1/queue":
            return library.queue()
        if path == "/v1/account-status":
            return library.status()
        if path.startswith("/v1/queue/"):
            work_id = unquote(path[len("/v1/queue/"):])
            item = next((value for value in library.queue() if value["id"] == work_id), None)
            if item is None:
                raise KeyError(work_id)
            return item
        if path.startswith("/v1/content/"):
            return store.get_work(unquote(path[len("/v1/content/"):]))
        if path == "/v1/login/status":
            return login_service.status()
        if path.startswith("/v1/login/qr/"):
            return login_service.poll(unquote(path[len("/v1/login/qr/"):]), owner)
    if method == "POST":
        require(isinstance(payload, dict), "JSON body must be an object")
        if path == "/v1/captures":
            return library.import_capture(payload)
        if path == "/v1/videos/resolve":
            require(set(payload) == {"url"}, "url required")
            cookie = read_session(session_path) if Path(session_path).exists() else None
            return library.resolve_video(BiliClient(HttpTransport(cookie)), payload["url"])
        if path.startswith("/v1/content/") and path.endswith("/subtitles"):
            require(not payload, "subtitle request takes an empty object")
            try:
                cookie = read_session(session_path)
            except (OSError, ValueError):
                raise BiliError("auth_required", "后台尚未登录，请先完成登录。") from None
            work_id = unquote(path[len("/v1/content/"):-len("/subtitles")])
            return library.collect_subtitle(BiliClient(HttpTransport(cookie)), work_id)
        if path == "/v1/playback":
            require(set(payload) <= {"work_id", "quality"} and "work_id" in payload, "work_id required; quality optional")
            return playback.prepare(**payload)
        if path == "/v1/login/qr":
            require(not payload, "QR login start takes an empty JSON object")
            return login_service.start(owner)
        if path == "/v1/login/logout":
            require(not payload, "logout takes an empty JSON object")
            result = login_service.logout()
            playback.clear()
            return result
        if path == "/v1/rules":
            require(set(payload) == {"scope", "target", "blocked"}, "scope, target and blocked required")
            return store.set_rule(**payload)
        if path in ("/v1/watchlater/sync", "/v1/subtitles/collect"):
            try:
                cookie = read_session(session_path)
            except (OSError, ValueError):
                raise BiliError("auth_required", "后台尚未登录，请先完成登录。") from None
            client = BiliClient(HttpTransport(cookie))
            if path.endswith("/sync"):
                require(set(payload) <= {"page_size", "max_pages"}, "unknown sync parameters")
                result = library.sync(client, **payload)
                if result["status"] != "complete":
                    raise BiliError(result["status"], result.get("reason", "列表同步未完成，原队列保留。"))
                return result
            require(set(payload) <= {"limit", "force"}, "unknown subtitle parameters")
            require("force" not in payload or type(payload["force"]) is bool, "force must be boolean")
            return {"results": library.collect_subtitles(client, **payload)}
    raise KeyError("endpoint not found")


def make_server(db_path, port=8765, *, session_path="data/credentials/bilibili.json", playback=None,
                login_service=None, allowed_origins=()):
    # Initialize once, before accepting requests.
    engine = ContentStore(db_path)
    engine.close()
    playback = playback or Playback(db_path, session_path=session_path)
    if login_service is None:
        from .qrlogin import QrLogin
        login_service = QrLogin(session_path)
    origins = set()
    for origin in allowed_origins:
        parsed = urlsplit(origin)
        require(parsed.hostname and "*" not in parsed.netloc
                and (parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")))
                and not parsed.username and not parsed.password and parsed.path in ("", "/")
                and not parsed.query and not parsed.fragment, "allow-origin must be an explicit HTTPS origin or local development origin")
        origins.add(origin.rstrip("/"))

    # TLS 在反向代理终止；公开 Origin 必须显式配置，Host 仍只接受回环地址。
    secure_cookie = any(value.startswith("https://") for value in origins)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Opaque media/login attempt IDs are capabilities, not useful access-log text.
            if self.path.startswith(("/v1/media/", "/v1/login/qr/")):
                return
            print(f"bilibili-content: {fmt % args}", file=sys.stderr)

        def respond(self, status, value, *, html=False):
            body = value.encode() if html else encoded(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8" if html else "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.cors_headers()
            if getattr(self, "new_owner", None):
                self.send_header("Set-Cookie", f"bd_client={self.new_owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=600" + ("; Secure" if secure_cookie else ""))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def cors_headers(self):
            origin = self.headers.get("Origin")
            if origin and origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length")
                self.send_header("Vary", "Origin")

        def fail(self, code, message, status=400):
            return self.respond(status, {"error": {"code": code, "message": message,
                                 "retryable": code in ("network_error", "playback_expired", "upstream_error")}})

        def owner(self, create=False):
            jar = SimpleCookie()
            try:
                jar.load(self.headers.get("Cookie", ""))
                current = jar.get("bd_client")
                if current and len(current.value) <= 128:
                    return current.value
            except Exception:
                pass
            if create:
                self.new_owner = secrets.token_urlsafe(24)
                return self.new_owner
            return ""

        def media_response(self, token):
            upstream = playback.open(token, self.headers.get("Range"), head=self.command == "HEAD")
            try:
                self.send_response(upstream.status)
                # Never forward cookies, redirects or upstream server identifiers.
                self.send_header("Content-Type", "video/mp4")
                for key in ("Content-Length", "Content-Range", "Accept-Ranges"):
                    if upstream.headers.get(key):
                        self.send_header(key, upstream.headers[key])
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.cors_headers()
                self.end_headers()
                if self.command != "HEAD":
                    while chunk := upstream.read(128 * 1024):
                        self.wfile.write(chunk)
            except (OSError, TimeoutError):
                # Headers may already be sent; a stream failure cannot turn into a second
                # JSON HTTP response. The client obtains a new plan and restores its time.
                self.close_connection = True
            finally:
                upstream.close()

        def handle_request(self):
            allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if self.headers.get("Host") not in allowed_hosts:
                return self.fail("host_forbidden", "loopback Host required", 403)
            origin = self.headers.get("Origin")
            if origin and origin not in ({f"http://{h}" for h in allowed_hosts} | origins):
                return self.fail("origin_forbidden", "cross-origin requests disabled", 403)
            if self.command == "OPTIONS":
                self.send_response(204)
                self.cors_headers()
                self.send_header("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            engine = None
            try:
                payload = None
                path = urlsplit(self.path).path
                if self.command in ("GET", "HEAD") and path.startswith("/v1/media/"):
                    return self.media_response(unquote(path[len("/v1/media/"):]))
                if self.command == "POST":
                    require(not self.headers.get("Transfer-Encoding"), "chunked requests unsupported")
                    length = int(self.headers.get("Content-Length", "0"))
                    require(0 < length <= MAX_BODY, "JSON body must be 1 byte to 2 MiB")
                    self.connection.settimeout(15)
                    raw = self.rfile.read(length)
                    require(self.headers.get_content_type() == "application/json", "application/json required")
                    payload = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
                engine = ContentStore(db_path)
                owner = self.owner(create=self.command == "POST" and path == "/v1/login/qr")
                result = dispatch(engine, "GET" if self.command == "HEAD" else self.command, path, payload,
                                  playback=playback, login_service=login_service, owner=owner, session_path=session_path)
                self.respond(200, result)
            except KeyError:
                self.fail("not_found", "not found", 404)
            except BiliError as exc:
                self.fail(exc.code, str(exc), ERROR_STATUSES.get(exc.code, 502))
            except (ValueError, TypeError, UnicodeError) as exc:
                self.fail("invalid_request", str(exc))
            except Exception:
                self.fail("internal_error", "internal error; check local server", 500)
            finally:
                if engine:
                    engine.close()

        do_GET = handle_request
        do_POST = handle_request
        do_HEAD = handle_request
        do_OPTIONS = handle_request

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(db_path, port=8765, *, session_path="data/credentials/bilibili.json", allowed_origins=()):
    server = make_server(db_path, port, session_path=session_path, allowed_origins=allowed_origins)
    print(f"Engine API: http://127.0.0.1:{server.server_port}", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
