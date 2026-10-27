import tempfile
import unittest
from pathlib import Path

from helpers import entry, Transport
from bilibili_content import ContentStore
from bilibili_content.bilibili import BiliClient
from bilibili_content.library import Library
from bilibili_content.playback import Playback
from test_playback import Media, media_data


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "content.sqlite3"
        self.store = ContentStore(self.db)
        self.library = Library(self.store)
        self.transport = Transport()
        original = self.transport.get_json
        self.pages = [{"page": 1, "cid": 900, "duration": 40, "part": "原声"},
                      {"page": 2, "cid": 901, "duration": 80, "part": "译配"}]

        def request(path, params=None, **options):
            if path == "/x/web-interface/wbi/view":
                return {"code": 0, "data": entry(pages=self.pages)}
            return original(path, params, **options)
        self.transport.get_json = request

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_url_to_part_to_playback_does_not_add_a_watchlater_item(self):
        result = self.library.resolve_video(BiliClient(self.transport), "https://www.bilibili.com/video/BV1TUno6bEwA/?p=2")
        self.assertEqual(result["selected_id"], "BV1TUno6bEwA:p2")
        self.assertEqual(result["parts"][1]["cid"], 901)
        self.assertEqual(self.library.queue(), [])
        playback = Playback(self.db, resolver=lambda work, quality: media_data(), media=Media())
        self.assertEqual(playback.prepare(result["selected_id"])["cid"], 901)

    def test_untrusted_or_nonexistent_parts_do_not_persist_any_content(self):
        for url in ("https://evil.test/video/BV1TUno6bEwA", "https://www.bilibili.com/video/BV1TUno6bEwA/?p=3"):
            with self.assertRaises(ValueError):
                self.library.resolve_video(BiliClient(self.transport), url)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM works").fetchone()[0], 0)

    def test_resolving_a_queued_video_preserves_its_membership_and_subtitles(self):
        self.library.sync(BiliClient(Transport([[entry(pages=self.pages)]])))
        self.library.apply_subtitle("BV1TUno6bEwA:p2", 901, {"status": "ready", "language": "zh",
            "body": [{"from": 0, "to": 20, "content": "译配字幕"}]})
        self.library.resolve_video(BiliClient(self.transport), "https://www.bilibili.com/video/BV1TUno6bEwA/?p=2")
        queue = self.library.queue()
        self.assertEqual(len(queue), 2)
        self.assertEqual(queue[1]["subtitle_status"], "ready")
        self.assertEqual(self.store.get_work(queue[1]["id"])["evidence"][0]["text"], "[0–20s] 译配字幕")


if __name__ == "__main__":
    unittest.main()
