# B站网页私有协议：WBI只用于正常查询签名；412、429及验证票据会停止请求，不换身份绕过。
# 只有固定API域可收到账号Cookie；字幕CDN请求一律不携带Cookie。
"""Read-only Bilibili account and subtitle protocol."""

import hashlib
import json
import re
import time
from http.cookies import SimpleCookie
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .schema import require

MIXIN = (46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
         27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13)
READ_ENDPOINTS = {"/x/web-interface/nav", "/x/v2/history/toview/web", "/x/player/wbi/v2", "/x/player/wbi/playurl",
                  "/x/web-interface/wbi/view"}


class BiliError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def sign_wbi(params, img_key, sub_key, timestamp=None):
    raw = img_key + sub_key
    require(len(raw) == 64 and raw.isalnum(), "invalid WBI keys")
    key = "".join(raw[i] for i in MIXIN)
    values = {**params, "wts": int(time.time() if timestamp is None else timestamp)}
    filtered = {k: re.sub(r"[!'()*]", "", str(v).lower() if type(v) is bool else str(v))
                for k, v in sorted(values.items())}
    query = urlencode(filtered, quote_via=quote)
    return {**filtered, "w_rid": hashlib.md5((query + key).encode()).hexdigest()}


def subtitle_url(value):
    require(isinstance(value, str), "invalid subtitle URL")
    value = "https:" + value if value.startswith("//") else value
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and bool(parsed.hostname)
            and (parsed.hostname == "hdslb.com" or parsed.hostname.endswith(".hdslb.com")),
            "subtitle host must be an HTTPS Bilibili media host")
    return value


def parse_cookie(value):
    require(isinstance(value, str) and "\r" not in value and "\n" not in value, "invalid local Cookie input")
    parsed = SimpleCookie()
    try:
        parsed.load(value)
    except Exception:
        raise ValueError("invalid local Cookie input") from None
    require("SESSDATA" in parsed, "local Cookie must contain SESSDATA")
    allowed = {"SESSDATA", "DedeUserID", "DedeUserID__ckMd5", "bili_jct", "buvid3", "buvid4", "b_nut", "b_lsid"}
    return "; ".join(f"{k}={v.value}" for k, v in parsed.items() if k in allowed)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BiliError("redirect_refused", "接口返回重定向，已停止；未转发登录态。")


class HttpTransport:
    """Only explicit read endpoints can receive credentials; media hosts never do."""
    def __init__(self, cookie=None, *, interval=0.7):
        self._cookie = parse_cookie(cookie) if cookie is not None else None
        self.interval = interval
        self._last_request = 0
        self._opener = build_opener(NoRedirect())

    def get_json(self, path, params=None, *, authenticated=True):
        if path.startswith("/") and not path.startswith("//"):
            require(path in READ_ENDPOINTS, "endpoint is outside the read-only allowlist")
            url = "https://api.bilibili.com" + path
            if params:
                url += "?" + urlencode(params, quote_via=quote)
        else:
            require(not authenticated, "credentials cannot be sent to subtitle hosts")
            url = subtitle_url(path)
        pause = self.interval - (time.monotonic() - self._last_request)
        if pause > 0:
            time.sleep(pause)
        headers = {"User-Agent": "Mozilla/5.0 BilibiliContent/0.1", "Referer": "https://www.bilibili.com/",
                   "Accept": "application/json"}
        if authenticated and self._cookie:
            headers["Cookie"] = self._cookie
        try:
            self._last_request = time.monotonic()
            with self._opener.open(Request(url, headers=headers), timeout=20) as response:
                data = response.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise BiliError("response_too_large", "接口返回超出本轮读取上限。")
            return json.loads(data)
        except HTTPError as exc:
            code = "rate_limited" if exc.code in (403, 412, 429) else "http_error"
            raise BiliError(code, f"B站接口 HTTP {exc.code}，已停止本轮请求。") from None
        except (URLError, TimeoutError, OSError):
            raise BiliError("network_error", "网络请求失败；原有队列和证据保留。") from None
        except (ValueError, UnicodeError):
            raise BiliError("invalid_response", "接口未返回有效 JSON。") from None


