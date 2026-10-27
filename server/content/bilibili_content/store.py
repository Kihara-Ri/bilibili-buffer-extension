"""内容事实与版本存储。界面、审阅、偏好学习不属于这个模块。"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .schema import digest, encoded, nonempty, require, validate_work


def now():
    """返回带时区的采集时间，不把本机时间当成平台内容版本。"""
    return datetime.now(timezone.utc).isoformat()


class ContentStore:
    """单用户 SQLite 内容仓库；每个请求使用自己的连接。"""

    def __init__(self, path="data/content.sqlite3"):
        private_new_file = str(path) != ":memory:" and not Path(path).exists()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS works (
                id TEXT PRIMARY KEY, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rules (
                scope TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(scope, target));
        """)
        if private_new_file:
            Path(path).chmod(0o600)

    def close(self):
        """关闭当前请求的数据库连接。"""
        self.db.close()

    def _transaction(self, operation):
        # 列表替换和字幕合并共用一笔事务；嵌套写入用保存点，避免覆盖新到的字幕。
        nested = self.db.in_transaction
        self.db.execute("SAVEPOINT content_operation" if nested else "BEGIN IMMEDIATE")
        try:
            result = operation()
            self.db.execute("RELEASE content_operation" if nested else "COMMIT")
            return result
        except BaseException:
            if nested:
                self.db.execute("ROLLBACK TO content_operation")
                self.db.execute("RELEASE content_operation")
            else:
                self.db.execute("ROLLBACK")
            raise

    def get_work(self, work_id):
        """读取当前内容版本；不存在时抛出 KeyError。"""
        nonempty(work_id, "work_id")
        row = self.db.execute("SELECT * FROM works WHERE id=?", (work_id,)).fetchone()
        if row is None:
            raise KeyError(work_id)
        return {**json.loads(row["payload"]), "revision": row["revision"], "fingerprint": row["fingerprint"]}

    def ingest(self, value):
        """保存完整事实快照；计数变化不会让字幕和调用方审阅全部失效。"""
        item = validate_work(value)
        fingerprint = digest({k: v for k, v in item.items() if k != "statistics"})

        def save():
            old = self.db.execute("SELECT revision,fingerprint FROM works WHERE id=?", (item["id"],)).fetchone()
            revision = old["revision"] + (old["fingerprint"] != fingerprint) if old else 1
            self.db.execute("INSERT INTO works VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                            "revision=excluded.revision,fingerprint=excluded.fingerprint,payload=excluded.payload,updated_at=excluded.updated_at",
                            (item["id"], revision, fingerprint, encoded(item), now()))
            return self.get_work(item["id"])

        return self._transaction(save)

    def set_rule(self, scope, target, *, blocked):
        """设置调用方明确的屏蔽规则，不从收藏或完播推断偏好。"""
        require(scope in ("work", "creator"), "scope must be work or creator")
        nonempty(target, "target")
        require(type(blocked) is bool, "blocked must be boolean")
        value = {"blocked": blocked}
        self.db.execute("INSERT INTO rules VALUES (?, ?, ?) ON CONFLICT(scope,target) DO UPDATE SET payload=excluded.payload",
                        (scope, target, encoded(value)))
        return {"scope": scope, "target": target, **value}

    def _rules(self, work):
        output = []
        for scope, target in (("work", work["id"]), ("creator", work["creator_id"])):
            row = self.db.execute("SELECT payload FROM rules WHERE scope=? AND target=?", (scope, target)).fetchone()
            output.append(json.loads(row[0]) if row else {})
        return output
