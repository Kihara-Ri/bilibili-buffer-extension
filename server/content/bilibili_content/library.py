# 账号列表是原始事实，不能由取证是否成功来删选；分P始终绑定各自CID和时长。
# 完整字幕轨只表示接口分段已取全，不能冒充连续看完或验证声音/画面。
"""账号列表、分 P 与字幕取证；不包含发现算法或审阅状态。"""

import json
import re
from urllib.parse import parse_qs, urlsplit

from .bilibili import BiliError
from .store import now
from .schema import digest, encoded, nonempty, number, require


def clean_entry(value):
    require(isinstance(value, dict), "watchlater entry must be an object")
    owner = value.get("owner") or {}
    pages = value.get("pages") or []
    require(isinstance(owner, dict) and isinstance(pages, list), "invalid watchlater owner or pages")
    return {"aid": value.get("aid"), "bvid": value.get("bvid"), "title": value.get("title", "失效视频"),
            "state": value.get("state", 0), "duration": value.get("duration", 0), "cid": value.get("cid"),
            "owner": {"mid": owner.get("mid"), "name": owner.get("name")}, "add_at": value.get("add_at"),
            "pages": [{k: p.get(k) for k in ("page", "cid", "part", "duration")} for p in pages if isinstance(p, dict)]}


def entry_key(value):
    identifier = value.get("bvid") or value.get("aid")
    require(identifier is not None, "watchlater entry has no stable id")
    return str(identifier)


def transcript_evidence(work, cid, language, body):
    require(isinstance(body, list) and bool(body), "subtitle body must contain segments")
    nonempty(language, "language")
    duration = work["duration_seconds"]
    normalized = []
    for item in body:
        require(isinstance(item, dict), "subtitle segment must be an object")
        start, end, content = item.get("from"), item.get("to"), item.get("content")
        number(start, "subtitle.from")
        number(end, "subtitle.to")
        nonempty(content, "subtitle.content")
        # Platform rounding may overshoot a part by a fraction of a second.
        require(start < end <= duration + 2, "subtitle interval exceeds this part")
        end = min(end, duration)
        require(start < end, "subtitle segment starts after this part")
        normalized.append((start, end, content.strip()))
    require(all(a[0] <= b[0] for a, b in zip(normalized, normalized[1:])), "subtitle segments out of order")
    locator = f"bilibili:subtitle:{work['id']}:{cid}:{language}"
    prefix = f"subtitle:{cid}:{language}"
    evidence = [{"id": f"{prefix}:{i + 1}", "kind": "transcript", "coverage": "excerpt",
                 "locator": locator, "start": a, "end": b, "text": text,
                 "language": language, "machine_generated": True if language.startswith("ai-") else None}
                for i, (a, b, text) in enumerate(normalized)]
    text = "\n".join(f"[{a:g}–{b:g}s] {line}" for a, b, line in normalized)
    if len(text) <= 100_000:
        evidence.insert(0, {"id": f"{prefix}:full", "kind": "transcript", "coverage": "full",
                            "locator": locator, "start": normalized[0][0], "end": normalized[-1][1],
                            "text": text, "language": language, "machine_generated": True if language.startswith("ai-") else None})
    return evidence