def api_data(response):
    if not isinstance(response, dict) or type(response.get("code")) is not int:
        raise BiliError("invalid_response", "接口结构变化，缺少业务状态码。")
    code = response["code"]
    if code == -101:
        raise BiliError("auth_required", "B站登录态已失效，请在本机重新登录。")
    if code in (-352, -412, -509):
        raise BiliError("rate_limited", "B站要求验证或限制请求，已停止本轮。")
    if code != 0:
        raise BiliError("api_error", f"B站返回业务错误 {code}。")
    if not isinstance(response.get("data"), dict):
        raise BiliError("invalid_response", "接口缺少 data 对象。")
    if response["data"].get("v_voucher"):
        raise BiliError("rate_limited", "B站要求人工验证，已停止本轮请求。")
    return response["data"]


class BiliClient:
    def __init__(self, transport):
        self.transport = transport
        self._nav = None

    def identity(self):
        self._nav = api_data(self.transport.get_json("/x/web-interface/nav"))
        if self._nav.get("isLogin") is not True:
            raise BiliError("auth_required", "B站账号未登录。")
        require(self._nav.get("mid") and isinstance(self._nav.get("uname"), str), "invalid account identity")
        return {"id": str(self._nav["mid"]), "name": self._nav["uname"]}

    def signed(self, params, *, allow_anonymous=False):
        if self._nav is None:
            if allow_anonymous:
                response = self.transport.get_json("/x/web-interface/nav")
                if isinstance(response, dict) and response.get("code") == -101 and isinstance(response.get("data"), dict):
                    self._nav = response["data"]
                else:
                    self._nav = api_data(response)
            else:
                self.identity()
        try:
            keys = self._nav["wbi_img"]
            img = urlsplit(keys["img_url"]).path.rsplit("/", 1)[-1].split(".")[0]
            sub = urlsplit(keys["sub_url"]).path.rsplit("/", 1)[-1].split(".")[0]
            return sign_wbi(params, img, sub)
        except (KeyError, TypeError, ValueError):
            raise BiliError("invalid_response", "无法取得有效 WBI 签名信息。") from None

    def watchlater_page(self, page, page_size):
        params = self.signed({"pn": page, "ps": page_size, "viewed": 0, "key": "", "asc": False,
                              "need_split": True, "web_location": "333.881"})
        result = api_data(self.transport.get_json("/x/v2/history/toview/web", params))
        if type(result.get("count")) is not int or result["count"] < 0 or not isinstance(result.get("list"), list):
            raise BiliError("invalid_response", "稍后再看分页结构变化。")
        return result

    def subtitles(self, bvid, cid):
        data = api_data(self.transport.get_json("/x/player/wbi/v2", self.signed({"bvid": bvid, "cid": cid})))
        section = data.get("subtitle")
        if not isinstance(section, dict) or not isinstance(section.get("subtitles"), list):
            raise BiliError("invalid_response", "字幕接口结构变化，不能当作没有字幕。")
        tracks = section["subtitles"]
        if not tracks:
            return {"status": "no_subtitle"}
        candidates = [t for t in tracks if isinstance(t, dict) and not t.get("is_lock") and t.get("subtitle_url")]
        if not candidates:
            return {"status": "subtitle_locked"}
        priority = {"zh-CN": 0, "zh-Hans": 1, "zh": 2, "ai-zh": 3, "zh-TW": 4, "zh-Hant": 5}
        track = min(candidates, key=lambda t: priority.get(t.get("lan"), 20))
        data = self.transport.get_json(subtitle_url(track["subtitle_url"]), authenticated=False)
        if not isinstance(data, dict) or not isinstance(data.get("body"), list):
            raise BiliError("invalid_response", "字幕正文缺少分段内容。")
        return {"status": "ready", "language": track.get("lan", "unknown"),
                "language_name": track.get("lan_doc", "未知语言"), "body": data["body"]}

    def playback(self, bvid, cid, quality=32):
        params = self.signed({"bvid": bvid, "cid": cid, "qn": quality, "fnval": 1, "fnver": 0,
                              "platform": "html5", "high_quality": 1}, allow_anonymous=True)
        return api_data(self.transport.get_json("/x/player/wbi/playurl", params))

    def video(self, bvid):
        """通过规范 BV 号读取完整分 P 元信息，不跟随用户提供的外部 URL。"""
        require(isinstance(bvid, str) and re.fullmatch(r"BV[A-Za-z0-9]{10}", bvid), "invalid BV id")
        return api_data(self.transport.get_json("/x/web-interface/wbi/view", self.signed({"bvid": bvid}, allow_anonymous=True)))
