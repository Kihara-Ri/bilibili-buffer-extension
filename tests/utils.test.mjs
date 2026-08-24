import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityOptions,
  buildCachedDownloadPlan,
  buildMediaCodecOptions,
  buildMediaQualityOptions,
  formatBytes,
  formatDuration,
  getPersistedMediaSource,
  isVideoCodecSelectionMatch,
  getCodecFamily,
  hasCompleteByteCount,
  getVideoPageId,
  makeBiliSpaceUrl,
  makeVideoId,
  makeQualityVideoId,
  makeMimeCodec,
  normalizeQualityId,
  normalizeCodecPreference,
  normalizeHttpUrl,
  parseBiliVideoUrl,
  parseContentRange,
  sanitizeDownloadFilename,
  shouldShowInLibrary
} from "../src/utils.js";

test("识别标准 BV 视频和分 P", () => {
  assert.deepEqual(
    parseBiliVideoUrl("https://www.bilibili.com/video/BV1Wt421T7oz/?p=3"),
    { supported: true, bvid: "BV1Wt421T7oz", aid: null, page: 3 }
  );
});

test("识别 av 视频并限制非法分 P", () => {
  assert.deepEqual(
    parseBiliVideoUrl("https://www.bilibili.com/video/av123/?p=-2"),
    { supported: true, bvid: null, aid: 123, page: 1 }
  );
});

test("识别稍后再看列表中的当前 BV 视频", () => {
  assert.deepEqual(
    parseBiliVideoUrl("https://www.bilibili.com/list/watchlater?oid=1&bvid=BV1LP8C6sEAm"),
    { supported: true, bvid: "BV1LP8C6sEAm", aid: null, page: 1 }
  );
});

test("区分非 B 站与非视频 B 站页面", () => {
  assert.equal(parseBiliVideoUrl("https://example.com/video/BV123").reason, "notBilibili");
  assert.equal(parseBiliVideoUrl("https://www.bilibili.com/").reason, "notVideo");
});

