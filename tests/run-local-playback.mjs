import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const extension = fileURLToPath(new URL("../dist/unpacked/", import.meta.url));
const profile = await mkdtemp(tmpdir() + "/hainei-local-playback-");
const fixture = await readFile(new URL("./fixtures/progressive-avc-aac.mp4", import.meta.url));
const base = "https://www.bilibili.com/video/";
const context = await chromium.launchPersistentContext(profile, chromiumLaunchOptions({
  headless: true,
  args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension]
}));
try {
  await context.route("https://www.bilibili.com/**", route => {
    const original = route.request().url().includes("BVbroken")
      ? ' src="data:video/mp4;base64,' + fixture.toString("base64") + '"' : "";
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head></head><body><video muted" + original + "></video></body></html>" });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const state = { offline: true, holdRaceLookup: true, raceRequests: 0, release: () => {} };
    globalThis.localPlaybackProbe = state;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input.url || input);
      if (url.hostname !== "api.bilibili.com") return originalFetch(input, init);
      if (state.offline) throw new TypeError("Bilibili API unavailable");
      const bvid = url.searchParams.get("bvid");
      if (bvid === "BVrace") {
        state.raceRequests++;
        if (state.holdRaceLookup) {
          state.holdRaceLookup = false;
          await new Promise(resolve => { state.release = resolve; });
        }
      }
      return Response.json({ code: 0, data: {
        bvid, title: bvid,
        pages: [{ cid: 11, page: 1, duration: 19 }, { cid: 22, page: 2, duration: 12 }]
      } });
    };
  });

  const control = await context.newPage();
  await control.goto("chrome-extension://" + new URL(worker.url()).hostname + "/privacy.html");
  await control.evaluate(async values => {
    const { putChunksAndVideo } = await import(chrome.runtime.getURL("src/db.js"));
    const valid = new Blob([new Uint8Array(values)], { type: "video/mp4" });
    const invalid = new Blob([new Uint8Array(64)], { type: "video/mp4" });
    const seed = (bvid, data, metadata) => putChunksAndVideo({
      id: bvid + ":11:q16", bvid, cid: 11, duration: 19, quality: 16,
      status: "complete", title: bvid, mediaKind: "progressive",
      totalBytes: data.size, downloadedBytes: data.size, resumeBytes: data.size, chunkCount: 1, ...metadata
    }, [{ track: "media", index: 0, data }]);
    await seed("BVlocal", valid, { page: 1, aid: 123 });
    await seed("BVrace", valid, {}); // 旧记录缺分 P，强制走可延迟的标准远程解析。
    await seed("BVbroken", invalid, { page: 1 });
  }, [...fixture]);

  const open = async (bvid, pageNumber = 1) => {
    const page = await context.newPage();
    await page.bringToFront();
    await page.goto(base + bvid + "/?p=" + pageNumber);
    await page.waitForFunction(() => document.documentElement.dataset.biliBufferContentReady);
    return page;
  };
  // 首次查到本地缓存还要冷启动 Offscreen。这里验证能否接管，出画延迟由单独的 seek 用例计时。
  const local = (page, timeout = 10_000) => page.waitForFunction(() => document.documentElement.dataset.biliBufferPlayback === "local",
    null, { timeout }).then(() => true, () => false);
  const observe = page => page.evaluate(() => {
    const video = document.querySelector("video");
    return { switched: video.src.startsWith("blob:"), playable: video.videoWidth > 0 };
  });

  const offline = await open("BVlocal");
  const offlineLocal = await local(offline);
  if (offlineLocal) {
    await offline.evaluate(() => document.querySelector("video").play());
    await offline.waitForFunction(() => document.querySelector("video").currentTime > 0.1);
  }
  const avLookup = await control.evaluate(() => chrome.runtime.sendMessage({
    target: "background", type: "GET_CACHED_FOR_URL", url: "https://www.bilibili.com/video/av123"
  }));
  await offline.close();

  // 模拟 B 站站点完全不可达，再从片库直接打开浏览器原生媒体页。
  const blockSite = route => route.abort();
  await context.route("https://www.bilibili.com/**", blockSite);
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + new URL(worker.url()).hostname + "/popup.html");
  await popup.locator("#library-tab").click();
  const play = popup.locator(".video-item").filter({ hasText: "BVlocal" }).locator(".play-button");
  await play.waitFor({ timeout: 2500 });
  const [standalone] = await Promise.all([context.waitForEvent("page", { timeout: 4000 }), play.click()]);
  await standalone.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 5000 });
  assert(standalone.url().startsWith("blob:"), "片库播放应直接挂载本地产物");
  await standalone.evaluate(async () => {
    const video = document.querySelector("video");
    video.muted = true;
    video.currentTime = 2;
    await video.play();
  });
  await standalone.waitForFunction(() => document.querySelector("video").currentTime > 2.1);
  const address = standalone.url();
  const [secondStandalone] = await Promise.all([
    context.waitForEvent("page", { timeout: 4000 }),
    control.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "OPEN_CACHED_VIDEO", videoId: "BVlocal:11:q16" }))
  ]);
  await secondStandalone.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 5000 });
  assert.equal(secondStandalone.url(), address, "同时播放同一缓存应共享底层 Blob");
  await standalone.close();
  const canReadBlob = async url => {
    try {
      const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
      return response.ok && (await response.arrayBuffer()).byteLength === 1;
    } catch { return false; }
  };
  assert(await control.evaluate(canReadBlob, address), "关掉一个播放页不能撤销另一个页的 Blob");
  await secondStandalone.close();
  await control.waitForFunction(async url => {
    try {
      const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
      await response.body?.cancel();
      return false;
    }
    catch { return true; }
  }, address, { timeout: 5000 });
  await popup.close();
  await context.unroute("https://www.bilibili.com/**", blockSite);

  await worker.evaluate(() => { localPlaybackProbe.offline = false; });
  const race = await open("BVrace");
  const deadline = Date.now() + 2000;
  while (await worker.evaluate(() => localPlaybackProbe.raceRequests) === 0 && Date.now() < deadline) await delay(20);
  assert.equal(await worker.evaluate(() => localPlaybackProbe.raceRequests), 1, "切页前确实有一个查询在途");
  await race.evaluate(() => history.pushState({}, "", "?p=2"));
  await worker.evaluate(() => localPlaybackProbe.release());
  const stalePlayed = await local(race, 1800);
  await race.close();

  const broken = await open("BVbroken");
  await broken.waitForFunction(() => document.documentElement.dataset.biliBufferPlayback === "error");
  const afterError = await observe(broken);
  await broken.reload();
  await broken.waitForFunction(() => document.querySelector("video").videoWidth > 0, null, { timeout: 1800 }).catch(() => {});
  const afterReload = await observe(broken);
  await broken.waitForFunction(() => document.documentElement.dataset.biliBufferPlayback === "error");
  await control.evaluate(async values => {
    const videoId = "BVbroken:11:q16";
    const result = await chrome.runtime.sendMessage({ target: "background", type: "DELETE_VIDEO", videoId });
    if (!result?.ok) throw new Error("删除测试坏档失败");
    const { putChunksAndVideo } = await import(chrome.runtime.getURL("src/db.js"));
    const data = new Blob([new Uint8Array(values)], { type: "video/mp4" });
    await putChunksAndVideo({
      id: videoId, bvid: "BVbroken", cid: 11, page: 1, duration: 19, quality: 16,
      status: "complete", title: "BVbroken", mediaKind: "progressive", runStartedAt: Date.now(),
      totalBytes: data.size, downloadedBytes: data.size, resumeBytes: data.size, chunkCount: 1
    }, [{ track: "media", index: 0, data }]);
    const [tab] = await chrome.tabs.query({ url: "https://www.bilibili.com/video/BVbroken/*" });
    await chrome.tabs.sendMessage(tab.id, { type: "CACHE_READY", videoId }).catch(() => {});
  }, [...fixture]);
  const repairedPlayed = await local(broken);
  await broken.close();
  const actual = { offlineLocal, avMatch: avLookup?.video?.id ?? null, stalePlayed, afterError, afterReload };
  assert.deepEqual(actual, {
    offlineLocal: true, avMatch: "BVlocal:11:q16", stalePlayed: false,
    afterError: { switched: false, playable: true }, afterReload: { switched: false, playable: true }
  });
  assert(repairedPlayed, "同一 ID 的新缓存修好后，应允许在当前页重新播放");

  const trackBytes = await Promise.all(["video", "audio"].map(async name =>
    [...await readFile(new URL("./fixtures/dash-" + name + "-2frag.mp4", import.meta.url))]
  ));
  await control.evaluate(async bytes => {
    const { putChunksAndVideo } = await import(chrome.runtime.getURL("src/db.js"));
    const [video, audio] = bytes;
    const descriptions = [
      { name: "video", codecs: "avc1.64001F", bytes: video },
      { name: "audio", codecs: "mp4a.40.2", bytes: audio }
    ];
    const tracks = Object.fromEntries(descriptions.map(({ name, codecs, bytes }) => [
      name, { name, mimeType: name + "/mp4", mimeCodec: name + '/mp4; codecs="' + codecs + '"',
        totalBytes: bytes.length, downloadedBytes: bytes.length, chunkCount: 1 }
    ]));
    const totalBytes = video.length + audio.length;
    await putChunksAndVideo({
      id: "BVsplit:11:q32", bvid: "BVsplit", cid: 11, page: 1, quality: 32, duration: 10,
      title: "BVsplit", status: "complete", mediaKind: "dash", mergeError: "Fixture keeps separate tracks",
      totalBytes, downloadedBytes: totalBytes, tracks
    }, descriptions.map(({ name, bytes }) => ({ track: name, index: 0, data: new Blob([new Uint8Array(bytes)]) })));
  }, trackBytes);
  const split = await open("BVsplit");
  assert(await local(split), "历史双轨缓存应仍能交给网页播放器");
  await split.evaluate(() => document.querySelector("video").play());
  await split.waitForFunction(() => document.querySelector("video").getVideoPlaybackQuality().totalVideoFrames > 0);
  console.log(JSON.stringify({ ok: true, standalonePlayedAndSeeked: true, repairedPlayed, splitTracksPlayed: true, ...actual }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await rm(extension + "_metadata", { recursive: true, force: true });
}
