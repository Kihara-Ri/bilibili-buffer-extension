import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from helpers import BiliClient, Transport, entry
from bilibili_content import ContentStore
from bilibili_content.bilibili import BiliError
from bilibili_content.library import Library
from bilibili_content.playback import Playback, MediaTransport, check_media_url, check_range


def media_data(url="https://upos-sz-mirror.bilivideo.com/test.mp4?deadline=2000000000&upsig=SECRET"):
    return {"format": "mp4", "quality": 32, "timelength": 120000,
            "durl": [{"url": url, "size": 1200, "length": 120000}]}


class Response(io.BytesIO):
    status = 206
    headers = {"Content-Type": "video/mp4", "Content-Length": "2", "Content-Range": "bytes 0-1/1200", "Accept-Ranges": "bytes"}


class Media:
    def __init__(self):
        self.calls = []
        self.failure = None

    def open(self, url, range_header=None, *, head=False):
        self.calls.append((url, range_header, head))
        if self.failure:
            raise BiliError(self.failure, "upstream failure")
        return Response(b"\x00\x00")


class PlaybackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "db.sqlite3"
        self.engine = ContentStore(self.path)
        Library(self.engine).sync(BiliClient(Transport()))
        self.calls = []
        self.clock = 1000.0
        self.media = Media()

        def resolve(work, quality):
            self.calls.append((work["id"], quality))
            return {**media_data(), "access": "anonymous"}

        self.playback = Playback(self.path, resolver=resolve, media=self.media, clock=lambda: self.clock)

    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()

    def test_plan_hides_signed_urls_and_range_requests_open_the_bound_part(self):
        plan = self.playback.prepare("BV1TUno6bEwA", quality=32)
        self.assertNotIn("SECRET", str(plan))
        self.assertNotIn("bilivideo.com", str(plan))
        self.assertEqual(plan["cid"], 1230)
        self.assertEqual(plan["format"], "mp4")
        response = self.playback.open(plan["id"], range_header="bytes=0-1")
        self.assertEqual(response.status, 206)
        self.assertEqual(response.headers["Content-Range"], "bytes 0-1/1200")
        response.close()
        self.assertEqual(self.media.calls[0][1], "bytes=0-1")

    def test_blocking_or_replacing_a_cid_invalidates_issued_media_tokens(self):
        plan = self.playback.prepare("BV1TUno6bEwA")
        self.engine.set_rule("work", "BV1TUno6bEwA", blocked=True)
        with self.assertRaises(BiliError) as error:
            self.playback.open(plan["id"])
        self.assertEqual(error.exception.code, "blocked")
        self.assertEqual(self.media.calls, [])
        self.engine.set_rule("work", "BV1TUno6bEwA", blocked=False)
        changed = entry()
        changed["pages"][0]["cid"] = 5555
        Library(self.engine).sync(BiliClient(Transport([[changed]])))
        with self.assertRaises(BiliError) as error:
            self.playback.open(plan["id"])
        self.assertEqual(error.exception.code, "media_changed")

    def test_newly_unavailable_list_entry_cannot_use_old_media_token(self):
        plan = self.playback.prepare("BV1TUno6bEwA")
        removed = entry()
        removed.update(state=-100, pages=[], cid=0, duration=0)
        Library(self.engine).sync(BiliClient(Transport([[removed]])))
        with self.assertRaises(BiliError) as error:
            self.playback.open(plan["id"])
        self.assertEqual(error.exception.code, "media_unavailable")
        self.assertEqual(self.media.calls, [])

    def test_expiration_does_not_allow_infinite_old_token_reuse(self):
        plan = self.playback.prepare("BV1TUno6bEwA")
        self.clock += 10000
        with self.assertRaises(BiliError) as error:
            self.playback.open(plan["id"])
        self.assertEqual(error.exception.code, "playback_expired")
        self.assertEqual(len(self.calls), 1)

    def test_split_streams_do_not_masquerade_as_a_single_complete_mp4(self):
        self.playback.resolver = lambda work, quality: {"quality": 32, "format": "mp4", "durl": [media_data()["durl"][0]] * 2}
        with self.assertRaises(BiliError) as error:
            self.playback.prepare("BV1TUno6bEwA")
        self.assertEqual(error.exception.code, "unsupported_media")

    def test_untrusted_media_urls_and_multiple_ranges_are_rejected(self):
        for value in ("https://example.com/a.mp4", "https://bilivideo.com.evil.test/a", "http://upos.bilivideo.com/a",
                      "https://user:pw@upos.bilivideo.com/a", "https://upos.bilivideo.com:8000/a"):
            with self.assertRaises(ValueError):
                check_media_url(value)
        for value in ("bytes=0-1,10-20", "bytes=5-2", "bytes=-", "bytes=-0", "items=0-1", "bytes=0-1\r\nInjected: yes"):
            with self.assertRaises(BiliError):
                check_range(value)
        for value in ("bytes=0-1", "bytes=100-", "bytes=-100", None):
            self.assertEqual(check_range(value), value)

    def test_observed_bilibili_akamai_node_is_allowed_but_not_arbitrary_akamai_hosts(self):
        url = "https://upos-hz-mirrorakam.akamaized.net/upgcxcode/test.mp4?deadline=2000000000"
        self.assertEqual(check_media_url(url), url)
        for host in ("evil.akamaized.net", "upos-hz-mirrorakam.akamaized.net.evil.test"):
            with self.assertRaises(ValueError):
                check_media_url("https://" + host + "/test.mp4")

    def test_rate_limit_stops_without_link_rotation_or_retry(self):
        plan = self.playback.prepare("BV1TUno6bEwA")
        self.media.failure = "rate_limited"
        with self.assertRaises(BiliError):
            self.playback.open(plan["id"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.media.calls), 1)

    def test_html_error_pages_are_not_forwarded_as_same_origin_media(self):
        transport = MediaTransport()
        response = Response(b"<html>error</html>")
        response.headers = {"Content-Type": "text/html", "Content-Length": "18"}
        transport._opener = SimpleNamespace(open=lambda request, timeout: response)
        with self.assertRaises(BiliError) as error:
            transport.open(media_data()["durl"][0]["url"])
        self.assertEqual(error.exception.code, "unsupported_media")
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