test("格式化缓存元数据", () => {
  assert.equal(makeVideoId("BVabc", 42), "BVabc:42");
  assert.equal(makeQualityVideoId("BVabc:42", 80), "BVabc:42:q80");
  assert.equal(makeQualityVideoId("BVabc:42", 80, "av1"), "BVabc:42:q80:cav1");
  assert.equal(getVideoPageId({ id: "BVabc:42:q80", bvid: "BVabc", cid: 42 }), "BVabc:42");
  assert.equal(getVideoPageId({ id: "BVabc:42:q80:cauto" }), "BVabc:42");
  assert.equal(formatBytes(1024 * 1024), "1.00 MB");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(normalizeHttpUrl("http://i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
  assert.equal(normalizeHttpUrl("javascript:alert(1)"), "");
  assert.equal(makeBiliSpaceUrl(123456), "https://space.bilibili.com/123456");
  assert.equal(makeBiliSpaceUrl("not-a-mid"), "");
});

test("零字节失败任务不进入本地片库", () => {
  assert.equal(shouldShowInLibrary({ status: "error", downloadedBytes: 0 }), false);
  assert.equal(shouldShowInLibrary({ status: "error", downloadedBytes: 1024, resumeBytes: 1024 }), true);
  assert.equal(shouldShowInLibrary({ status: "complete", downloadedBytes: 1024 }), true);
});

test("解析 CDN Content-Range 并拒绝非法范围", () => {
  assert.deepEqual(parseContentRange("bytes 8388608-12582911/81871821"), {
    start: 8388608,
    end: 12582911,
    total: 81871821
  });
  assert.equal(parseContentRange("bytes 10-9/100"), null);
  assert.equal(parseContentRange("bytes 0-100/100"), null);
});

test("只有实际字节数等于总大小时才算缓存完成", () => {
  assert.equal(hasCompleteByteCount({ downloadedBytes: 12, totalBytes: 100 }), false);
  assert.equal(hasCompleteByteCount({ downloadedBytes: 100, totalBytes: 100 }), true);
  assert.equal(hasCompleteByteCount({ downloadedBytes: 0, totalBytes: 0 }), false);
});

test("画质列表去重、按清晰度排序并识别会员标记", () => {
  assert.deepEqual(buildQualityOptions({
    quality: 80,
    accept_quality: [64, 112, 80, 64],
    accept_description: ["720P", "1080P 高码率", "1080P", "720P"],
    support_formats: [
      { quality: 112, display_desc: "1080P+", superscript: "大会员" },
      { quality: 80, display_desc: "1080P", need_login: true }
    ]
  }), [
    { quality: 112, label: "1080P+", requiresVip: true, requiresLogin: false },
    { quality: 80, label: "1080P", requiresVip: false, requiresLogin: true },
    { quality: 64, label: "720P", requiresVip: false, requiresLogin: false }
  ]);
  assert.equal(normalizeQualityId("80"), 80);
  assert.equal(normalizeQualityId("999", 64), 64);
});

test("可缓存画质以实际返回的 DASH 或单段 MP4 轨道为准", () => {
  const options = buildMediaQualityOptions({
    quality: 64,
    format: "flv720",
    accept_quality: [116, 80, 64, 32, 16],
    accept_description: ["1080P60", "1080P", "720P", "480P", "360P"],
    dash: {
      video: [
        { id: 80, mimeType: "video/mp4", codecs: "avc1.640032" },
        { id: 64, mimeType: "video/mp4", codecs: "avc1.640028" },
        { id: 64, mimeType: "video/mp4", codecs: "hev1.1.6.L120.90" }
      ]
    }
  });
  assert.deepEqual(options.map((option) => option.quality), [80, 64]);
  assert.equal(makeMimeCodec("video/mp4", "avc1.640032"), 'video/mp4; codecs="avc1.640032"');
});

test("编码选项按当前画质的实际 DASH 轨道生成", () => {
  const options = buildMediaCodecOptions({
    dash: { video: [
      { id: 80, codecs: "avc1.640032", bandwidth: 5_000_000 },
      { id: 80, codecs: "hev1.1.6.L120.90", bandwidth: 2_000_000 },
      { id: 80, codecs: "av01.0.08M.08", bandwidth: 1_800_000 },
      { id: 64, codecs: "avc1.640028", bandwidth: 2_200_000 }
    ] }
  }, 80);
  assert.deepEqual(options.map((option) => option.codec), ["auto", "av1", "hevc", "avc"]);
  assert.equal(options[0].minBandwidth, 1_800_000);
  assert.equal(buildMediaCodecOptions({
    dash: { video: [{ id: 80, codecs: "avc1.640032" }] }
  }, 80)[0].minBandwidth, 0);
  assert.equal(getCodecFamily("hvc1.2.4"), "hevc");
  assert.equal(normalizeCodecPreference("AV1"), "av1");
});

test("新增编码维度仍能匹配旧缓存和自动选择的实际轨道", () => {
  const legacyAvc = { tracks: { video: { codecs: "avc1.640032" } } };
  const automaticAv1 = {
    requestedCodec: "auto",
    codec: "av1",
    tracks: { video: { codecs: "av01.0.08M.08" } }
  };
  assert.equal(isVideoCodecSelectionMatch(legacyAvc, "auto"), true);
  assert.equal(isVideoCodecSelectionMatch(legacyAvc, "avc"), true);
  assert.equal(isVideoCodecSelectionMatch(legacyAvc, "av1"), false);
  assert.equal(isVideoCodecSelectionMatch(automaticAv1, "auto"), true);
  assert.equal(isVideoCodecSelectionMatch(automaticAv1, "av1"), true);
  assert.equal(isVideoCodecSelectionMatch(automaticAv1, "avc"), false);
});

test("保存文件名会移除路径和系统保留字符", () => {
  assert.equal(sanitizeDownloadFilename('  标题 / P1: "开场"?  '), "标题 P1 开场");
  assert.equal(sanitizeDownloadFilename("..."), "Bili 视频");
});

test("关闭原标签页后可从任务记录恢复已解析的 DASH 地址", () => {
  const source = getPersistedMediaSource({
    mediaKind: "dash",
    quality: 112,
    qualityLabel: "1080P+",
    duration: 60,
    tracks: {
      video: {
        sourceUrls: ["https://cdn.example/video.m4s"],
        codecs: "avc1.640032",
        representationKey: "112:7:avc1.640032"
      },
      audio: {
        sourceUrls: ["https://cdn.example/audio.m4s", "javascript:bad"],
        codecs: "mp4a.40.2",
        representationKey: "30280:0:mp4a.40.2"
      }
    }
  });
  assert.equal(source.mediaKind, "dash");
  assert.deepEqual(source.tracks.video.urls, ["https://cdn.example/video.m4s"]);
  assert.deepEqual(source.tracks.audio.urls, ["https://cdn.example/audio.m4s"]);
  assert.equal(source.quality, 112);
});

test("保存计划区分单文件 MP4 与 DASH 双轨", () => {
  assert.deepEqual(buildCachedDownloadPlan({
    video: { title: "测试/视频", qualityLabel: "720P" },
    playbackUrl: "blob:single"
  }), {
    splitTracks: false,
    items: [{ url: "blob:single", filename: "测试 视频 [720P].mp4" }]
  });

  assert.deepEqual(buildCachedDownloadPlan({
    video: { title: "测试", partTitle: "P1", qualityLabel: "1080P+" },
    playback: { tracks: [
      { name: "video", url: "blob:video" },
      { name: "audio", url: "blob:audio" }
    ] }
  }), {
    splitTracks: true,
    items: [
      { url: "blob:video", filename: "测试 - P1 [1080P+].视频轨.mp4" },
      { url: "blob:audio", filename: "测试 - P1 [1080P+].音频轨.m4a" }
    ]
  });
});
