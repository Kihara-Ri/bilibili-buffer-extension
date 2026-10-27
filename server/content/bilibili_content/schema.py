"""内容事实、证据与接口输入的基础校验；不包含审阅协议。"""

import copy
import hashlib
import json
import math

EVIDENCE_MODALITIES = {
    "metadata": set(), "transcript": {"text"}, "author_text": {"text"},
    "research_note": {"text"}, "image": {"image"}, "audio": {"audio"},
    "video": {"image", "motion"}, "av": {"image", "motion", "audio"},
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def nonempty(value, label):
    require(isinstance(value, str) and bool(value.strip()) and len(value) <= 100_000,
            f"{label}: expected nonempty string (up to 100000 characters)")


def number(value, label, minimum=0):
    require(type(value) in (int, float) and math.isfinite(value) and value >= minimum,
            f"{label}: expected finite number >= {minimum}")


def strings(value, label, nonempty_list=False):
    require(isinstance(value, list) and (bool(value) or not nonempty_list), f"{label}: expected list")
    for item in value:
        nonempty(item, label)


def validate_work(value):
    require(isinstance(value, dict), "work: expected object")
    allowed = {"id", "title", "creator_id", "creator_name", "duration_seconds", "available",
               "family_id", "tags", "sources", "evidence", "statistics"}
    require(not (set(value) - allowed), f"unknown work fields: {sorted(set(value) - allowed)}")
    item = copy.deepcopy(value)
    for key in ("id", "title", "creator_id", "creator_name"):
        nonempty(item.get(key), key)
    number(item.get("duration_seconds"), "duration_seconds", minimum=0.001)
    require(type(item.get("available")) is bool, "available: expected boolean")
    if item.get("family_id") is not None:
        nonempty(item["family_id"], "family_id")
    item.setdefault("tags", [])
    strings(item["tags"], "tags")
    require(isinstance(item.get("sources"), list) and bool(item["sources"]), "sources: required")
    for source in item["sources"]:
        require(isinstance(source, dict), "source: expected object")
        for key in ("kind", "locator"):
            nonempty(source.get(key), f"source.{key}")
    require(isinstance(item.get("evidence"), list), "evidence: expected list")
    ids = set()
    for evidence in item["evidence"]:
        require(isinstance(evidence, dict), "evidence: expected object")
        for key in ("id", "locator", "text"):
            nonempty(evidence.get(key), f"evidence.{key}")
        require(evidence["id"] not in ids, "duplicate evidence id")
        ids.add(evidence["id"])
        require(evidence.get("kind") in EVIDENCE_MODALITIES, "invalid evidence kind")
        require(evidence.get("coverage", "excerpt") in ("full", "excerpt", "note"), "invalid coverage")
        if "start" in evidence or "end" in evidence:
            number(evidence.get("start"), "evidence.start")
            number(evidence.get("end"), "evidence.end")
            require(evidence["start"] < evidence["end"] <= item["duration_seconds"], "invalid evidence interval")
        if evidence["kind"] in ("audio", "video", "av"):
            require("start" in evidence and "end" in evidence, "media evidence requires an interval")
    encoded(item)
    return item
