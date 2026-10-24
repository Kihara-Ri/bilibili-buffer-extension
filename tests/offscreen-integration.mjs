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
let transientFailures = 0;
let mediaRequests = 0;
// 暂停场景把每个分块拖慢，确保能在下载中途按下暂停。
let slowMediaMs = 0;
// 与原生 fetch 一样拒绝错误的 this：把 fetch 当作对象方法转交（options.fetchImpl(...)）
// 在真实浏览器里会抛 Illegal invocation，箭头函数桩发现不了这类回归。
globalThis.fetch = async function (url, init = {}) {
  if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  if (!String(url).includes(".test/")) return nativeFetch(url, init);
  mediaRequests += 1;
  const source = String(url).includes("/audio") ? audioBytes : videoBytes;
  const match = String(init.headers?.Range || "").match(/^bytes=(\d+)-(\d+)$/);
  if (!match) return new Response("Range required", { status: 400 });
  const start = Number(match[1]);
  // 视频轨只有 5 块、并发能一次发完：首块之后的分块再多拖一截，保证「已有落盘」时任务确实还在下载，
  // 而不是靠下载文档主线程恰好忙（2.14.0 的镜像 base64 曾无意中提供了这份慢）。
  if (slowMediaMs) await delay(slowMediaMs + (start >= 2 * MiB ? slowMediaMs * 4 : 0));
  const end = Math.min(Number(match[2]), source.length - 1);
  if (!String(url).includes("renewed.test") && start >= 4 * MiB) {
    return new Response("expired", { status: 403 });
  }
  // 地址刷新后，视频轨 8 MiB 处的分块在所有节点上先连续失败 3 次（模拟海外链路抖动），
  // 应在分块内重试消化，而不是让整个任务失败、交给看门狗等一分钟。
  if (String(url).includes("renewed.test") && !String(url).includes("/audio") && start === 8 * MiB && transientFailures < 3) {
    transientFailures += 1;
    return new Response("busy", { status: 503 });
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
  assert(completed.tracks.video.metrics.concurrency >= 1 && completed.tracks.video.metrics.concurrency <= 6, "视频轨并发应在 1 至 6 路以内");
  assert(completed.tracks.audio.metrics.concurrency <= 2, "音频轨最多 2 路并发");
  assert(transientFailures === 3, "抖动场景没有被触发");
  assert(!broadcasts.some((message) => message.type === "CACHE_RETRY" || message.type === "CACHE_ERROR"), "分块级的短暂失败不应让任务失败或交给看门狗");
  assert(completed.tracks.video.metrics.cdnHost === "renewed.test", "刷新后没有切换到新视频 CDN");
  assert(completed.tracks.audio.metrics.cdnHost === "renewed.test", "刷新后没有切换到新音频 CDN");
  // 恰好一次：签名失效触发一次刷新；之后的链路抖动必须在分块内消化，不能再让任务失败去刷新。
  assert(sourceRefreshRequests === 1, `签名失效应刷新恰好一次，实际 ${sourceRefreshRequests} 次`);
  const progress = broadcasts.filter(message => message.type === "CACHE_PROGRESS" && message.video?.status === "downloading");
  assert(progress.length > 0 && progress.every(({video}) => Number.isFinite(video.committedBytes) && video.committedBytes <= video.resumeBytes), "所有下载快照都必须区分确认落盘与在途水位");
  const watermark = new Map();
  for (const { video } of progress) { const run = video.runStartedAt || 0; assert(video.committedBytes >= (watermark.get(run) || 0), "同次下载的确认落盘量不能随网络回滚减少"); watermark.set(run, video.committedBytes); }

  // 复现 2.8.9 修复的竞态：两条 START_DOWNLOAD 在 startDownload 的 getVideo
  // await 窗口内交错时，第二条必须看到占位并返回 started:false，
  // 否则会产生同任务双下载器、先结束的一方还会删掉另一方的注册。
  const raceId = `BV1integration:101:q80:${Date.now()}`;
  const makeRaceVideo = () => ({
    id: raceId,
    pageId: "BV1integration:101",
    bvid: "BV1integration",
    cid: 101,
    title: "并发启动竞态测试",
    owner: "测试",
    duration: 60,
    requestedQuality: 80,
    requestedQualityExplicit: true,
    requestedCodec: "auto",
    playurlData: makePlayurlData(),
    auth: { hasSessionCookie: false },
    url: "https://www.bilibili.com/video/BV1integration/",
    updatedAt: Date.now()
  });
  const firstStart = send({ target: "offscreen", type: "START_DOWNLOAD", video: makeRaceVideo() });
  const secondStart = send({ target: "offscreen", type: "START_DOWNLOAD", video: makeRaceVideo() });
  const [firstRace, secondRace] = await Promise.all([firstStart, secondStart]);
  if (!firstRace.ok || !secondRace.ok) throw new Error(`并发启动失败：${JSON.stringify([firstRace, secondRace])}`);
  if (firstRace.started === secondRace.started) {
    throw new Error(`并发 START_DOWNLOAD 必须恰好启动一个下载器：${JSON.stringify([firstRace.started, secondRace.started])}`);
  }
  await send({ target: "offscreen", type: "DELETE_VIDEO", videoId: raceId });
  await deleteVideoData(raceId).catch(() => {});

  // 暂停 / 继续：暂停后不再发出新的 CDN 请求，记录落为 paused 且保留已落盘字节；
  // 紧接着「继续」（不等暂停收尾）必须真正重新启动，而不是被当成重复启动忽略。
  const pauseId = `BV1integration:102:q80:${Date.now()}`;
  const pauseVideo = () => ({ ...makeRaceVideo(), id: pauseId, pageId: "BV1integration:102", cid: 102, title: "暂停与继续测试", playurlData: makePlayurlData("renewed.test") });
  const readPause = async () => (await send({ target: "offscreen", type: "GET_VIDEO", videoId: pauseId })).video;
  slowMediaMs = 150;
  await send({ target: "offscreen", type: "START_DOWNLOAD", video: pauseVideo() });
  await waitFor(async () => (await readPause())?.committedBytes > 0, 15000);
  const paused = await send({ target: "offscreen", type: "PAUSE_DOWNLOAD", videoId: pauseId });
  assert(paused.ok && paused.paused && paused.video?.status === "paused", `暂停结果不正确：${JSON.stringify(paused)}`);
  assert(paused.video.committedBytes > 0, "暂停必须保留已落盘字节");
  assert(broadcasts.some((message) => message.type === "CACHE_PAUSED" && message.video?.id === pauseId), "暂停没有广播 CACHE_PAUSED");
  const requestsAtPause = mediaRequests;
  await delay(400);
  assert(mediaRequests === requestsAtPause, "暂停后仍在发出 CDN 请求");
  assert((await send({ target: "offscreen", type: "GET_ACTIVE_DOWNLOADS" })).videoIds.every((videoId) => videoId !== pauseId), "暂停后任务仍登记为运行中");

  const resumedOnce = await send({ target: "offscreen", type: "START_DOWNLOAD", video: pauseVideo() });
  assert(resumedOnce.ok && resumedOnce.started, `暂停后的「继续」没有启动：${JSON.stringify(resumedOnce)}`);

  // 竞态：用一个全新的任务，START 返回时分块请求都还在途（每块被拖慢 150 ms），
  // 紧接着「暂停」再「继续」，第二个 START 必须等暂停收尾后真正启动。
  const raceResumeId = `BV1integration:103:q80:${Date.now()}`;
  const raceResumeVideo = () => ({ ...pauseVideo(), id: raceResumeId, pageId: "BV1integration:103", cid: 103 });
  await send({ target: "offscreen", type: "START_DOWNLOAD", video: raceResumeVideo() });
  const pausing = send({ target: "offscreen", type: "PAUSE_DOWNLOAD", videoId: raceResumeId });
  const restarted = await send({ target: "offscreen", type: "START_DOWNLOAD", video: raceResumeVideo() });
  const pausedResult = await pausing;
  assert(pausedResult.paused, `下载中途的暂停没有生效：${JSON.stringify(pausedResult)}`);
  assert(restarted.ok && restarted.started, `暂停收尾期间的「继续」被忽略：${JSON.stringify(restarted)}`);
  // 下载中途删除：在途任务收尾时会写一次「安全水位」快照。若删除不等任务收尾就清数据，
  // 这次写入会把记录连同旧水位写回来，重新缓存时从删除前的位置「续传」，而前面的分块已经没了。
  const deleteId = `BV1integration:104:q80:${Date.now()}`;
  const deleteVideo = () => ({ ...pauseVideo(), id: deleteId, pageId: "BV1integration:104", cid: 104 });
  const readDeleted = async () => (await send({ target: "offscreen", type: "GET_VIDEO", videoId: deleteId })).video;
  await send({ target: "offscreen", type: "START_DOWNLOAD", video: deleteVideo() });
  await waitFor(async () => (await readDeleted())?.committedBytes > 0, 15000);
  const deleted = await send({ target: "offscreen", type: "DELETE_VIDEO", videoId: deleteId });
  assert(deleted.ok && deleted.deleted, `删除失败：${JSON.stringify(deleted)}`);
  await delay(400);
  assert(!(await readDeleted()), "删除后在途任务的收尾写入把记录写回来了");
  assert((await getChunks(deleteId, "video")).length === 0, "删除后仍残留视频分块");
  const restartedAfterDelete = await send({ target: "offscreen", type: "START_DOWNLOAD", video: deleteVideo() });
  assert(restartedAfterDelete.ok && restartedAfterDelete.started, `删除后立即重新缓存被当成重复启动：${JSON.stringify(restartedAfterDelete)}`);
  const firstRun = broadcasts.find((message) => message.video?.id === deleteId && message.video.runStartedAt === restartedAfterDelete.video?.runStartedAt);
  assert(!firstRun || firstRun.video.resumeBytes === 0, "删除后重新缓存必须从 0 开始");
  await send({ target: "offscreen", type: "DELETE_VIDEO", videoId: deleteId });

  slowMediaMs = 0;
  await waitFor(async () => {
    const video = await readPause();
    if (video?.status === "error") throw new Error(video.error);
    return video?.status === "complete";
  }, 30000);
  await waitFor(async () => (await send({ target: "offscreen", type: "GET_VIDEO", videoId: raceResumeId })).video?.status === "complete", 30000);
  for (const taskId of [pauseId, raceResumeId]) {
    const stored = new Uint8Array(await new Blob((await getChunks(taskId, "video")).map((chunk) => chunk.data)).arrayBuffer());
    assert(equalBytes(stored, videoBytes), `暂停后继续得到的视频轨字节不正确：${taskId}`);
    await send({ target: "offscreen", type: "DELETE_VIDEO", videoId: taskId });
    await deleteVideoData(taskId).catch(() => {});
  }

  document.querySelector("#result").textContent = JSON.stringify({
    ok: true,
    downloadedBytes: completed.downloadedBytes,
    videoChunks: videoChunks.length,
    audioChunks: audioChunks.length,
    videoMetrics: completed.tracks.video.metrics,
    audioMetrics: completed.tracks.audio.metrics,
    progressEvents: broadcasts.filter((message) => message.type === "CACHE_PROGRESS").length,
    sourceRefreshRequests,
    pauseResume: true,
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
