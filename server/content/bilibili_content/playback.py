# 本模块是HTTP取流，不是Chrome offscreen缓存。旧扩展的DASH下载与本地合成保持独立。
# 前端只持有短期本机令牌；源签名地址不落盘，拖动以单范围Range转发，并在每次请求重查CID和屏蔽。
"""Opaque, short-lived MP4 plans and bounded-memory byte-range forwarding."""

import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, build_opener

from .bilibili import BiliClient, BiliError, HttpTransport, NoRedirect
from .credentials import read_session
from .store import ContentStore
from .schema import nonempty, require


def check_media_url(value):
    require(isinstance(value, str), "media URL must be a string")
    parsed = urlsplit(value)
    allowed = ("bilivideo.com", "bilivideo.cn", "bilivideo.net")
    known_akamai = {"upos-hz-mirrorakam.akamaized.net"}
    require(parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and bool(parsed.hostname)
            and (parsed.hostname in known_akamai or
                 any(parsed.hostname == domain or parsed.hostname.endswith("." + domain) for domain in allowed)),
            "media URL must use an HTTPS Bilibili video host")
    return value


def check_range(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"bytes=(\d+-\d*|-\d+)", value):
        raise BiliError("invalid_range", "仅支持单段 bytes 范围。")
    start, end = value[6:].split("-", 1)
    if (not start and int(end) == 0) or (start and end and int(start) > int(end)):
        raise BiliError("invalid_range", "无效的媒体字节范围。")
    return value


class MediaTransport:
    def __init__(self):
        self._opener = build_opener(NoRedirect())

    def open(self, url, range_header=None, *, head=False):
        check_media_url(url)
        check_range(range_header)
        headers = {"User-Agent": "Mozilla/5.0 BilibiliContent/0.1", "Referer": "https://www.bilibili.com/"}
        if range_header:
            headers["Range"] = range_header
        # GET also supplies reliable representation headers for HEAD; the caller closes
        # immediately after forwarding headers, before reading the body. No Cookie here.
        try:
            response = self._opener.open(Request(url, headers=headers), timeout=20)
            if response.status not in (200, 206):
                response.close()
                raise BiliError("upstream_error", "媒体源返回了不可用的响应。")
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type not in ("video/mp4", "video/x-m4v", "application/mp4", "application/octet-stream"):
                response.close()
                raise BiliError("unsupported_media", "媒体源未返回 MP4 内容。")
            content_range = response.headers.get("Content-Range", "")
            if response.status == 206 and not re.fullmatch(r"bytes \d+-\d+/\d+", content_range):
                response.close()
                raise BiliError("upstream_error", "媒体源返回了无效的字节范围。")
            return response
        except HTTPError as exc:
            code = {403: "media_forbidden", 404: "media_unavailable", 410: "media_unavailable",
                    412: "rate_limited", 416: "invalid_range", 429: "rate_limited"}.get(exc.code, "upstream_error")
            raise BiliError(code, f"媒体源 HTTP {exc.code}。") from None
        except (URLError, TimeoutError, OSError):
            raise BiliError("network_error", "媒体连接失败，请稍后重新取得播放地址。") from None


class BiliResolver:
    def __init__(self, session_path):
        self.session_path = Path(session_path)

    def __call__(self, work, quality):
        source = next(s for s in work["sources"] if s["kind"] in ("watch_later", "video"))
        cookie = read_session(self.session_path) if self.session_path.exists() else None
        client = BiliClient(HttpTransport(cookie))
        if cookie is not None:
            # An expired saved session never silently degrades to an anonymous identity.
            client.identity()
        result = client.playback(source["bvid"], source["cid"], quality)
        return {**result, "access": "account" if cookie is not None else "anonymous"}


