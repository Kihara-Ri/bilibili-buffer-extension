import test from "node:test";
import assert from "node:assert/strict";
import {
  choosePopupCodec,
  choosePopupQuality,
  isPopupSnapshotFresh,
  isPopupSnapshotMatch,
  makePopupPageKey,
  POPUP_SNAPSHOT_TTL
} from "../src/popup-snapshot.js";

test("Popup 快照忽略追踪和播放时间参数", () => {
  const first = "https://www.bilibili.com/video/BV1Kg8t6NEmN/?spm_id_from=333&t=10&p=2";
  const second = "https://www.bilibili.com/video/BV1Kg8t6NEmN/?vd_source=test&p=2";
  assert.equal(makePopupPageKey(first), makePopupPageKey(second));
  assert.notEqual(makePopupPageKey(first), makePopupPageKey(second.replace("p=2", "p=3")));
});

test("Popup 快照只匹配同一标签页与同一视频", () => {
  const url = "https://www.bilibili.com/video/BV1Kg8t6NEmN/";
  const snapshot = { tabId: 7, pageKey: makePopupPageKey(url), pageInfo: { supported: true } };
  assert.equal(isPopupSnapshotMatch(snapshot, 7, `${url}?t=20`), true);
  assert.equal(isPopupSnapshotMatch(snapshot, 8, url), false);
  assert.equal(isPopupSnapshotMatch(snapshot, 7, "https://www.bilibili.com/video/BV1Wt421T7oz/"), false);
});

test("Popup 快照过期后仍可首屏展示，但需要静默刷新", () => {
  const now = 10_000_000;
  assert.equal(isPopupSnapshotFresh({ savedAt: now - POPUP_SNAPSHOT_TTL + 1 }, now), true);
  assert.equal(isPopupSnapshotFresh({ savedAt: now - POPUP_SNAPSHOT_TTL }, now), false);
  assert.equal(isPopupSnapshotFresh({ savedAt: 0 }, now), false);
});

test("Popup 保留仍可用的用户画质选择", () => {
  const qualities = [{ quality: 112 }, { quality: 80 }, { quality: 64 }];
  assert.equal(choosePopupQuality(qualities, 80, 112), 80);
  assert.equal(choosePopupQuality(qualities, 120, 112), 112);
  assert.equal(choosePopupQuality(qualities), 112);
});

test("Popup 保留当前画质仍可用的编码选择", () => {
  const codecs = [{ codec: "auto" }, { codec: "av1" }, { codec: "avc" }];
  assert.equal(choosePopupCodec(codecs, "av1", "auto"), "av1");
  assert.equal(choosePopupCodec(codecs, "hevc", "auto"), "auto");
  assert.equal(choosePopupCodec([]), "");
});
