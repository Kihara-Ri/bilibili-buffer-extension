import { getChunks, getVideo, putChunk, putVideo } from "../src/db.js";
import { DOWNLOAD_WATCHDOG_ALARM } from "../src/download-retry.js";

// 使用真实 SW/Offscreen 入口和浏览器 IndexedDB，由夹具暂停播放清单的返回。
const listeners = [];
const alarmListeners = [];
const alarms = new Map();
const sources = new Map();
const MiB = 1024 * 1024;
const cacheCapacity = 8 * 1024 * MiB;
const tabRemoved = [];
const downloadChanged = [];
const tabs = new Map();
const downloads = new Map();
let finishExportOnStart = false;
const playbackSender = {
  id: "fixture-extension", frameId: 0, documentId: "bili-page",
  url: "https://www.bilibili.com/video/BV1fixture/", tab: { id: 7 }
};
const createStorage = () => {
  const area = {};
  return {
    async get(key) { return { [key]: structuredClone(area[key]) }; },
    async set(values) { Object.assign(area, structuredClone(values)); }
  };
};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    onInstalled: { addListener() {} },
    onConnect: { addListener() {} },
    getURL(path) { return "chrome-extension://test/" + path; },
    async getContexts() { return [{}]; },
    sendMessage: dispatch
  },
  storage: { local: createStorage(), session: createStorage() },
  cookies: { async get() { return null; }, onChanged: { addListener() {} } },
  alarms: {
    onAlarm: { addListener(listener) { alarmListeners.push(listener); } },
    async create(name, options) {
      alarms.set(name, { ...options, scheduledTime: options.when || Date.now() + options.delayInMinutes * 60_000 });
    },
    async get(name) { return alarms.get(name); },
    async clear(name) { return alarms.delete(name); }
  },
  tabs: {
    onRemoved: { addListener(listener) { tabRemoved.push(listener); } },
    async create({ url }) {
      const tab = { id: tabs.size + 100, url };
      tabs.set(tab.id, tab);
      return tab;
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error("Tab closed");
      return tabs.get(id);
    }
  },
  downloads: {
    onChanged: { addListener(listener) { downloadChanged.push(listener); } },
    async download() {
      const id = downloads.size + 200;
      downloads.set(id, { id, state: "in_progress" });
      if (finishExportOnStart) finishExport(id, "complete");
      return id;
    },
    async search({ id, state }) {
      return [...downloads.values()].filter(item => (id == null || item.id === id) && (!state || item.state === state));
    }
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} }
};
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(input.url || input, location.href);
  if (url.hostname === "api.bilibili.com" && url.pathname.endsWith("/playurl")) {
    const cid = Number(url.searchParams.get("cid"));
    const source = sources.get(cid);
    assert(source, "取源必须使用测试任务的 CID");
    source.manifestRequests++;
    source.requested.resolve();
    await source.release.promise;
    return Response.json({
      code: 0,
      data: manifest(cid)
    });
  }
  if (url.hostname === "task-control.test") {
    const cid = Number(url.pathname.split(".")[0].slice(1));
    const source = sources.get(cid);
    source.mediaRequests++;
    if (source.fetch) return source.fetch(init);
    if (source.rejectMedia) return new Response(null, { status: 403 });
    return new Response(new Uint8Array(8), { status: 206, headers: { "Content-Range": "bytes 0-7/8" } });
  }
  return nativeFetch(input, init);
};

await import("../src/offscreen.js");
await import("../src/background.js");
chrome.runtime.id = playbackSender.id;