class Playback:
    def __init__(self, db_path, *, session_path="data/credentials/bilibili.json", resolver=None,
                 media=None, clock=time.time, ttl=600, max_plans=128):
        self.db_path = db_path
        self.resolver = resolver or BiliResolver(session_path)
        self.media = media or MediaTransport()
        self.clock = clock
        self.ttl = ttl
        self.max_plans = max_plans
        self._plans = {}
        self._lock = threading.RLock()

    def clear(self):
        """本地退出登录时撤销尚未使用的取流能力，不触发任何平台操作。"""
        with self._lock:
            self._plans.clear()

    def _work(self, work_id, expected=None):
        engine = ContentStore(self.db_path)
        try:
            work = engine.get_work(work_id)
            if not work["available"]:
                raise BiliError("media_unavailable", "这条视频当前不可访问。")
            if any(r.get("blocked") for r in engine._rules(work)):
                raise BiliError("blocked", "该作品或作者已被屏蔽。")
            source = next((s for s in work["sources"] if s["kind"] in ("watch_later", "video")), None)
            if not source or not source.get("bvid") or type(source.get("cid")) is not int:
                raise BiliError("missing_media_identity", "当前作品缺少可播放的分 P 信息。")
            if expected and (source["bvid"], source["cid"]) != expected:
                raise BiliError("media_changed", "作品的分 P 已变化，请重新取得播放地址。")
            return work, source
        finally:
            engine.close()

    def _resolved(self, work, quality):
        data = self.resolver(work, quality)
        require(isinstance(data, dict), "invalid playback response")
        streams = data.get("durl")
        if not isinstance(streams, list) or len(streams) != 1 or not isinstance(streams[0], dict):
            raise BiliError("unsupported_media", "基础播放器暂只支持单文件 MP4；此片需要独立音视频或分段处理。")
        stream = streams[0]
        try:
            url = check_media_url(stream.get("url"))
        except ValueError:
            raise BiliError("unsupported_media", "上游视频源不在当前支持的安全域名范围内。") from None
        if not str(data.get("format", "")).startswith("mp4"):
            raise BiliError("unsupported_media", "这条视频未返回基础播放器支持的 MP4 格式。")
        actual_quality = data.get("quality")
        require(type(actual_quality) is int and actual_quality > 0, "playback response has no actual quality")
        expiry = self.clock() + self.ttl
        deadline = parse_qs(urlsplit(url).query).get("deadline", [""])[0]
        if deadline.isdigit():
            expiry = min(expiry, int(deadline) - 10)
        if expiry <= self.clock():
            raise BiliError("playback_expired", "上游返回了已过期的播放地址。")
        return {"url": url, "quality": actual_quality, "expires": expiry, "access": data.get("access", "account")}

    def prepare(self, work_id, quality=32):
        nonempty(work_id, "work_id")
        require(type(quality) is int and quality in (16, 32, 64, 80), "quality must be 16, 32, 64 or 80")
        work, source = self._work(work_id)
        resolved = self._resolved(work, quality)
        self._work(work_id, (source["bvid"], source["cid"]))
        token = secrets.token_urlsafe(24)
        plan = {**resolved, "work_id": work_id, "bvid": source["bvid"], "cid": source["cid"],
                "requested_quality": quality, "refreshed": False}
        with self._lock:
            self._plans = {k: v for k, v in self._plans.items() if v["expires"] > self.clock()}
            while len(self._plans) >= self.max_plans:
                del self._plans[next(iter(self._plans))]
            self._plans[token] = plan
        return {"id": token, "work_id": work_id, "bvid": source["bvid"], "cid": source["cid"],
                "format": "mp4", "content_type": "video/mp4", "url": f"/v1/media/{token}",
                "quality": resolved["quality"], "requested_quality": quality, "access": resolved["access"],
                "duration_seconds": work["duration_seconds"],
                "expires_at": datetime.fromtimestamp(resolved["expires"], timezone.utc).isoformat()}

    def open(self, token, range_header=None, *, head=False):
        check_range(range_header)
        with self._lock:
            plan = self._plans.get(token)
            if not plan or plan["expires"] <= self.clock():
                self._plans.pop(token, None)
                raise BiliError("playback_expired", "播放地址已过期或服务已重启，请重新取得地址。")
            url = plan["url"]
        expected = (plan["bvid"], plan["cid"])
        work, _ = self._work(plan["work_id"], expected)
        try:
            return self.media.open(url, range_header, head=head)
        except BiliError as exc:
            if exc.code != "media_forbidden":
                raise
            with self._lock:
                if plan["refreshed"]:
                    raise
                plan["refreshed"] = True
            fresh = self._resolved(work, plan["requested_quality"])
            self._work(plan["work_id"], expected)
            if fresh["url"] == url:
                raise BiliError("media_forbidden", "媒体源拒绝访问，未反复重试。") from None
            with self._lock:
                # The old token's published lifetime does not silently extend.
                plan["url"] = fresh["url"]
            return self.media.open(fresh["url"], range_header, head=head)
