import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from helpers import BiliClient, BiliError, Transport, entry
from bilibili_content import ContentStore
from bilibili_content.bilibili import HttpTransport, subtitle_url, sign_wbi
from bilibili_content.credentials import login, read_session
from bilibili_content.library import Library

class BilibiliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = ContentStore(Path(self.tmp.name) / "library.sqlite3")
        self.library = Library(self.engine)

    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()

    def test_signed_parameters_are_canonical_and_do_not_change_input(self):
        # Reference vector from the community protocol documentation, independent of this implementation.
        params = {"foo": "114", "bar": "514", "zab": "1919810"}
        signed = sign_wbi(params, "7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45", 1702204169)
        self.assertEqual(signed["w_rid"], "8f6f2b5b3d485fe1886cec6a0be8c5d4")
        self.assertNotIn("wts", params)

    def test_paginated_sync_deduplicates_and_preserves_queue_without_liking(self):
        t = Transport([[entry()], [entry("BV16TH36XEQz", 456)]])
        result = self.library.sync(BiliClient(t), page_size=1, max_pages=4)
        self.assertEqual(result["status"], "complete")
        self.assertEqual([x["id"] for x in self.library.queue()], ["BV1TUno6bEwA", "BV16TH36XEQz"])
        self.assertEqual([c for c in t.calls if "heartbeat" in c[0]], [])
        self.assertEqual(self.library.queue()[0]["subtitle_status"], "not_fetched")

    def test_page_failure_never_erases_existing_membership(self):
        self.library.sync(BiliClient(Transport()), page_size=1)
        result = self.library.sync(BiliClient(Transport([[entry("BV16TH36XEQz", 456)], [entry()]], fail_page=2)), page_size=1)
        self.assertEqual(result["status"], "rate_limited")
        self.assertEqual([x["id"] for x in self.library.queue()], ["BV1TUno6bEwA"])

    def test_repeated_or_overlapping_pages_stop_with_incomplete_status(self):
        t = Transport([[entry()], [entry()]])
        result = self.library.sync(BiliClient(t), page_size=1, max_pages=3)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(self.library.queue(), [])
        self.assertLessEqual(len(t.calls), 3)

    def test_multipart_uses_each_cid_and_does_not_call_part_one_full_video(self):
        pages = [{"page": 1, "cid": 900, "part": "上集", "duration": 40},
                 {"page": 2, "cid": 901, "part": "下集", "duration": 80}]
        self.library.sync(BiliClient(Transport([[entry(pages=pages)]])))
        queue = self.library.queue()
        self.assertEqual([x["id"] for x in queue], ["BV1TUno6bEwA:p1", "BV1TUno6bEwA:p2"])
        self.assertEqual([self.engine.get_work(x["id"])["duration_seconds"] for x in queue], [40, 80])
        self.assertEqual(queue[1]["cid"], 901)

    def test_subtitle_acquisition_preserves_segment_anchors_without_tokens(self):
        t = Transport()
        self.library.sync(BiliClient(t))
        result = self.library.collect_subtitles(BiliClient(t), limit=5)
        self.assertEqual(result[0]["status"], "ready")
        evidence = self.engine.get_work("BV1TUno6bEwA")["evidence"]
        self.assertEqual(evidence[0]["kind"], "transcript")
        self.assertEqual(evidence[0]["coverage"], "full")
        self.assertEqual(evidence[0]["start"], 0)
        self.assertEqual(evidence[2]["start"], 15)
        self.assertEqual(evidence[2]["coverage"], "excerpt")
        self.assertNotIn("PRIVATE", str(self.engine.get_work("BV1TUno6bEwA")))
        self.assertFalse(next(c[2] for c in t.calls if c[0].startswith("https://")))
        self.assertEqual([c for c in t.calls if "heartbeat" in c[0]], [])

    def test_missing_subtitles_remain_visible_without_fabricated_text(self):
        t = Transport()
        t.player = {"subtitle": {"subtitles": []}}
        self.library.sync(BiliClient(t))
        self.assertEqual(self.library.collect_subtitles(BiliClient(t))[0]["status"], "no_subtitle")
        self.assertEqual(len(self.library.queue()), 1)
        self.assertEqual(self.engine.get_work("BV1TUno6bEwA")["evidence"], [])

    def test_locked_subtitles_do_not_trigger_cdn_requests(self):
        t = Transport()
        t.player["subtitle"]["subtitles"][0]["is_lock"] = True
        self.library.sync(BiliClient(t))
        self.assertEqual(self.library.collect_subtitles(BiliClient(t))[0]["status"], "subtitle_locked")
        self.assertFalse(any(c[0].startswith("https://") for c in t.calls))

    def test_list_refresh_keeps_collected_evidence_and_review_revision(self):
        t = Transport()
        self.library.sync(BiliClient(t))
        self.library.collect_subtitles(BiliClient(t))
        original = self.engine.get_work("BV1TUno6bEwA")
        self.library.sync(BiliClient(t))
        self.assertEqual(self.engine.get_work("BV1TUno6bEwA"), original)

    def test_unavailable_entries_remain_in_raw_library(self):
        item = entry()
        item.update(state=-100, duration=0, pages=[], cid=0)
        self.library.sync(BiliClient(Transport([[item]])))
        queue = self.library.queue()
        self.assertEqual(queue[0]["status"], "unavailable")
        self.assertEqual(queue[0]["title"], "测试：几何推导")

    def test_expired_login_is_distinct_from_empty_watchlater(self):
        class Expired(Transport):
            def get_json(self, path, params=None, **kwargs):
                return {"code": -101, "message": "账号未登录"}
        result = self.library.sync(BiliClient(Expired()))
        self.assertEqual(result["status"], "auth_required")
        self.assertEqual(self.library.queue(), [])

    def test_capture_rejects_credentials_and_wrong_part_without_persisting_them(self):
        with self.assertRaises(ValueError):
            self.library.import_capture({"type": "watchlater", "cookie": "PRIVATE"})
        self.library.sync(BiliClient(Transport()))
        with self.assertRaises(ValueError):
            self.library.import_capture({"type": "subtitle", "work_id": "BV1TUno6bEwA", "cid": 999,
                                         "language": "ai-zh", "body": [{"from": 0, "to": 10, "content": "错误分P"}]})

    def test_transport_refuses_write_endpoints_and_foreign_subtitle_hosts(self):
        transport = HttpTransport("SESSDATA=TEST_ONLY", interval=0)
        for path in ("/x/v2/history/toview/add", "/x/click-interface/web/heartbeat"):
            with self.assertRaises(ValueError):
                transport.get_json(path)
        for url in ("https://example.com/file.json", "https://aisubtitle.hdslb.com.evil.test/f.json",
                    "http://aisubtitle.hdslb.com/f.json", "https://user:pw@aisubtitle.hdslb.com/f.json"):
            with self.assertRaises(ValueError):
                subtitle_url(url)
        with self.assertRaises(ValueError):
            transport.get_json("https://aisubtitle.hdslb.com/file.json", authenticated=True)

    def test_manual_chinese_track_is_preferred_to_ai_or_english(self):
        t = Transport()
        track = t.player["subtitle"]["subtitles"][0]
        t.player["subtitle"]["subtitles"] = [track, {**track, "lan": "en"}, {**track, "lan": "zh"}]
        self.assertEqual(BiliClient(t).subtitles("BV1TUno6bEwA", 1230)["language"], "zh")

    def test_uploaded_subtitle_language_does_not_prove_human_authorship(self):
        t = Transport()
        t.player["subtitle"]["subtitles"][0]["lan"] = "zh"
        self.library.sync(BiliClient(t))
        self.library.collect_subtitles(BiliClient(t))
        self.assertIsNone(self.engine.get_work("BV1TUno6bEwA")["evidence"][0]["machine_generated"])

    def test_explicit_local_login_keeps_secret_out_of_results_and_task_exports(self):
        path = Path(self.tmp.name) / "credentials" / "bilibili.json"
        with patch("bilibili_content.credentials.HttpTransport", return_value=Transport()):
            result = login("SESSDATA=TEST_ONLY; irrelevant_cookie=DROP", path)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(read_session(path), "SESSDATA=TEST_ONLY")
        self.assertNotIn("TEST_ONLY", str(result))
        self.library.sync(BiliClient(Transport()))
        self.assertNotIn("TEST_ONLY", str(self.engine.get_work("BV1TUno6bEwA")))

    def test_credential_permissions_and_symlinks_are_rejected(self):
        path = Path(self.tmp.name) / "session.json"
        path.write_text('{"cookie":"SESSDATA=TEST_ONLY"}')
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            read_session(path)
        path.chmod(0o600)
        link = Path(self.tmp.name) / "link.json"
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            read_session(link)

    def test_subtitle_malformed_response_does_not_become_no_subtitle(self):
        t = Transport()
        t.player = {}
        self.library.sync(BiliClient(t))
        result = self.library.collect_subtitles(BiliClient(t))
        self.assertEqual(result[0]["status"], "invalid_response")
        self.assertEqual(len(self.library.queue()), 1)

    def test_verification_challenge_stops_all_further_subtitle_requests(self):
        t = Transport([[entry(), entry("BV16TH36XEQz", 456)]])
        t.player = {"v_voucher": "VERIFY_REQUIRED"}
        self.library.sync(BiliClient(t))
        results = self.library.collect_subtitles(BiliClient(t))
        self.assertEqual([r["status"] for r in results], ["rate_limited"])
        self.assertEqual(sum(c[0] == "/x/player/wbi/v2" for c in t.calls), 1)

    def test_invalid_complete_snapshot_does_not_commit_orphan_works(self):
        bad = entry("BV16TH36XEQz", 456)
        bad["title"] = ""
        result = self.library.sync(BiliClient(Transport([[entry(), bad]])))
        self.assertEqual(result["status"], "invalid_response")
        self.assertEqual(self.engine.db.execute("SELECT COUNT(*) FROM works").fetchone()[0], 0)
        self.assertEqual(self.library.queue(), [])


if __name__ == "__main__":
    unittest.main()