const tests = [];
for (const [cid, command, status] of [[901, "PAUSE_CACHE", "paused"], [902, "DELETE_VIDEO", undefined]]) {
  await scenario("手动继续取源时执行 " + command, async () => {
    const { video, source } = await seed(cid);
    const resumed = send("RESUME_CACHE", video.id);
    await waitFor(source.requested.promise, "手动继续未开始取源");
    try {
      const stopped = await waitFor(send(command, video.id), "停止操作被取源阻塞");
      assert(stopped?.ok && (stopped.paused || stopped.deleted), "停止未生效");
    } finally {
      source.release.resolve();
    }
    await resumed;
    await assertStopped(video.id, source, status);
    await send("DELETE_VIDEO", video.id);
    assert(!(await send("RESUME_CACHE", video.id))?.ok, "继续不能创建已删除的任务");
  });
}

for (const [cid, command, status] of [[903, "PAUSE_CACHE", "paused"], [904, "DELETE_VIDEO", undefined]]) {
  await scenario("看门狗取源时执行 " + command, async () => {
    const { video, source } = await seed(cid, { status: "downloading", nextRetryAt: Date.now() - 1 });
    onAlarm({ name: DOWNLOAD_WATCHDOG_ALARM });
    await waitFor(source.requested.promise, "看门狗未处理已到期任务");
    try {
      const stopped = await waitFor(send(command, video.id), "看门狗取源阻塞了手动命令");
      assert(stopped?.ok, "手动停止未生效");
    } finally {
      source.release.resolve();
    }
    await assertStopped(video.id, source, status);
    await send("DELETE_VIDEO", video.id);
  });
}

await scenario("自动重试和重复继续共享同一个下载世代", async () => {
  const { video, source } = await seed(905, { status: "downloading", nextRetryAt: Date.now() - 1, autoRetryCount: 2 });
  onAlarm({ name: DOWNLOAD_WATCHDOG_ALARM });
  await waitFor(source.requested.promise, "看门狗未开始取源");
  const resumes = [send("RESUME_CACHE", video.id), send("RESUME_CACHE", video.id)];
  try {
    const [first, second] = await waitFor(Promise.all(resumes), "重复继续阻塞在额外取源请求上");
    assert(first?.ok && second?.ok, "重复继续返回失败");
    assert(first.video.runStartedAt === second.video.runStartedAt && first.video.runStartedAt > 10, "重复继续生成了不同世代");
    assert(source.manifestRequests === 1, "同一个任务发起了重复取源");
  } finally {
    source.release.resolve();
    await Promise.allSettled(resumes);
  }
  await until(async () => (await getVideo(video.id))?.status === "complete", "唯一任务未完成");
  await send("DELETE_VIDEO", video.id);
});

await scenario("签名刷新等待期间可以暂停，迟到的地址不会重新下载", async () => {
  const { video, source } = await seed(906);
  source.rejectMedia = true;
  const started = await dispatch({ target: "offscreen", type: "START_DOWNLOAD", video: { ...video, playurlData: manifest(video.cid) } });
  assert(started?.started, "签名刷新场景未启动");
  await waitFor(source.requested.promise, "分块错误未触发进程内自动刷新", 4000);
  const requests = source.mediaRequests;
  try {
    assert((await waitFor(send("PAUSE_CACHE", video.id), "暂停等待了签名刷新")).paused, "未进入暂停状态");
  } finally {
    source.rejectMedia = false;
    source.release.resolve();
  }
  await assertStopped(video.id, source, "paused", requests);
  await send("DELETE_VIDEO", video.id);
});

await scenario("迟到的暂停、继续与补删只针对原记录", async () => {
  const { video, source } = await seed(907);
  await send("DELETE_VIDEO", video.id, { createdAt: video.createdAt });
  const started = await dispatch({ target: "offscreen", type: "START_DOWNLOAD", video });
  assert(started.started && started.video.createdAt > video.createdAt, "重新缓存未创建新世代");
  await waitFor(source.requested.promise, "新任务未开始取源");
  try {
    const target = { createdAt: video.createdAt };
    const results = await Promise.all([
      send("PAUSE_CACHE", video.id, target),
      send("RESUME_CACHE", video.id, target),
      send("DELETE_VIDEO", video.id, target)
    ]);
    assert(!results[0].paused && !results[1].ok && !results[2].deleted, "旧命令作用到了重新缓存的任务");
    const current = await getVideo(video.id);
    assert(current.status === "downloading" && current.runStartedAt === started.video.runStartedAt, "旧命令改变了新任务状态");
  } finally {
    source.release.resolve();
  }
  await until(async () => (await getVideo(video.id))?.status === "complete", "新任务未完成");
  await send("DELETE_VIDEO", video.id);
});

