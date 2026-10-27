"""隔离外部 HTTP 的平台边界样本，不含真实账号或缓存。"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import copy
from bilibili_content.bilibili import BiliClient, BiliError

def entry(bvid="BV1TUno6bEwA", aid=123, pages=None):
    return {"aid": aid, "bvid": bvid, "title": "测试：几何推导", "state": 0, "duration": 120,
            "cid": aid * 10, "owner": {"mid": 7, "name": "测试作者"}, "add_at": 1700000000,
            "pages": pages or [{"page": 1, "cid": aid * 10, "part": "正片", "duration": 120}]}


class Transport:
    """Boundary-only double; all pagination, normalization and persistence are real."""
    def __init__(self, pages=None, fail_page=None):
        self.pages = pages or [[entry()]]
        self.fail_page = fail_page
        self.calls = []
        self.player = {"subtitle": {"subtitles": [{"id": 10, "lan": "ai-zh", "lan_doc": "中文（自动生成）",
                        "subtitle_url": "https://aisubtitle.hdslb.com/test.json?auth_key=PRIVATE", "is_lock": False}]}}

    def get_json(self, path, params=None, *, authenticated=True):
        self.calls.append((path, params or {}, authenticated))
        if path == "/x/web-interface/nav":
            return {"code": 0, "data": {"isLogin": True, "mid": 42, "uname": "测试账号",
                "wbi_img": {"img_url": "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                            "sub_url": "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"}}}
        if path == "/x/v2/history/toview/web":
            pn = int(params["pn"])
            if pn == self.fail_page:
                raise BiliError("rate_limited", "请求受限")
            return {"code": 0, "data": {"count": sum(len(x) for x in self.pages),
                                         "list": self.pages[pn - 1] if pn <= len(self.pages) else []}}
        if path == "/x/player/wbi/v2":
            return {"code": 0, "data": copy.deepcopy(self.player)}
        if path.startswith("https://aisubtitle.hdslb.com/"):
            return {"body": [{"from": 0, "to": 15, "content": "先提出问题。"},
                             {"from": 15, "to": 110, "content": "再推导并说明边界。"}]}
        raise AssertionError(f"unexpected endpoint: {path}")
