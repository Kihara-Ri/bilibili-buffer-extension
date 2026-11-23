import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const extension = fileURLToPath(new URL("../dist/unpacked/", import.meta.url));
const [fixture, dashVideo, dashAudio] = await Promise.all([
  "progressive-avc-aac.mp4", "dash-video-2frag.mp4", "dash-audio-2frag.mp4"
].map(name => readFile(new URL("./fixtures/" + name, import.meta.url))));
const profile = await mkdtemp(tmpdir() + "/hainei-full-buffering-");
const gate = new Map();
const mediaRequests = new Map();
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Expose-Headers", "Content-Range");
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
  const address = new URL(request.url, "http://127.0.0.1");
  const media = /^\/(BV[a-zA-Z0-9]+)(?:-(video|audio))?\.mp4$/.exec(address.pathname);
  if (!media || !match) return response.writeHead(404).end();
  const [, bvid, track] = media;
  const quality = address.searchParams.get("quality");
  const key = quality ? `${bvid}:${quality}` : bvid;
  const bytes = track === "video" ? dashVideo : track === "audio" ? dashAudio : fixture;
  const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
  if (end < start) return response.writeHead(416).end();
  mediaRequests.set(key, (mediaRequests.get(key) || 0) + 1);
  response.writeHead(206, {
    "Content-Type": track === "audio" ? "audio/mp4" : "video/mp4",
    "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1
  });
  // CDN 探针立即完成，正式正文等测试放行。这样可以验证整片未完成时原播放器仍在播。
  if (end - start + 1 > 64 * 1024) await gate.get(key)?.promise;
  if (!response.destroyed) response.end(bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const mediaRoot = `http://127.0.0.1:${server.address().port}/`;
let context;
try {
  context = await chromium.launchPersistentContext(profile, chromiumLaunchOptions({
    headless: true,
    args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension]
  }));
  const base = "https://www.bilibili.com/video/";
  const qualitySwitchControls = `<div class="bpx-player-ctrl-quality">
    <div class="bpx-player-ctrl-quality-result"><span class="bpx-player-ctrl-quality-result-name">480P</span></div>
    <ul><li class="bpx-player-ctrl-quality-menu-item bpx-state-active" data-value="32">480P</li>
    <li class="bpx-player-ctrl-quality-menu-item" data-value="120">4K</li></ul>
  </div><script>
    const items = [...document.querySelectorAll('.bpx-player-ctrl-quality-menu-item')];
    const video = document.querySelector('video');
    const originalSource = video.getAttribute('src');
    const loadNative = source => { video.src = source; void video.play().catch(() => {}); };
    for (const item of items) item.onclick = () => { window.pendingChoice = item.dataset.value; };
    window.confirmMenuChoice = () => {
      for (const item of items) item.classList.toggle('bpx-state-active', item.dataset.value === window.pendingChoice);
      document.querySelector('.bpx-player-ctrl-quality-result-name').textContent = window.pendingChoice === '120' ? '4K' : '480P';
      if (window.pendingChoice === '120' && !video.dataset.biliCachePlayback) {
        loadNative('data:video/mp4;base64,${dashVideo.toString("base64")}');
      }
    };
    window.finishNative480 = () => loadNative(originalSource);
  </script>`;
  await context.route("https://www.bilibili.com/**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><script>
      const videoId = location.pathname.split("/")[2];
      if (videoId !== "BVwhile" && videoId !== "BVdash") window.__playinfo__ = { data: { quality: videoId === "BVswitch" ? 32 : 16 } };
      window.confirmPlayerQuality = quality => fetch("https://api.bilibili.com/x/player/playurl?bvid=" + videoId + "&qn=" + quality).then(response => response.json());
      window.playedBeforeLocal = false;
      document.addEventListener("playing", event => {
        if (event.target instanceof HTMLVideoElement && event.target.dataset.biliCachePlayback !== "local") window.playedBeforeLocal = true;
      }, true);
    </script></head><body><video controls autoplay muted src="data:video/mp4;base64,${fixture.toString("base64")}"></video>${route.request().url().includes("/BVswitch/") ? qualitySwitchControls : ""}</body></html>`
  }));
  const selectedQuality = bvid => bvid === "BVdash" ? 120 : bvid === "BVwhile" ? 32 : 16;
  const playurl = (bvid, quality = selectedQuality(bvid)) => ({
    code: 0, data: bvid === "BVdash" ? {
      quality: selectedQuality(bvid), accept_quality: [125, 120], dash: {
        duration: 10,
        video: [125, 120].map(id => ({ id, codecid: 7, mimeType: "video/mp4", codecs: "avc1.64001F", bandwidth: 200000, baseUrl: mediaRoot + bvid + "-video.mp4" })),
        audio: [{ id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 154889, baseUrl: mediaRoot + bvid + "-audio.mp4" }]
      }
    } : {
      quality, format: "mp4",
      durl: [{ url: mediaRoot + bvid + ".mp4" + (bvid === "BVswitch" ? `?quality=${quality}` : ""), size: fixture.length }]
    }
  });
  await context.route("https://api.bilibili.com/x/player/playurl?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const bvid = params.get("bvid");
    return route.fulfill({
      json: playurl(bvid, ["BVrace", "BVswitch"].includes(bvid) ? Number(params.get("qn")) : selectedQuality(bvid)),
      headers: { "Access-Control-Allow-Origin": "https://www.bilibili.com", "Access-Control-Allow-Credentials": "true" }
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(playurls => {
    const fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      const url = new URL(input.url || input);
      if (url.hostname !== "api.bilibili.com") return fetchOriginal(input, options);
      const bvid = url.searchParams.get("bvid");
      if (url.pathname.endsWith("/playurl")) {
        const payload = structuredClone(playurls[bvid]);
        if (["BVrace", "BVswitch"].includes(bvid)) {
          const quality = url.searchParams.get("qn");
          payload.data.quality = Number(quality);
          if (bvid === "BVswitch") payload.data.durl[0].url = payload.data.durl[0].url.replace(/quality=\d+/, `quality=${quality}`);
        }
        return Response.json(payload);
      }
      if (bvid === "BVrace" && !globalThis.releaseQualityView) {
        await new Promise(resolve => { globalThis.releaseQualityView = resolve; });
      }
      return Promise.resolve(Response.json({ code: 0, data: {
        bvid, title: bvid, pages: [{ cid: 11, page: 1, duration: 19 }]
      } }));
    };
  }, Object.fromEntries(["BVadaptive", "BVnext", "BVwhile", "BVlegacy", "BVdash", "BVrace", "BVswitch"].map(bvid => [bvid, playurl(bvid)])));

  const panel = await context.newPage();
  await panel.goto("chrome-extension://" + new URL(worker.url()).hostname + "/popup.html");
  const open = async bvid => {
    const page = await context.newPage();
    await page.goto(base + bvid + "/");
    await page.bringToFront();
    await page.waitForFunction(() => document.documentElement.dataset.biliBufferContentReady);
    return page;
  };
  const getTask = bvid => panel.evaluate(async bvid => {
    const result = await chrome.runtime.sendMessage({ target: "background", type: "LIST_VIDEOS" });
    return result.videos?.find(video => video.bvid === bvid);
  }, bvid);
  const configure = async mode => {
    await panel.bringToFront();
    const modes = panel.locator("#assist-buffer-mode");
    if (!await modes.isVisible()) await panel.locator("#settings-button").click();
    await modes.locator(`input[value="${mode}"]`).click();
    await until(() => panel.evaluate(async mode => {
      const stored = await chrome.storage.local.get("playbackAssistConfigV1");
      return stored.playbackAssistConfigV1?.bufferMode === mode;
    }, mode), "进页默认策略没有保存");
  };

  const adaptive = await open("BVadaptive");
  await adaptive.waitForFunction(() => document.querySelector("video").currentTime > 0.15);
  assert.equal(await getTask("BVadaptive"), undefined, "默认播放不应自动创建整片任务");
  gate.set("BVadaptive", deferred());
  // 打开不抢走视频焦点的弹窗页面，沿生产的当前视频按钮、内容脚本和 Offscreen 链路验证。
  const quickPopupPage = context.waitForEvent("page");
  await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false }));
  const quickPopup = await quickPopupPage;
  const quickCache = quickPopup.getByRole("button", { name: /边播边缓存|Cache while watching/ });
  await quickCache.waitFor({ state: "visible" });
  await quickCache.evaluate(button => button.click());
  const quickTask = await until(() => getTask("BVadaptive"), "自适应下的一键缓存没有创建整片任务");
  assert.equal(quickTask.requestedQuality, 16, "一键缓存必须跟随播放器档位");
  assert.equal(quickTask.status, "downloading");
  await quickCache.waitFor({ state: "hidden" });
  assert.equal(await quickPopup.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ target: "background", type: "GET_ASSIST_STATE" });
    return state.config.bufferMode;
  }), "adaptive", "一键缓存不应修改进页默认");
  gate.get("BVadaptive").resolve();
  await expectWholeLocal(adaptive);
  await quickPopup.close();
  await adaptive.goto(base + "BVnext/");
  await adaptive.waitForFunction(() => document.querySelector("video").currentTime > 0.15);
  assert.equal(await getTask("BVnext"), undefined, "切到下一条视频应恢复进页默认");
  await adaptive.close();

  // 从弹窗实际选择档位，进页后验证自动任务使用保存的策略。
  await configure("full-speed");
  gate.set("BVwhile", deferred());
  const whilePlaying = await open("BVwhile");
  await whilePlaying.waitForFunction(() => document.querySelector("video").currentTime > 0.15);
  await delay(400);
  assert.equal(await getTask("BVwhile"), undefined, "播放器画质还未确认时不能创建整片任务");
  assert.equal(mediaRequests.get("BVwhile"), undefined, "等待画质时不能向 CDN 启动整片请求");
  await whilePlaying.evaluate(() => window.confirmPlayerQuality(32));
  const whileTask = await until(() => getTask("BVwhile"), "全速缓冲没有在进页时自动启动");
  assert.equal(whileTask.status, "downloading");
  assert.equal(whileTask.requestedQuality, 32);
  assert.equal(whileTask.requestedQualityExplicit, true);
  await until(() => (mediaRequests.get("BVwhile") || 0) >= 2, "全速缓冲没有在播放中开始读取整片正文");
  await until(() => worker.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url });
    return /^\d{1,2}$/.test(await chrome.action.getBadgeText({ tabId: tab.id }));
  }, whilePlaying.url()), "工具栏图标应显示缓存进度");
  assert.equal(await whilePlaying.locator(".bili-buffer-full-status").count(), 0, "缓存中不应在播放器右下角重复显示进度");
  const beforeCompletion = await whilePlaying.locator("video").evaluate(video => video.currentTime);
  await whilePlaying.waitForFunction(previous => window.playedBeforeLocal && document.querySelector("video").currentTime > previous + 0.15, beforeCompletion);
  assert.equal((await getTask("BVwhile")).status, "downloading", "缓存未完成时原播放器继续播放");
  await whilePlaying.evaluate(() => { document.querySelector("video").playbackRate = 1.5; });
  gate.get("BVwhile").resolve();
  await expectWholeLocal(whilePlaying);
  assert.equal(await whilePlaying.locator(".bili-buffer-full-status").count(), 0, "自动切到本地后仍应保留干净的播放画面");
  assert.equal(await whilePlaying.locator("video").evaluate(video => video.playbackRate), 1.5);
  const whileRequests = mediaRequests.get("BVwhile");
  await whilePlaying.reload();
  await whilePlaying.evaluate(() => window.confirmPlayerQuality(32));
  await expectWholeLocal(whilePlaying);
  assert.equal((await getTask("BVwhile")).createdAt, whileTask.createdAt);
  assert.equal(mediaRequests.get("BVwhile"), whileRequests, "重开已有整片的页面应直接复用");
  await whilePlaying.close();

  // 第一轮收到 360P 后卡在后台取 CID。第二次选择必须在交给 Offscreen 前替代它。
  const changing = await open("BVrace");
  await until(() => worker.evaluate(() => Boolean(globalThis.releaseQualityView)), "初次选择未触发取 CID");
  await changing.evaluate(() => window.confirmPlayerQuality(32));
  await changing.waitForFunction(() => document.documentElement.dataset.biliBufferQuality === "32");
  await worker.evaluate(() => { globalThis.releaseQualityView(); });
  await expectWholeLocal(changing);
  const raceTasks = await panel.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ target: "background", type: "LIST_VIDEOS" });
    return result.videos.filter(video => video.bvid === "BVrace").map(video => video.requestedQuality);
  });
  assert.deepEqual(raceTasks, [32], "查 CID 期间换画质后不能登记旧档位");
  await changing.close();

  // 播放器复用旧清单，只在菜单里更新选中项。分别控制两个任务的完成次序。
  gate.set("BVswitch:32", deferred());
  gate.set("BVswitch:120", deferred());
  const switching = await open("BVswitch");
  const findSwitchTask = quality => panel.evaluate(async quality => {
    const result = await chrome.runtime.sendMessage({ target: "background", type: "LIST_VIDEOS" });
    return result.videos.find(video => video.bvid === "BVswitch" && video.requestedQuality === quality);
  }, quality);
  await until(() => (mediaRequests.get("BVswitch:32") || 0) >= 2, "480P 任务没有开始下载正文");
  await switching.locator('[data-value="120"]').click();
  gate.get("BVswitch:32").resolve();
  await until(async () => (await findSwitchTask(32))?.status === "complete", "切档途中 480P 没有落盘");
  await delay(300);
  assert.equal(await switching.locator("video").getAttribute("data-bili-cache-playback"), null, "切档尚未确认时旧 480P 完成不能换源");
  await switching.evaluate(() => window.confirmMenuChoice());
  assert.equal((await until(() => findSwitchTask(120), "站点复用旧清单时选了 4K 仍需启动对应任务")).requestedQuality, 120);
  await switching.waitForFunction(() => document.querySelector("video").videoWidth === 854);
  await switching.evaluate(() => {
    window.detachedQualityMenu = document.querySelector(".bpx-player-ctrl-quality");
    window.detachedQualityMenu.remove();
  });
  await delay(1200);
  assert.equal(await switching.locator("video").getAttribute("data-bili-cache-playback"), null);
  await switching.evaluate(() => document.body.append(window.detachedQualityMenu));
  await switching.locator('[data-value="32"]').click();
  await switching.evaluate(() => window.confirmMenuChoice());
  await delay(300);
  assert.equal(await switching.locator("video").getAttribute("data-bili-cache-playback"), null, "菜单显示 480P 时原播放器仍在切流，先不要替换原生源");
  await switching.evaluate(() => window.finishNative480());
  await expectWholeLocal(switching);
  const selectedSource = await switching.locator("video").getAttribute("src");
  // B 站本身的回写没有对应的点击。不能把它当成用户又选了 4K。
  await switching.evaluate(() => { window.pendingChoice = "120"; window.confirmMenuChoice(); });
  gate.get("BVswitch:120").resolve();
  await until(async () => (await findSwitchTask(120))?.status === "complete", "切回 480P 后旧 4K 没有完成");
  await delay(400);
  assert.equal(await switching.locator("video").getAttribute("src"), selectedSource, "旧 4K 完成不能接管已选 480P");
  assert.equal(await switching.locator(".bpx-player-ctrl-quality-result").textContent(), "480P", "菜单回写不能掩盖本地实际档位");
  assert.equal(await switching.locator(".bpx-player-ctrl-quality-result-name").count(), 1, "同步显示时要保留原标签节点");
  assert.equal(await switching.locator(".bpx-player-ctrl-quality-menu-item.bpx-state-active").getAttribute("data-value"), "32");
  await switching.locator('[data-value="120"]').click();
  await switching.evaluate(() => window.confirmMenuChoice());
  await switching.waitForFunction(previous => document.querySelector("video").getAttribute("src") !== previous, selectedSource);
  await expectWholeLocal(switching);
  await switching.close();

  await panel.evaluate(async () => {
    const key = "playbackAssistConfigV1";
    const stored = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...stored[key], bufferMode: "complete-before-play" } });
  });
  await panel.reload();
  await panel.locator("#settings-button").click();
  await panel.waitForFunction(() => document.querySelector("#assist-buffer-mode input:checked").value === "full-speed");
  gate.set("BVlegacy", deferred());
  const legacy = await open("BVlegacy");
  await legacy.waitForFunction(() => document.querySelector("video").currentTime > 0.15);
  assert.equal((await until(() => getTask("BVlegacy"), "旧的进页自动设置没有被继承")).status, "downloading");
  await legacy.locator("video").evaluate(video => video.pause());
  gate.get("BVlegacy").resolve();
  await expectWholeLocal(legacy);
  assert.equal(await legacy.locator("video").evaluate(video => video.paused), true, "切到本地后保留用户暂停状态");

  const dash = await open("BVdash");
  await dash.evaluate(() => window.confirmPlayerQuality(120));
  await expectWholeLocal(dash);
  const dashTask = await getTask("BVdash");
  assert(dashTask.merged?.totalBytes > 0, "DASH 自动任务没有发布合并 MP4");
  assert.equal(dashTask.quality, 120, "选中 4K 后不能改用清单里的 HDR 表示");

  const native = await context.newPage();
  await native.goto("about:blank");
  await native.evaluate(bytes => {
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }));
    document.body.append(video);
  }, [...fixture]);
  await context.setOffline(true);
  const networkAtOffline = new Map(mediaRequests);
  const localLatency = await measureSeeks(legacy);
  const dashLatency = await measureSeeks(dash);
  const nativeLatency = await measureSeeks(native);
  assert.deepEqual(mediaRequests, networkAtOffline);
  assert(localLatency.p95 <= Math.min(250, Math.max(125, nativeLatency.p95 + 75)) && dashLatency.p95 <= 250,
    `本地拖动延迟超出受控线路阈值 ${JSON.stringify({ localLatency, nativeLatency })}`);
  console.log(JSON.stringify({
    ok: true, adaptiveDefault: true, autoStart: true, waitedForQuality: true, latestQualityAtStart: true, cachedSelected4k: true,
    inPageQualitySwitch: true, ignoredLateCompletions: true,
    reuseOnReload: true, quickCache: true, playingBeforeComplete: true, migratedLegacyMode: true, progressInToolbarOnly: true,
    offlineSeek: { progressive: localLatency, mergedDash: dashLatency, native: nativeLatency, mediaNetworkRequests: 0 }
  }));
} finally {
  for (const item of gate.values()) item.resolve();
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await rm(extension + "_metadata", { recursive: true, force: true });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check, error, timeout = 5400) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(error);
}

function expectWholeLocal(page) {
  return page.waitForFunction(() => {
    const video = document.querySelector("video");
    return document.documentElement.dataset.biliBufferFull === "ready" &&
      document.documentElement.dataset.biliBufferPlayback === "local" &&
      video?.seekable.length > 0 && video.seekable.end(video.seekable.length - 1) >= video.duration - 0.1;
  }, null, { timeout: 7500 });
}

async function measureSeeks(page) {
  await page.bringToFront();
  const samples = await page.evaluate(async () => {
    const video = document.querySelector("video");
    video.muted = true;
    await video.play();
    const results = [];
    // 交替跳到开头、中部、末尾。媒体时间核对目标，seeked 本身不能证明目标画面已经出现在帧回调里。
    for (const [index, fraction] of [.1, .82, .43, .91, .24, .65, .08, .52, .87, .31, .73, .16].entries()) {
      if (index === 6) video.pause();
      const target = video.duration * fraction;
      results.push(await new Promise((resolve, reject) => {
        const started = performance.now();
        let callback;
        const timeout = setTimeout(() => {
          video.cancelVideoFrameCallback(callback);
          reject(new Error("目标位置没有出画 " + target));
        }, 2000);
        const presented = (_now, frame) => {
          // 暂停时浏览器可能先提交目标帧再清 seeking，之后就没有第二个帧回调。
          if (Math.abs(frame.mediaTime - target) <= 0.15) {
            clearTimeout(timeout);
            resolve(frame.expectedDisplayTime - started);
          } else callback = video.requestVideoFrameCallback(presented);
        };
        callback = video.requestVideoFrameCallback(presented);
        video.currentTime = target;
      }));
    }
    video.pause();
    return results;
  });
  const sorted = samples.slice().sort((a, b) => a - b);
  const percentile = fraction => +sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(1);
  return { count: sorted.length, p50: percentile(.5), p95: percentile(.95) };
}