await scenario("自动重试遵守退避，手动继续无需等到期", async () => {
  const future = Date.now() + 120_000;
  const { video, source } = await seed(908, { status: "downloading", nextRetryAt: future, autoRetryCount: 2 });
  await dispatch({ target: "offscreen", type: "RECOVER_DOWNLOADS" });
  assert(source.manifestRequests === 0 && (await getVideo(video.id)).nextRetryAt === future, "看门狗提前消耗退避");
  const resume = await send("RESUME_CACHE", video.id, { createdAt: video.createdAt, tabId: 7 });
  await waitFor(source.requested.promise, "手动继续等待了退避");
  assert(resume.video.nextRetryAt === 0 && resume.video.autoRetryCount === 0, "手动继续未重置退避");
  assert(resume.video.tabId === 7, "当前视频继续时丢失了播放页");
  await send("DELETE_VIDEO", video.id);
  source.release.resolve();
  await assertStopped(video.id, source);
});

await scenario("更新冻结能中止取源，解锁后的手动暂停优先于更新恢复", async () => {
  const { video, source } = await seed(909);
  const second = await seed(910);
  await Promise.all([send("RESUME_CACHE", video.id), send("RESUME_CACHE", second.video.id)]);
  await waitFor(Promise.all([source.requested.promise, second.source.requested.promise]), "冻结前未开始取源");
  try {
    const locked = await waitFor(dispatch({ target: "offscreen", type: "LOCK_FOR_UPDATE" }), "更新等待了迟到清单");
    assert(locked.pausedIds.includes(video.id) && locked.pausedIds.includes(second.video.id), "冻结未登记需恢复的暂停");
    assert(!(await send("RESUME_CACHE", video.id))?.ok, "更新锁允许新任务");
    await dispatch({ target: "offscreen", type: "UNLOCK_FOR_UPDATE" });
    await send("PAUSE_CACHE", video.id);
    const resumed = await dispatch({ target: "offscreen", type: "RESUME_DOWNLOAD", videoId: video.id, afterUpdate: true });
    assert(resumed.ok && !resumed.started, "恢复更新覆盖了手动暂停");
    const restored = await dispatch({ target: "offscreen", type: "RESUME_DOWNLOAD", videoId: second.video.id, afterUpdate: true });
    assert(restored.ok && restored.started, "更新暂停的任务未恢复");
  } finally {
    source.release.resolve();
    second.source.release.resolve();
  }
  await assertStopped(video.id, source, "paused");
  await until(async () => (await getVideo(second.video.id))?.status === "complete", "更新恢复的任务未完成");
  await Promise.all([send("DELETE_VIDEO", video.id), send("DELETE_VIDEO", second.video.id)]);
});

