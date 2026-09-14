import { deleteVideoData, getChunks } from "../src/db.js";

const MiB = 1024 * 1024;
const videoBytes = makeBytes(9 * MiB + 137, 17);
const audioBytes = makeBytes(2 * MiB + 73, 91);
const broadcasts = [];
let messageListener;
let sourceRefreshRequests = 0;

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
      if (message.type === "REFRESH_DOWNLOAD_SOURCE") {
        sourceRefreshRequests += 1;
        return {
          ok: true,
          auth: { hasSessionCookie: false },
          playurlData: makePlayurlData("renewed.test")
        };
      }
      broadcasts.push(message);
      return { ok: true };
    }
  }
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).includes(".test/")) return nativeFetch(url, init);
  const source = String(url).includes("/audio") ? audioBytes : videoBytes;
  const match = String(init.headers?.Range || "").match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return new Response("Range required", { status: 400 });
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), source.length - 1);
  if (!String(url).includes("renewed.test") && start >= 4 * MiB) {
    return new Response("expired", { status: 403 });
  }
  const isBackup = String(url).includes("backup.test");
  const rangeOrdinal = Math.floor(start / (4 * MiB));
  await delay((isBackup ? 4 : 24) + (rangeOrdinal === 0 ? 14 : rangeOrdinal === 1 ? 1 : 7));
  const body = source.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${start}-${end}/${source.length}`
    }
  });
};

await import("../src/offscreen.js");
await waitFor(() => typeof messageListener === "function");

const id = `BV1integration:100:q80:${Date.now()}`;
try {
  const started = await send({
    target: "offscreen",
    type: "START_DOWNLOAD",
    video: {
      id,
      pageId: "BV1integration:100",
      bvid: "BV1integration",
      cid: 100,
      title: "并发范围下载集成测试",
      owner: "测试",
      duration: 60,
      requestedQuality: 80,
      requestedQualityExplicit: true,
      requestedCodec: "auto",
      playurlData: makePlayurlData(),
      auth: { hasSessionCookie: false },
      url: "https://www.bilibili.com/video/BV1integration/",
      updatedAt: Date.now()
    }
  });
  if (!started.ok || !started.started) throw new Error(`任务没有启动：${JSON.stringify(started)}`);

  const completed = await waitFor(async () => {
    const response = await send({ target: "offscreen", type: "GET_VIDEO", videoId: id });
    if (response.video?.status === "error") throw new Error(response.video.error);
    return response.video?.status === "complete" ? response.video : null;
  }, 20000);

  const videoChunks = await getChunks(id, "video");
  const audioChunks = await getChunks(id, "audio");
  const storedVideo = new Uint8Array(await new Blob(videoChunks.map((chunk) => chunk.data)).arrayBuffer());
  const storedAudio = new Uint8Array(await new Blob(audioChunks.map((chunk) => chunk.data)).arrayBuffer());
  assert(equalBytes(storedVideo, videoBytes), "视频轨落盘顺序或字节不正确");
  assert(equalBytes(storedAudio, audioBytes), "音频轨落盘顺序或字节不正确");
  assert(completed.downloadedBytes === videoBytes.length + audioBytes.length, "聚合字节数不正确");
  assert(completed.codec === "av1", "自动编码没有选择同画质下码率最低的 AV1");
  assert(completed.tracks.video.metrics.concurrency >= 1 && completed.tracks.video.metrics.concurrency <= 4, "视频轨并发应在 1 至 4 路以内");
  assert(completed.tracks.audio.metrics.concurrency === 1, "音频轨应使用 1 路并发");
  assert(completed.tracks.video.metrics.cdnHost === "renewed.test", "刷新后没有切换到新视频 CDN");
  assert(completed.tracks.audio.metrics.cdnHost === "renewed.test", "刷新后没有切换到新音频 CDN");
  assert(sourceRefreshRequests >= 1, "签名地址失效后没有刷新播放地址");
  const progress = broadcasts.filter(message => message.type === "CACHE_PROGRESS" && message.video?.status === "downloading");
  assert(progress.length > 0 && progress.every(({video}) => Number.isFinite(video.committedBytes) && video.committedBytes <= video.resumeBytes), "所有下载快照都必须区分确认落盘与在途水位");
  const watermark = new Map();
  for (const { video } of progress) { const run = video.runStartedAt || 0; assert(video.committedBytes >= (watermark.get(run) || 0), "同次下载的确认落盘量不能随网络回滚减少"); watermark.set(run, video.committedBytes); }

  document.querySelector("#result").textContent = JSON.stringify({
    ok: true,
    downloadedBytes: completed.downloadedBytes,
    videoChunks: videoChunks.length,
    audioChunks: audioChunks.length,
    videoMetrics: completed.tracks.video.metrics,
    audioMetrics: completed.tracks.audio.metrics,
    progressEvents: broadcasts.filter((message) => message.type === "CACHE_PROGRESS").length,
    sourceRefreshRequests,
    committedWatermarkVerified: true
  }, null, 2);
} catch (error) {
  document.querySelector("#result").textContent = JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2);
} finally {
  await deleteVideoData(id).catch(() => {});
}

function send(message) {
  return new Promise((resolve) => {
    messageListener(message, {}, resolve);
  });
}

async function waitFor(check, timeout = 2000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeout) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("等待集成测试结果超时");
}

function makeBytes(length, seed) {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) result[index] = (index + seed) % 251;
  return result;
}

function makePlayurlData(host = "primary.test") {
  const backupHost = host === "primary.test" ? "backup.test" : "";
  const track = (path) => ({
    baseUrl: `https://${host}/${path}`,
    backupUrl: backupHost ? [`https://${backupHost}/${path}`] : []
  });
  return {
    quality: 80,
    accept_quality: [80],
    accept_description: ["1080P"],
    support_formats: [{ quality: 80, display_desc: "1080P" }],
    dash: {
      duration: 60,
      video: [
        {
          id: 80,
          codecid: 7,
          mimeType: "video/mp4",
          codecs: "avc1.640032",
          bandwidth: 3_600_000,
          ...track("video")
        },
        {
          id: 80,
          codecid: 13,
          mimeType: "video/mp4",
          codecs: "av01.0.08M.08",
          bandwidth: 1_600_000,
          ...track("video")
        }
      ],
      audio: [{
        id: 30280,
        codecid: 0,
        mimeType: "audio/mp4",
        codecs: "mp4a.40.2",
        bandwidth: 128_000,
        ...track("audio")
      }]
    }
  };
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
