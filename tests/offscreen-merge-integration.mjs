// 真实 B 站 DASH 分片夹具（见 tests/fixtures/README.md）走完整链路：
// 分块下载 → 重封装合并 → 用合并结果播放 → 仅缓存音频（Hi-Res 无损优先）。
import { deleteVideoData, getChunks, putChunk, putVideo } from "../src/db.js";
import { listBoxes, parseFragment, readBoxHeader, verifyMergedHeader } from "../src/mp4-merge.js";
import { createFakeBudget } from "./fixtures/fake-budget.mjs";

const VIDEO = new Uint8Array(await (await fetch("./fixtures/dash-video-2frag.mp4")).arrayBuffer());
const AUDIO = new Uint8Array(await (await fetch("./fixtures/dash-audio-2frag.mp4")).arrayBuffer());
const PROGRESSIVE = new Uint8Array(await (await fetch("./fixtures/progressive-avc-aac.mp4")).arrayBuffer());
const broadcasts = [];
const budget = createFakeBudget();
let messageListener;
const stepElement = () => document.querySelector("#step");
function mark(label) {
  const element = stepElement();
  if (element) element.textContent = label;
}

Object.defineProperty(globalThis, "MediaSource", {
  configurable: true,
  value: { isTypeSupported: () => true }
});

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    },
    async sendMessage(message) {
      // 与离线下载共用同一套租约状态机；缺少租约会让下载器一直等待预算。
      const budgetReply = budget.handle(message);
      if (budgetReply) return budgetReply;
      broadcasts.push(message);
      return { ok: true };
    }
  }
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const text = String(url);
  if (!text.includes("/fixtures/")) return nativeFetch(url, init);
  const source = text.includes("progressive")
    ? PROGRESSIVE
    : text.includes("flac") || text.includes("audio")
      ? AUDIO
      : VIDEO;
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(init.headers?.Range || ""));
  if (!match) return new Response("Range required", { status: 400 });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), source.length - 1);
  const body = source.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${start}-${end}/${source.length}`,
      "Content-Type": text.includes("audio") || text.includes("flac") ? "audio/mp4" : "video/mp4"
    }
  });
};

mark("import-offscreen");
await import("../src/offscreen.js");
await waitFor(() => typeof messageListener === "function");

const stamp = Date.now();
const videoId = `BV1merge:100:q32:${stamp}`;
const audioId = `BV1merge:100:a:${stamp}`;
const created = [];

try {
  // 1) 视频模式：两条轨道下载完成后合并成单个 MP4。
  mark("start-video");
  const startVideo = await send({
    type: "START_DOWNLOAD",
    video: {
      id: videoId,
      pageId: "BV1merge:100",
      bvid: "BV1merge",
      cid: 100,
      title: "双轨合并集成测试",
      duration: 10,
      cacheMode: "video",
      requestedQuality: 32,
      requestedQualityExplicit: true,
      requestedCodec: "auto",
      playurlData: makePlayurl(),
      updatedAt: Date.now()
    }
  });
  created.push(videoId);
  assert(startVideo.ok && startVideo.started, `视频任务没有启动：${JSON.stringify(startVideo)}`);

  mark("wait-video");
  const mergedRecord = await waitFor(async () => {
    const record = await get(videoId);
    if (record?.status === "error") throw new Error(record.error);
    return record?.status === "complete" ? record : null;
  }, 30000);

  assert(budget.acquireCount > 0, "离线下载没有申请共享下载预算");
  assert(!mergedRecord.mergeError, `合并失败：${mergedRecord.mergeError}`);
  assert(mergedRecord.merged?.totalBytes > 0, "没有生成合并文件元数据");
  assert(mergedRecord.merged.totalBytes === mergedRecord.totalBytes, "合并记录总字节数不一致");
  assert(mergedRecord.downloadedBytes === mergedRecord.merged.totalBytes, "合并记录完成字节数不一致");
  const sourceChunks = (await getChunks(videoId, "video")).length + (await getChunks(videoId, "audio")).length;
  assert(sourceChunks === 0, "合并成功后应释放源轨道分块，避免占用双份空间");
  const mergedChunks = await getChunks(videoId, "merged");
  const mergedBytes = new Uint8Array(await new Blob(mergedChunks.map((chunk) => chunk.data)).arrayBuffer());
  assert(mergedBytes.length === mergedRecord.merged.totalBytes, "合并文件落盘字节数不一致");
  assert(mergedChunks.length === mergedRecord.merged.chunkCount, "合并文件分块数不一致");
  verifyMergedHeader(mergedBytes.subarray(0, 4096));

  const topLevel = listBoxes(mergedBytes).map((box) => box.type);
  assert(topLevel[0] === "ftyp" && topLevel[1] === "moov", "合并文件缺少初始化段");
  const fragmentTracks = listBoxes(mergedBytes)
    .filter((box) => box.type === "moof")
    .map((box) => parseFragment(mergedBytes.subarray(box.offset, box.end)).trackId);
  assert(fragmentTracks.join(",") === "1,2,2,1", `合并文件片段顺序不正确：${fragmentTracks}`);
  assert(mergedBytes.length > VIDEO.length + AUDIO.length - 4096, "合并文件明显丢失媒体数据");

  // 2) 合并结果能直接播放：Chrome 同时解出视频帧与音频字节。
  mark("probe-playback");
  const playback = await send({ type: "GET_PLAYBACK_URL", videoId });
  assert(typeof playback.playbackUrl === "string", "合并缓存没有返回单文件播放地址");
  const playbackBytes = new Uint8Array(await (await fetch(playback.playbackUrl)).arrayBuffer());
  assert(playbackBytes.length === mergedBytes.length, "播放地址返回的字节数不正确");

  const element = document.createElement("video");
  element.muted = true;
  element.preload = "auto";
  document.body.append(element);
  const playbackResult = await probePlayback(element, playback.playbackUrl);
  assert(playbackResult.decodedVideoFrames > 0, `合并文件没有解出视频帧：${JSON.stringify(playbackResult)}`);
  assert(playbackResult.decodedAudioBytes > 0, `合并文件没有解出音频：${JSON.stringify(playbackResult)}`);

  // 3) 仅音频模式：只下载音频轨，Hi-Res 无损优先，并保留原始容器。
  mark("start-audio");
  const startAudio = await send({
    type: "START_DOWNLOAD",
    video: {
      id: audioId,
      pageId: "BV1merge:100",
      bvid: "BV1merge",
      cid: 100,
      title: "仅音频集成测试",
      duration: 10,
      cacheMode: "audio",
      requestedQuality: 32,
      requestedQualityExplicit: true,
      requestedCodec: "auto",
      playurlData: makePlayurl(),
      updatedAt: Date.now()
    }
  });
  created.push(audioId);
  assert(startAudio.ok && startAudio.started, `仅音频任务没有启动：${JSON.stringify(startAudio)}`);

  mark("wait-audio");
  const audioRecord = await waitFor(async () => {
    const record = await get(audioId);
    if (record?.status === "error") throw new Error(record.error);
    return record?.status === "complete" ? record : null;
  }, 30000);

  assert(audioRecord.mediaKind === "audio", "仅音频记录的类型不正确");
  assert(audioRecord.cacheMode === "audio", "仅音频记录没有标记缓存模式");
  assert(audioRecord.tracks?.audio?.representationId === 30251, `没有选择 Hi-Res 无损音轨：${audioRecord.tracks?.audio?.representationId}`);
  assert(audioRecord.audioLabel === "Hi-Res 无损", `音频说明不正确：${audioRecord.audioLabel}`);
  assert(!audioRecord.tracks?.video, "仅音频记录不应包含视频轨");
  assert((await getChunks(audioId, "video")).length === 0, "仅音频模式下载了视频轨");
  const audioOnlyChunks = await getChunks(audioId, "audio");
  const audioOnlyBytes = new Uint8Array(await new Blob(audioOnlyChunks.map((chunk) => chunk.data)).arrayBuffer());
  assert(audioOnlyBytes.length === AUDIO.length, "仅音频文件字节数不正确");
  assert(audioOnlyChunks.length === audioRecord.tracks.audio.chunkCount, "仅音频分块数不正确");
  assert(!audioRecord.merged, "仅音频模式不应产生合并文件");
  const audioPlayback = await send({ type: "GET_PLAYBACK_URL", videoId: audioId });
  assert(typeof audioPlayback.playbackUrl === "string", "仅音频缓存没有返回播放地址");
  const savedBytes = new Uint8Array(await (await fetch(audioPlayback.playbackUrl)).arrayBuffer());
  assert(savedBytes.length === AUDIO.length, "仅音频播放地址字节数不正确");
  assert(readBoxHeader(savedBytes, 0).type === "ftyp", "仅音频文件不是原始 MP4 分片");

  // 4) 旧版双轨缓存（还没有 merged）在播放/保存时自动合并为单文件。
  mark("legacy-merge");
  const legacyId = `BV1merge:100:q32:legacy-${stamp}`;
  created.push(legacyId);
  await putVideo({
    id: legacyId,
    pageId: "BV1merge:100",
    bvid: "BV1merge",
    cid: 100,
    title: "旧版双轨缓存",
    status: "complete",
    mediaKind: "dash",
    cacheMode: "video",
    quality: 32,
    qualityLabel: "480P",
    requestedQuality: 32,
    duration: 10,
    downloadedBytes: VIDEO.length + AUDIO.length,
    resumeBytes: VIDEO.length + AUDIO.length,
    totalBytes: VIDEO.length + AUDIO.length,
    chunkCount: 2,
    updatedAt: Date.now(),
    tracks: {
      video: {
        representationKey: "32:7:avc1.64001F",
        representationId: 32,
        codecs: "avc1.64001F",
        mimeType: "video/mp4",
        mimeCodec: "video/mp4; codecs=\"avc1.64001F\"",
        sourceUrls: ["https://fixtures.test/fixtures/dash-video-2frag.mp4"],
        downloadedBytes: VIDEO.length,
        resumeBytes: VIDEO.length,
        totalBytes: VIDEO.length,
        chunkCount: 1
      },
      audio: {
        representationKey: "30280:0:mp4a.40.2",
        representationId: 30280,
        codecs: "mp4a.40.2",
        mimeType: "audio/mp4",
        mimeCodec: "audio/mp4; codecs=\"mp4a.40.2\"",
        sourceUrls: ["https://fixtures.test/fixtures/audio-192k.mp4"],
        downloadedBytes: AUDIO.length,
        resumeBytes: AUDIO.length,
        totalBytes: AUDIO.length,
        chunkCount: 1
      }
    }
  });
  await putChunk(legacyId, "video", 0, new Blob([VIDEO], { type: "application/octet-stream" }));
  await putChunk(legacyId, "audio", 0, new Blob([AUDIO], { type: "application/octet-stream" }));
  const legacyPlayback = await send({ type: "GET_PLAYBACK_URL", videoId: legacyId });
  assert(typeof legacyPlayback.playbackUrl === "string", "旧双轨缓存没有返回单文件播放地址");
  const legacyRecord = await get(legacyId);
  assert(legacyRecord.merged?.totalBytes === mergedRecord.merged.totalBytes, "播放旧缓存时没有合并为单文件");
  assert((await getChunks(legacyId, "video")).length === 0, "升级后没有释放源视频轨");
  const legacyBytes = new Uint8Array(await (await fetch(legacyPlayback.playbackUrl)).arrayBuffer());
  assert(legacyBytes.length === legacyRecord.merged.totalBytes, "升级后的单文件字节数不正确");

  // 5) 只有单文件 MP4 的视频：仅音频会整段下载后无损抽出音轨，并释放视频数据。
  mark("extract-progressive");
  const progressiveId = `BV1merge:100:a:progressive-${stamp}`;
  created.push(progressiveId);
  const progressivePlayurl = {
    quality: 32,
    accept_quality: [32],
    accept_description: ["480P"],
    support_formats: [{ quality: 32, display_desc: "480P" }],
    format: "mp4",
    timelength: 18901,
    durl: [{ size: PROGRESSIVE.length, url: "https://fixtures.test/fixtures/progressive-avc-aac.mp4" }]
  };
  const startProgressive = await send({
    type: "START_DOWNLOAD",
    video: {
      id: progressiveId,
      pageId: "BV1merge:100",
      bvid: "BV1merge",
      cid: 100,
      title: "单文件 MP4 提取音轨集成测试",
      duration: 19,
      cacheMode: "audio",
      requestedQuality: 32,
      requestedQualityExplicit: true,
      requestedCodec: "auto",
      playurlData: progressivePlayurl,
      updatedAt: Date.now()
    }
  });
  assert(startProgressive.ok && startProgressive.started, `单文件提取任务没有启动：${JSON.stringify(startProgressive)}`);

  const extractedRecord = await waitFor(async () => {
    const record = await get(progressiveId);
    if (record?.status === "error") throw new Error(record.error);
    return record?.status === "complete" ? record : null;
  }, 30000);

  assert(extractedRecord.mediaKind === "audio", "提取后应成为仅音频记录");
  assert(extractedRecord.cacheMode === "audio", "提取后应保留仅音频缓存模式");
  assert(extractedRecord.extractedFrom?.mediaBytes === PROGRESSIVE.length, "没有记录被提取的源文件字节数");
  assert(extractedRecord.tracks?.audio?.totalBytes > 0 && extractedRecord.tracks.audio.totalBytes < PROGRESSIVE.length, "音轨体积应小于整段 MP4");
  assert(extractedRecord.tracks.audio.codecs === "mp4a.40.2", `提取出的 codec 不正确：${extractedRecord.tracks.audio.codecs}`);
  assert(extractedRecord.tracks.audio.mimeType === "audio/mp4", "提取出的容器不正确");
  assert(extractedRecord.downloadedBytes === extractedRecord.totalBytes, "提取后完成字节数不一致");
  assert((await getChunks(progressiveId, "media")).length === 0, "提取后应释放整段 MP4 分块");
  const extractedChunks = await getChunks(progressiveId, "audio");
  const extractedBytes = new Uint8Array(await new Blob(extractedChunks.map((chunk) => chunk.data)).arrayBuffer());
  assert(extractedBytes.length === extractedRecord.tracks.audio.totalBytes, "提取出的音频字节数不一致");
  assert(listBoxes(extractedBytes).map((box) => box.type).join(",") === "ftyp,moov,mdat", "提取结果应只有一条音轨的单文件");

  const extractedPlayback = await send({ type: "GET_PLAYBACK_URL", videoId: progressiveId });
  assert(typeof extractedPlayback.playbackUrl === "string", "提取出的音轨没有返回播放地址");
  const savedAudio = new Uint8Array(await (await fetch(extractedPlayback.playbackUrl)).arrayBuffer());
  assert(savedAudio.length === extractedBytes.length, "播放地址返回的字节数不正确");
  const audioElement = document.createElement("video");
  audioElement.muted = true;
  audioElement.preload = "auto";
  document.body.append(audioElement);
  const audioPlaybackResult = await probePlayback(audioElement, extractedPlayback.playbackUrl);
  assert(audioPlaybackResult.decodedAudioBytes > 0, `提取出的音轨没有解出音频：${JSON.stringify(audioPlaybackResult)}`);
  assert(audioPlaybackResult.decodedVideoFrames === 0, "提取出的音轨不应包含视频帧");

  document.querySelector("#result").textContent = JSON.stringify({
    ok: true,
    legacyUpgrade: { totalBytes: legacyRecord.merged.totalBytes, sourceReleased: true },
    progressiveExtraction: {
      sourceBytes: PROGRESSIVE.length,
      audioBytes: extractedRecord.tracks.audio.totalBytes,
      codecs: extractedRecord.tracks.audio.codecs,
      bandwidth: extractedRecord.tracks.audio.bandwidth,
      audioLabel: extractedRecord.audioLabel,
      decodedAudioBytes: audioPlaybackResult.decodedAudioBytes,
      decodedVideoFrames: audioPlaybackResult.decodedVideoFrames
    },
    merged: {
      totalBytes: mergedRecord.merged.totalBytes,
      chunkCount: mergedRecord.merged.chunkCount,
      fragmentTracks,
      audioLabel: mergedRecord.audioLabel
    },
    playback: playbackResult,
    audioOnly: {
      representationId: audioRecord.tracks.audio.representationId,
      codecs: audioRecord.tracks.audio.codecs,
      label: audioRecord.audioLabel,
      bytes: audioOnlyBytes.length
    },
    mergeBroadcasts: broadcasts.filter((message) => String(message.video?.stage || "").includes("merg")).length,
    budget: { acquires: budget.acquireCount, releases: budget.releaseCount }
  }, null, 2);
} catch (error) {
  document.querySelector("#result").textContent = JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2);
} finally {
  for (const id of created) await deleteVideoData(id).catch(() => {});
}

function makePlayurl() {
  const video = { id: 32, codecid: 7, mimeType: "video/mp4", codecs: "avc1.64001F", bandwidth: 200000, baseUrl: "https://fixtures.test/fixtures/dash-video-2frag.mp4" };
  const aac = { id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 154889, baseUrl: "https://fixtures.test/fixtures/audio-192k.mp4" };
  const flac = { id: 30251, mimeType: "audio/mp4", codecs: "fLaC", bandwidth: 1411000, baseUrl: "https://fixtures.test/fixtures/audio-flac.mp4" };
  return {
    quality: 32,
    accept_quality: [32],
    accept_description: ["480P"],
    support_formats: [{ quality: 32, display_desc: "480P" }],
    dash: { duration: 10, video: [video], audio: [aac], flac: { display: true, audio: flac } }
  };
}

function probePlayback(element, url) {
  return new Promise((resolve) => {
    const state = { duration: 0, currentTime: 0, decodedVideoFrames: 0, decodedAudioBytes: 0, error: "" };
    element.addEventListener("error", () => {
      state.error = element.error ? String(element.error.message) : "媒体加载失败";
    });
    element.addEventListener("loadedmetadata", () => {
      state.duration = element.duration;
    });
    element.src = url;
    element.play().catch((error) => {
      state.error = String(error.message);
    });
    setTimeout(() => {
      state.currentTime = Number(element.currentTime.toFixed(2));
      state.decodedVideoFrames = element.webkitDecodedFrameCount || 0;
      state.decodedAudioBytes = element.webkitAudioDecodedByteCount || 0;
      element.pause();
      element.removeAttribute("src");
      element.load();
      element.remove();
      resolve(state);
    }, 2500);
  });
}

async function get(videoId) {
  const response = await send({ type: "GET_VIDEO", videoId });
  return response.video || null;
}

function send(message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("消息超时：" + message.type)), timeoutMs);
    messageListener({ target: "offscreen", ...message }, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function waitFor(check, timeout = 2000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error("等待集成测试结果超时");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