class Library:
    def __init__(self, engine):
        self.engine = engine
        self.db = engine.db
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS library_state (
                key TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS library_entries (
                account_id TEXT NOT NULL, entry_id TEXT NOT NULL, position INTEGER NOT NULL,
                payload TEXT NOT NULL, work_ids TEXT NOT NULL, PRIMARY KEY(account_id, entry_id));
            CREATE TABLE IF NOT EXISTS subtitle_state (
                work_id TEXT PRIMARY KEY, cid INTEGER NOT NULL, status TEXT NOT NULL,
                payload TEXT NOT NULL, checked_at TEXT NOT NULL);
        """)

    def _state(self, key, value=None):
        if value is not None:
            self.db.execute("INSERT INTO library_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                            (key, encoded(value)))
            return value
        row = self.db.execute("SELECT payload FROM library_state WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def status(self):
        return {"account": self._state("account"), "last_sync": self._state("last_sync")}

    def sync(self, client, *, page_size=20, max_pages=20):
        require(type(page_size) is int and 1 <= page_size <= 100, "page_size must be 1..100")
        require(type(max_pages) is int and 1 <= max_pages <= 50, "max_pages must be 1..50")
        seen, entries, total = set(), [], None
        try:
            account = client.identity()
            for pn in range(1, max_pages + 1):
                page = client.watchlater_page(pn, page_size)
                if total is None:
                    total = page["count"]
                if total != page["count"]:
                    break
                cleaned = [clean_entry(item) for item in page["list"]]
                fresh = [item for item in cleaned if entry_key(item) not in seen]
                for item in fresh:
                    key = entry_key(item)
                    if key not in seen:
                        seen.add(key)
                        entries.append(item)
                if len(entries) == total:
                    return self._replace(account, entries, observed_at=now())
                if not fresh or len(entries) > total:
                    break
            result = {"status": "incomplete", "collected": len(entries), "total": total,
                      "reason": "page_budget_or_nonprogressing_snapshot", "checked_at": now()}
        except BiliError as exc:
            result = {"status": exc.code, "collected": len(entries), "total": total,
                      "reason": str(exc), "checked_at": now()}
        except (ValueError, TypeError):
            result = {"status": "invalid_response", "collected": len(entries), "total": total,
                      "reason": "分页内容结构变化，保留原队列。", "checked_at": now()}
        return self._state("last_sync", result)

    def _work_candidates(self, item, kind="watch_later"):
        if item["state"] != 0 or not item.get("bvid") or not item["owner"].get("mid"):
            return []
        pages = item["pages"]
        # Missing part metadata is visible as pending, never guessed from a whole-video duration.
        if not pages:
            return []
        works = []
        for page in pages:
            if not all(type(page.get(k)) is int and page[k] > 0 for k in ("page", "cid", "duration")):
                continue
            identifier = item["bvid"] if len(pages) == 1 else f"{item['bvid']}:p{page['page']}"
            source = {"kind": kind, "locator": "bilibili:account:watchlater" if kind == "watch_later" else "bilibili:video:" + item["bvid"],
                      "bvid": item["bvid"], "cid": page["cid"], "page": page["page"],
                      "part_title": page.get("part") or "", "added_at": item["add_at"]}
            try:
                old = self.engine.get_work(identifier)
            except KeyError:
                old = {"evidence": [], "sources": [], "tags": []}
            previous = next((s for s in old["sources"] if s["kind"] in ("watch_later", "video")), None)
            # A replaced CID must not inherit the old part's transcript.
            evidence = old["evidence"] if not previous or previous.get("cid") == page["cid"] else [
                e for e in old["evidence"] if not e["id"].startswith("subtitle:")]
            works.append({"id": identifier, "title": item["title"] if len(pages) == 1 else f"{item['title']} · P{page['page']} {source['part_title']}",
                          "creator_id": str(item["owner"]["mid"]), "creator_name": item["owner"].get("name") or "未知作者",
                          "duration_seconds": page["duration"], "available": True, "family_id": item["bvid"],
                          "tags": old["tags"], "sources": [s for s in old["sources"] if s["kind"] not in ("watch_later", "video")] + [source],
                          "evidence": evidence})
        return works

    def _replace(self, account, items, *, observed_at):
        require(isinstance(account, dict) and set(account) == {"id", "name"}, "account accepts only id and name")
        nonempty(account["id"], "account.id")
        nonempty(account["name"], "account.name")
        require(len({entry_key(i) for i in items}) == len(items), "duplicate entries in complete snapshot")
        def save():
            # Read and merge evidence under the same write transaction, so a list refresh
            # cannot resurrect an older transcript observed before a concurrent import.
            prepared = [(item, self._work_candidates(item)) for item in items]
            for item, works in prepared:
                if item["state"] != 0:
                    previous = self.db.execute("SELECT work_ids FROM library_entries WHERE account_id=? AND entry_id=?",
                                               (account["id"], entry_key(item))).fetchone()
                    for identifier in json.loads(previous[0]) if previous else []:
                        old = self.engine.get_work(identifier)
                        old = {k: v for k, v in old.items() if k not in ("revision", "fingerprint")}
                        old["available"] = False
                        self.engine.ingest(old)
                for work in works:
                    self.engine.ingest(work)
            self.db.execute("DELETE FROM library_entries WHERE account_id=?", (account["id"],))
            for index, (item, works) in enumerate(prepared):
                self.db.execute("INSERT INTO library_entries VALUES (?, ?, ?, ?, ?)",
                                (account["id"], entry_key(item), index, encoded(item), encoded([w["id"] for w in works])))
            self._state("account", {**account, "observed_at": observed_at})
            return self._state("last_sync", {"status": "complete", "collected": len(items), "total": len(items),
                                             "checked_at": observed_at, "account_id": account["id"]})
        return self.engine._transaction(save)

    def queue(self):
        account = self._state("account")
        if not account:
            return []
        output = []
        rows = self.db.execute("SELECT * FROM library_entries WHERE account_id=? ORDER BY position", (account["id"],)).fetchall()
        for row in rows:
            item, ids = json.loads(row["payload"]), json.loads(row["work_ids"])
            if not ids:
                output.append({"id": entry_key(item), "title": item["title"], "status": "unavailable" if item["state"] else "pending_metadata",
                               "bvid": item.get("bvid"), "cid": item.get("cid")})
            for work_id in ids:
                work = self.engine.get_work(work_id)
                source = next(s for s in work["sources"] if s["kind"] in ("watch_later", "video"))
                state = self.db.execute("SELECT * FROM subtitle_state WHERE work_id=?", (work_id,)).fetchone()
                blocked = any(rule.get("blocked") for rule in self.engine._rules(work))
                subtitle_status = state["status"] if state and state["cid"] == source["cid"] else "not_fetched"
                output.append({"id": work_id, "title": work["title"], "bvid": source["bvid"], "cid": source["cid"],
                               "page": source["page"], "part_title": source.get("part_title", ""),
                               "duration_seconds": work["duration_seconds"], "creator_id": work["creator_id"],
                               "creator_name": work["creator_name"], "available": work["available"],
                               "subtitle_status": subtitle_status, "rules_blocked": blocked,
                               "revision": work["revision"], "fingerprint": work["fingerprint"]})
        return output

    def _subtitle_state(self, work_id, cid, status, details=None):
        details = details or {}
        self.db.execute("INSERT INTO subtitle_state VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET "
                        "cid=excluded.cid,status=excluded.status,payload=excluded.payload,checked_at=excluded.checked_at",
                        (work_id, cid, status, encoded(details), now()))
        return {"work_id": work_id, "cid": cid, "status": status, **details}

    def apply_subtitle(self, work_id, cid, result):
        return self.engine._transaction(lambda: self._apply_subtitle(work_id, cid, result))

    def _apply_subtitle(self, work_id, cid, result):
        work = self.engine.get_work(work_id)
        source = next((s for s in work["sources"] if s["kind"] in ("watch_later", "video")), None)
        require(source is not None and type(cid) is int and source["cid"] == cid, "subtitle does not match current CID")
        require(not any(r.get("blocked") for r in self.engine._rules(work)), "work is blocked")
        require(result.get("status") in ("ready", "no_subtitle", "subtitle_locked"), "invalid subtitle result")
        evidence = [e for e in work["evidence"] if not e["id"].startswith("subtitle:")]
        if result["status"] == "ready":
            evidence += transcript_evidence(work, cid, result.get("language"), result.get("body"))
        value = {k: v for k, v in work.items() if k not in ("revision", "fingerprint")}
        value["evidence"] = evidence
        self.engine.ingest(value)
        details = {"segments": len(result.get("body", [])), "language": result.get("language"),
                   "content_hash": digest(result.get("body", []))}
        return self._subtitle_state(work_id, cid, result["status"], details)

    def collect_subtitles(self, client, *, limit=5, force=False):
        require(type(limit) is int and 1 <= limit <= 10, "subtitle limit must be 1..10")
        results = []
        for item in self.queue():
            if len(results) >= limit:
                break
            if item.get("rules_blocked") or item.get("status") == "unavailable" or item.get("subtitle_status") is None:
                continue
            if not force and item["subtitle_status"] in ("ready", "no_subtitle", "subtitle_locked"):
                continue
            try:
                result = client.subtitles(item["bvid"], item["cid"])
                results.append(self.apply_subtitle(item["id"], item["cid"], result))
            except BiliError as exc:
                results.append(self._subtitle_state(item["id"], item["cid"], exc.code))
                if exc.code in ("auth_required", "rate_limited"):
                    break
            except ValueError:
                results.append(self._subtitle_state(item["id"], item["cid"], "invalid_subtitle"))
        return results

    def import_capture(self, value):
        require(isinstance(value, dict), "capture must be an object")
        if value.get("type") == "watchlater":
            require(set(value) <= {"type", "account", "items", "total", "observed_at"}, "unknown capture fields; credentials are forbidden")
            require(isinstance(value.get("items"), list) and type(value.get("total")) is int, "invalid snapshot")
            require(len(value["items"]) == value["total"], "capture must be a complete watchlater snapshot")
            return self._replace(value.get("account"), [clean_entry(i) for i in value["items"]], observed_at=now())
        if value.get("type") == "subtitle":
            allowed = {"type", "work_id", "cid", "status", "language", "language_name", "body", "revision"}
            require(set(value) <= allowed, "unknown subtitle capture fields; signed URLs and credentials are forbidden")
            if "revision" in value:
                require(value["revision"] == self.engine.get_work(value["work_id"])["revision"], "stale subtitle capture")
            return self.apply_subtitle(value.get("work_id"), value.get("cid"), {"status": value.get("status", "ready"),
                                       "language": value.get("language"), "body": value.get("body", [])})
        raise ValueError("unknown capture type")

    def resolve_video(self, client, url):
        """解析用户主动指定的视频；不把它自动加入平台或本地待看队列。"""
        nonempty(url, "url")
        if re.fullmatch(r"BV[A-Za-z0-9]{10}", url):
            bvid, page = url, 1
        else:
            parsed = urlsplit(url)
            require(parsed.scheme == "https" and parsed.hostname in ("www.bilibili.com", "bilibili.com")
                    and not parsed.username and not parsed.password and parsed.port in (None, 443), "expected HTTPS Bilibili video URL")
            match = re.fullmatch(r"/video/(BV[A-Za-z0-9]{10})/?", parsed.path)
            require(match is not None, "expected canonical BV video URL")
            bvid = match.group(1)
            pages = parse_qs(parsed.query).get("p", ["1"])
            require(len(pages) == 1 and pages[0].isdigit() and int(pages[0]) > 0, "invalid page")
            page = int(pages[0])
        data = client.video(bvid)
        item = clean_entry(data)
        if item["state"] != 0:
            raise BiliError("media_unavailable", "这条视频当前不可访问。")
        require(item["bvid"] == bvid, "video identity mismatch")

        def save():
            works = self._work_candidates(item, kind="video")
            require(works and len({w["id"] for w in works}) == len(works), "incomplete or duplicated video parts")
            source_of = lambda w: next(s for s in w["sources"] if s["kind"] == "video")
            selected = next((w for w in works if source_of(w)["page"] == page), None)
            require(selected is not None, "requested part does not exist")
            parts = []
            for value in works:
                snapshot = self.engine.ingest(value)
                source = source_of(snapshot)
                parts.append({"id": snapshot["id"], "bvid": bvid, "cid": source["cid"], "page": source["page"],
                              "part_title": source["part_title"], "duration_seconds": snapshot["duration_seconds"],
                              "revision": snapshot["revision"]})
            return {"bvid": bvid, "title": item["title"], "creator_id": str(item["owner"]["mid"]),
                    "creator_name": item["owner"]["name"], "selected_id": selected["id"], "parts": parts}
        return self.engine._transaction(save)

    def collect_subtitle(self, client, work_id):
        """按已解析的具体分 P 取字幕；不能用主 P 的字幕冒充整部作品。"""
        work = self.engine.get_work(work_id)
        require(not any(rule.get("blocked") for rule in self.engine._rules(work)), "work is blocked")
        source = next(s for s in work["sources"] if s["kind"] in ("watch_later", "video"))
        return self.apply_subtitle(work_id, source["cid"], client.subtitles(source["bvid"], source["cid"]))
