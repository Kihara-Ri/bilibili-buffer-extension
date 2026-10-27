import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from helpers import BiliClient, Transport
from bilibili_content import ContentStore
from bilibili_content.bilibili import BiliError
from bilibili_content.library import Library
from bilibili_content.playback import Playback
from bilibili_content.server import make_server
from test_playback import Media, media_data


class Login:
    def __init__(self):
        self.owner = None

    def start(self, owner):
        self.owner = owner
        return {"attempt_id": "TEST-ATTEMPT", "url": "https://passport.bilibili.com/scan", "expires_at": 2000,
                "poll_after_seconds": 2, "status": "waiting_scan"}

    def poll(self, attempt_id, owner):
        if owner != self.owner:
            raise KeyError("attempt")
        return {"attempt_id": attempt_id, "status": "waiting_confirmation"}

    def status(self):
        return {"status": "auth_required"}


class ApiTests(unittest.TestCase):
    origins = ["http://localhost:5173"]
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "db.sqlite3"
        engine = ContentStore(self.path)
        Library(engine).sync(BiliClient(Transport()))
        engine.close()
        playback = Playback(self.path, resolver=lambda w, q: media_data(), media=Media())
        self.server = make_server(self.path, port=0, playback=playback, login_service=Login(),
                                  allowed_origins=self.origins)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = None

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(2)
        self.server.server_close()
        self.tmp.cleanup()

    def call(self, method, path, value=None, headers=None, *, use_cookie=True):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if self.cookie and use_cookie:
            request_headers["Cookie"] = self.cookie
        conn.request(method, path, json.dumps(value) if value is not None else None, request_headers)
        response = conn.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        if response.getheader("Set-Cookie"):
            self.cookie = response.getheader("Set-Cookie").split(";", 1)[0]
        conn.close()
        return result

    def test_detail_login_and_owner_bound_polling(self):
        status, _, raw = self.call("GET", "/v1/queue/BV1TUno6bEwA")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["cid"], 1230)
        self.assertEqual(json.loads(self.call("GET", "/v1/login/status")[2])["status"], "auth_required")
        status, headers, raw = self.call("POST", "/v1/login/qr", {})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertEqual(json.loads(raw)["status"], "waiting_scan")
        self.assertEqual(self.call("GET", "/v1/login/qr/TEST-ATTEMPT")[0], 200)
        self.assertEqual(self.call("GET", "/v1/login/qr/TEST-ATTEMPT", use_cookie=False)[0], 404)

    def test_real_http_range_and_head_preserve_media_headers_without_credentials(self):
        status, _, raw = self.call("POST", "/v1/playback", {"work_id": "BV1TUno6bEwA"})
        self.assertEqual(status, 200)
        plan = json.loads(raw)
        self.assertNotIn("SECRET", str(plan))
        status, headers, body = self.call("GET", plan["url"], headers={"Range": "bytes=0-1"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 0-1/1200")
        self.assertEqual(body, b"\x00\x00")
        status, headers, body = self.call("HEAD", plan["url"], headers={"Range": "bytes=0-1"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Length"], "2")
        self.assertEqual(body, b"")
        status, _, raw = self.call("GET", plan["url"], headers={"Range": "bytes=0-1,5-6"})
        self.assertEqual(status, 416)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_range")

    def test_explicit_local_dev_cors_and_structured_errors(self):
        status, headers, _ = self.call("OPTIONS", "/v1/playback", headers={"Origin": "http://localhost:5173",
                                            "Access-Control-Request-Method": "POST"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")
        status, _, raw = self.call("GET", "/v1/queue", headers={"Origin": "https://evil.test"})
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(raw)["error"]["code"], "origin_forbidden")
        status, _, raw = self.call("POST", "/v1/playback", {"work_id": "missing"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw)["error"]["code"], "not_found")


class PublicOriginTests(ApiTests):
    origins = ["http://localhost:5173", "https://bilibili.kihara.cn"]

    def test_https_origin_accepts_same_site_post_and_sets_secure_cookie(self):
        status, headers, raw = self.call("POST", "/v1/login/qr", {}, headers={"Origin": "https://bilibili.kihara.cn"})
        self.assertEqual(status, 200)
        self.assertIn("Secure", headers["Set-Cookie"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://bilibili.kihara.cn")
        self.assertEqual(self.call("POST", "/v1/login/qr", {}, headers={"Origin": "https://bilibili.kihara.cn.evil.test"})[0], 403)
        self.assertEqual(self.call("GET", "/health", headers={"Host": "bilibili.kihara.cn"})[0], 403)

    def test_insecure_public_origin_is_rejected_at_startup(self):
        with self.assertRaises(ValueError):
            make_server(self.path, port=0, allowed_origins=["http://bilibili.kihara.cn"])


if __name__ == "__main__":
    unittest.main()