await scenario("三个缓存任务共用离线连接预算，暂停后队首接手", async () => {
  const { rows, held, peak, maxBytes } = await startTransfers([911, 912, 913]);
  try {
    await until(() => held.size >= 8, "离线连接未填满");
    await new Promise(resolve => setTimeout(resolve, 80));
    const manifests = rows.map(({ source }) => source.manifestRequests);
    assert(peak() <= 8 && maxBytes() <= 24 * MiB && manifests.reduce((sum, count) => sum + count) === 2,
      `Offscreen 并发失控，峰值 ${peak()} 路、${maxBytes() / MiB} MiB，取源任务 ${manifests.join(",")}`);
    const first = rows.find(({ source }) => source.manifestRequests > 0);
    const queued = rows.find(({ source }) => source.manifestRequests === 0);
    await send("PAUSE_CACHE", first.video.id);
    await until(() => queued.source.manifestRequests === 1 && held.size >= 8, "暂停后排队任务没有接手");
    return { peakRequests: peak(), peakNetworkMiB: maxBytes() / MiB };
  } finally {
    await Promise.all(rows.map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("播放拖动和缓冲告急释放离线连接，缓冲恢复后从同一世代继续", async () => {
  const { rows, held } = await startTransfers([914, 915]);
  const ordinarySender = { ...playbackSender, documentId: "ordinary-document" };
  const pressure = (level, sender = playbackSender, fullSpeed = false) =>
    dispatch({ target: "offscreen", type: "PLAYBACK_PRESSURE", level, fullSpeed, sampledAt: Date.now() }, sender);
  try {
    await until(() => held.size >= 8, "未制造离线满载");
    const versions = await Promise.all(rows.map(async ({ video }) => (await getVideo(video.id)).runStartedAt));
    await pressure("urgent", { ...playbackSender, frameId: 2 });
    assert(held.size >= 8, "子帧可以干预离线调度");
    await pressure("urgent");
    await until(() => held.size === 0, "网页急需分块时离线连接仍被占用");
    await pressure("playing");
    await until(() => held.size === 2, "稳定播放时离线应以两路恢复");
    await new Promise(resolve => setTimeout(resolve, 80));
    assert(held.size === 2, "播放期间离线并发再次叠加");
    await pressure("playing", playbackSender, true);
    await until(() => held.size === 8, "全速缓冲在稳定播放时应能用满共享连接额度");
    await pressure("playing", ordinarySender);
    await until(() => held.size === 2, "普通播放标签的保护不能被全速缓冲覆盖");
    await pressure("urgent", playbackSender, true);
    await until(() => held.size === 0, "全速缓冲也必须为拖动和缓冲告急让行");
    await pressure("idle", ordinarySender);
    await pressure("playing", playbackSender, true);
    await until(() => held.size === 8, "全速缓冲应在缓冲恢复后继续原来的任务");
    await pressure("idle");
    await until(() => held.size === 8, "停止播放后离线额度未恢复");
    const resumed = await Promise.all(rows.map(({ video }) => getVideo(video.id)));
    assert(resumed.every((video, index) => video.status === "downloading" && video.runStartedAt === versions[index] && !video.error),
      "播放让行被当成错误或新一轮下载");
  } finally {
    await pressure("idle", ordinarySender);
    await pressure("idle");
    await Promise.all(rows.map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("整文件回退在缓冲告急时停止拉取正文，恢复后继续同一条流", async () => {
  const { video, source } = await seed(916);
  const sizes = [3 * MiB + 7, 2 * MiB + 3];
  const firstRead = deferred(), bodyReady = deferred();
  let pulls = 0, transfers = 0, transferPriority;
  source.size = sizes[0] + sizes[1];
  source.fetch = async ({ headers, priority }) => {
    if (headers?.Range) return new Response(null, { status: 200 });
    transfers++;
    transferPriority = priority;
    return new Response(new ReadableStream({
      async pull(controller) {
        const index = pulls++;
        if (index === 0) {
          firstRead.resolve();
          await bodyReady.promise;
        }
        controller.enqueue(new Uint8Array(sizes[index]).fill(index + 1));
        if (index === sizes.length - 1) controller.close();
      }
    }, { highWaterMark: 0 }), { headers: { "Content-Length": String(source.size) } });
  };
  source.release.resolve();
  const pressure = level => dispatch({ target: "offscreen", type: "PLAYBACK_PRESSURE", level, sampledAt: Date.now() }, playbackSender);
  try {
    await send("RESUME_CACHE", video.id);
    await waitFor(firstRead.promise, "Range 被忽略后未启用整文件回退");
    await pressure("urgent");
    bodyReady.resolve();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert(pulls === 1, "网页缓冲告急时仍在拉取顺序正文");
    await pressure("playing");
    await until(async () => (await getVideo(video.id))?.status === "complete", "顺序流未继续到完成");
    const chunks = await getChunks(video.id, "media");
    const stored = new Uint8Array(await new Blob(chunks.map(row => row.data)).arrayBuffer());
    assert(transfers === 1 && stored.length === source.size && stored[sizes[0] - 1] === 1 && stored[sizes[0]] === 2,
      "顺序流重启、跳块或字节损坏");
    assert(transferPriority === "low", "顺序回退没有使用低优先级");
    assert(chunks[0].data.size === 4 * MiB, "顺序流应用层分块超过预算");
  } finally {
    bodyReady.resolve();
    await pressure("idle");
    await send("DELETE_VIDEO", video.id);
  }
});

await scenario("进页自动启动尊重暂停和看门狗的退避时间", async () => {
  const paused = await seed(917, { automatic: true });
  const waiting = await seed(918, { automatic: true, status: "downloading", nextRetryAt: Date.now() + 120_000 });
  try {
    for (const { video, source } of [paused, waiting]) {
      const result = await dispatch({ target: "offscreen", type: "START_DOWNLOAD", video: { ...video, automatic: true } });
      assert(result.ok && !result.started && result.video.runStartedAt === video.runStartedAt && source.manifestRequests === 0,
        "进页自动启动覆盖了任务控制状态");
    }
  } finally {
    await Promise.all([paused, waiting].map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("自动完整缓存的逻辑空间只回收较早的自动缓存", async () => {
  const completed = finished(cacheCapacity);
  const manual = await seed(919, completed);
  const automatic = await seed(920, { ...completed, automatic: true });
  const next = await seed(921);
  await send("DELETE_VIDEO", next.video.id);
  next.source.release.resolve();
  try {
    const result = await dispatch({ target: "offscreen", type: "START_DOWNLOAD", video: { ...next.video, automatic: true } });
    assert(result.started && result.video.automatic, "自动任务没有归类");
    await until(async () => (await getVideo(next.video.id))?.status === "complete", "自动缓存未完成");
    assert(!(await getVideo(automatic.video.id)) && (await getVideo(manual.video.id))?.status === "complete", "回收误伤手动缓存或遗漏旧自动缓存");
  } finally {
    await Promise.all([manual, automatic, next].map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("本地播放和导出分别持有保护，最后一个消费者关闭或取消才释放", async () => {
  const playing = await seed(922, { ...finished(8), automatic: true, chunkCount: 1 });
  const paused = await seed(923, { ...finished(cacheCapacity - 16), status: "paused", automatic: true });
  await putChunk(playing.video.id, "media", 0, new Blob([new Uint8Array(8)]));
  const manual = await seed(924, finished(8));
  const old = await seed(932, { ...finished(8), automatic: true, completedAt: Date.now() - 60_000 });
  const admitted = [];
  try {
    const opened = await send("OPEN_CACHED_VIDEO", playing.video.id);
    const exported = await send("SAVE_VIDEO", playing.video.id);
    assert(opened.ok && exported.ok, "本地播放或导出无法开始");
    admitted.push(await startAutomatic(925, "complete"));
    assert(!(await getVideo(old.video.id)) && (await getVideo(playing.video.id))?.status === "complete",
      "压力下应回收旧自动缓存，同时保护正在使用的缓存");
    assert((await getVideo(manual.video.id))?.status === "complete", "回收误伤手动片库");
    await send("DELETE_VIDEO", admitted.at(-1).video.id);
    await putVideo({ ...paused.video, ...finished(cacheCapacity - 8), status: "paused" });
    tabs.delete(opened.tabId);
    for (const listener of tabRemoved) listener(opened.tabId);
    admitted.push(await startAutomatic(926, "error"));
    assert((await getVideo(playing.video.id))?.status === "complete", "本地页关闭误释放了尚在进行的导出");
    finishExport(exported.downloadIds[0], "interrupted");
    admitted.push(await startAutomatic(927, "complete"));
    assert(!(await getVideo(playing.video.id)), "关闭本地页且导出取消后仍无法回收自动缓存");
  } finally {
    await Promise.all([playing, paused, manual, old, ...admitted].map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("导出先完成、后登记时也能释放自动缓存", async () => {
  const exported = await seed(928, { ...finished(8), automatic: true, chunkCount: 1 });
  const paused = await seed(929, { ...finished(cacheCapacity - 8), status: "paused", automatic: true });
  await putChunk(exported.video.id, "media", 0, new Blob([new Uint8Array(8)]));
  try {
    finishExportOnStart = true;
    assert((await send("SAVE_VIDEO", exported.video.id)).ok, "快速导出没有开始");
    await startAutomatic(930, "complete");
    assert(!(await getVideo(exported.video.id)), "早于登记的导出完成事件没有释放保护");
  } finally {
    finishExportOnStart = false;
    await Promise.all([exported.video.id, paused.video.id, "BVcontrol:930:q16:cauto"].map(id => send("DELETE_VIDEO", id)));
  }
});

await scenario("整片重封装先给源轨和输出同时留空间，再写入成品", async () => {
  const [videoBlob, audioBlob] = await Promise.all(["video", "audio"].map(async role =>
    (await fetch("./fixtures/dash-" + role + "-2frag.mp4")).blob()));
  const track = blob => ({ totalBytes: blob.size, downloadedBytes: blob.size, resumeBytes: blob.size, chunkCount: 1 });
  const sourceBytes = videoBlob.size + audioBlob.size;
  const dash = await seed(933, { ...finished(sourceBytes), automatic: true, mediaKind: "dash",
    tracks: { video: track(videoBlob), audio: track(audioBlob) } });
  const old = await seed(934, { ...finished(sourceBytes), automatic: true });
  const paused = await seed(935, { ...finished(cacheCapacity - sourceBytes * 2), status: "paused", automatic: true });
  await Promise.all([putChunk(dash.video.id, "video", 0, videoBlob), putChunk(dash.video.id, "audio", 0, audioBlob)]);
  try {
    const loaded = await send("GET_PLAYBACK_URL", dash.video.id);
    assert(loaded.ok && loaded.playbackUrl && loaded.video.merged, "重封装没有产生可播放的成品");
    assert(!(await getVideo(old.video.id)), "成品写入前没有为额外磁盘占用回收空间");
    assert((await getVideo(paused.video.id))?.status === "paused", "重封装回收误删暂停的任务");
    assert((await getChunks(dash.video.id, "video")).length === 0, "成品成功发布后没有释放源轨");
  } finally {
    await Promise.all([dash, old, paused].map(({ video }) => send("DELETE_VIDEO", video.id)));
  }
});

await scenario("中断后留在磁盘的临时成品仍计入自动缓存预算", async () => {
  const interrupted = await seed(936, { ...finished(8), status: "error", automatic: true,
    remux: { track: "merged", sourceBytes: 8, bytes: 8 } });
  const paused = await seed(937, { ...finished(cacheCapacity - 16), status: "paused", automatic: true });
  await putChunk(interrupted.video.id, "merged", 0, new Blob([new Uint8Array(8)]));
  try {
    await startAutomatic(938, "complete");
    assert(!(await getVideo(interrupted.video.id)) && !(await getChunks(interrupted.video.id, "merged")).length,
      "重启后的临时占用没有计入预算，或回收未清除临时分块");
  } finally {
    await Promise.all([interrupted.video.id, paused.video.id, "BVcontrol:938:q16:cauto"].map(id => send("DELETE_VIDEO", id)));
  }
});

document.querySelector("#result").textContent = JSON.stringify({ ok: tests.every(test => test.ok), tests });

function finished(bytes) {
  return { status: "complete", totalBytes: bytes, committedBytes: bytes, resumeBytes: bytes, downloadedBytes: bytes };
}

function finishExport(id, state) {
  downloads.get(id).state = state;
  for (const listener of downloadChanged) listener({ id, state: { current: state } });
}

async function startAutomatic(cid, expected) {
  const row = await seed(cid);
  await send("DELETE_VIDEO", row.video.id);
  row.source.release.resolve();
  const result = await dispatch({ target: "offscreen", type: "START_DOWNLOAD", video: { ...row.video, automatic: true } });
  assert(result.started, "自动任务没有启动");
  await until(async () => ["complete", "error"].includes((await getVideo(row.video.id))?.status), "自动任务未进入终态");
  const status = (await getVideo(row.video.id)).status;
  if (status !== expected) await send("DELETE_VIDEO", row.video.id);
  assert(status === expected, `自动任务空间分配应为 ${expected}，实际为 ${status}`);
  return row;
}
async function scenario(name, fn) {
  try { tests.push({ name, ok: true, ...await fn() }); }
  catch (error) { tests.push({ name, ok: false, error: String(error?.stack || error) }); }
}

function onAlarm(alarm) {
  for (const listener of alarmListeners) listener(alarm);
}

function dispatch(message, sender = {}) {
  return new Promise(resolve => {
    for (const listener of listeners) if (listener(message, sender, resolve)) return;
    resolve(undefined);
  });
}

function send(type, videoId, args) {
  return dispatch({ target: "background", type, videoId, ...args });
}

function manifest(cid) {
  return { quality: 16, format: "mp4", durl: [{ url: "https://task-control.test/" + cid + ".mp4", size: sources.get(cid)?.size || 8 }] };
}

async function startTransfers(cids) {
  const rows = await Promise.all(cids.map(cid => seed(cid)));
  const held = new Map();
  let peak = 0;
  let maxBytes = 0;
  for (const { source } of rows) {
    source.size = 24 * MiB;
    source.fetch = async ({ headers, signal }) => {
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
      const start = Number(first), end = Math.min(Number(last), source.size - 1);
      const size = end - start + 1;
      if (size <= 64 * 1024) {
        return new Response(new Uint8Array(size), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${source.size}` } });
      }
      signal.throwIfAborted();
      const request = Symbol();
      held.set(request, size);
      peak = Math.max(peak, held.size);
      maxBytes = Math.max(maxBytes, [...held.values()].reduce((sum, value) => sum + value, 0));
      try {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } finally {
        held.delete(request);
      }
    };
    source.release.resolve();
  }
  await Promise.all(rows.map(({ video }) => send("RESUME_CACHE", video.id)));
  return { rows, held, peak: () => peak, maxBytes: () => maxBytes };
}

async function seed(cid, patch = {}) {
  const video = {
    id: "BVcontrol:" + cid + ":q16:cauto", bvid: "BVcontrol", cid, page: 1,
    title: "任务控制测试", mediaKind: "progressive", status: "paused",
    quality: 16, requestedQuality: 16, requestedQualityExplicit: true,
    createdAt: 5, updatedAt: 10, runStartedAt: 10, ...patch
  };
  const source = { requested: deferred(), release: deferred(), manifestRequests: 0, mediaRequests: 0 };
  sources.set(cid, source);
  await putVideo(video);
  return { video, source };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(promise, message, timeout = 1200) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check, message) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function assertStopped(id, source, status, expectedRequests = 0) {
  // 释放迟到的清单响应后，给真实消息处理和数据库事务一个执行机会。
  await new Promise(resolve => setTimeout(resolve, 100));
  const record = await getVideo(id);
  const active = await dispatch({ target: "offscreen", type: "GET_ACTIVE_DOWNLOADS" });
  assert(record?.status === status && !active.videoIds.includes(id), "已停止任务被重新登记或写回");
  assert(source.mediaRequests === expectedRequests, "迟到的播放地址触发了媒体请求");
  if (!status) assert((await getChunks(id)).length === 0, "删除后残留了媒体分块");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
