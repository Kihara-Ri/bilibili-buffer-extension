import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const extension = fileURLToPath(new URL("../dist/unpacked/", import.meta.url));
const profile = await mkdtemp(tmpdir() + "/hainei-committed-");
const chunkBytes = 4 * 1024 * 1024;
const largeReadBytes = 17 * 1024 * 1024;
const bvid = "BVcommitted";
const id = bvid + ":11:q32";
const media = {};
for (const role of ["video", "audio"]) {
  const bytes = Buffer.from(await readFile(new URL(`./fixtures/dash-${role}-2frag.mp4`, import.meta.url)));
  let offset = 0;
  while (bytes.toString("ascii", offset + 4, offset + 8) !== "sidx") offset += bytes.readUInt32BE(offset);
  // 夹具保留了源文件前两段。收敛引用数量，仍用真实的段偏移和时间。
  const largeOffsets = bytes[offset + 8] === 1;
  const countAt = offset + (largeOffsets ? 38 : 30);
  bytes.writeUInt16BE(2, countAt);
  const initEnd = offset + bytes.readUInt32BE(offset);
  const firstStart = initEnd + (largeOffsets ? Number(bytes.readBigUInt64BE(offset + 28)) : bytes.readUInt32BE(offset + 24));
  const firstEnd = firstStart + bytes.readUInt32BE(countAt + 2);
  const end = Math.max(Math.ceil(bytes.length / chunkBytes), role === "video" ? 5 : 1) * chunkBytes;
  media[role] = {
    bytes: [...bytes], initEnd, firstStart, firstEnd,
    url: `https://fixture.bilivideo.com/stored-${role}.m4s`,
    end, total: end + chunkBytes
  };
}

const context = await chromium.launchPersistentContext(profile, chromiumLaunchOptions({
  headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
}));
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const control = await context.newPage();
  await control.goto(new URL("/privacy.html", worker.url()).href);
  const seed = audio => control.evaluate(async ({ audio, media, id, bvid, chunkBytes }) => {
    const { putChunksAndVideo } = await import(chrome.runtime.getURL("src/db.js"));
    const roles = audio ? ["video", "audio"] : ["video"];
    const tracks = {};
    const chunks = [];
    for (const role of roles) {
      const source = media[role];
      const bytes = new Uint8Array(source.end);
      bytes.set(source.bytes);
      tracks[role] = {
        sourceUrls: [source.url], sourceChunkBytes: chunkBytes,
        committedBytes: source.end, chunkCount: source.end / chunkBytes, totalBytes: source.total,
        mimeType: role + "/mp4"
      };
      for (let index = 0; index < tracks[role].chunkCount; index++) {
        chunks.push({ track: role, index, data: new Blob([bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)]) });
      }
    }
    await putChunksAndVideo({
      id, bvid, cid: 11, page: 1, quality: 32, createdAt: 1, runStartedAt: 2,
      status: "paused", sourcePartition: "anonymous", mediaKind: "dash", tracks
    }, chunks);
  }, { audio, media, id, bvid, chunkBytes });
  await seed(false);
  const page = await context.newPage();
  await page.route("https://www.bilibili.com/**", route => route.fulfill({
    contentType: "text/html",
    body: '<main id="bilibili-player"><video muted></video><div class="bpx-player-progress"><div class="bpx-player-progress-schedule" style="position:relative;width:360px;height:8px"><div class="bpx-player-progress-schedule-buffer"></div></div></div></main>'
  }));
  const networkRequests = [];
  await page.route("https://*.bilivideo.com/**", route => {
    networkRequests.push([new URL(route.request().url()).pathname, route.request().headers().range]);
    return route.abort();
  });
  await page.addInitScript(media => {
    const entry = (role, id) => ({ id, baseUrl: media[role].url, size: media[role].total });
    window.__playinfo__ = { data: { quality: 32, dash: { video: [entry("video", 32)], audio: [entry("audio", 30280)] } } };
  }, media);
  await page.goto(`https://www.bilibili.com/video/${bvid}/`);
  await page.waitForFunction(() => window.__biliBufferPlaybackAssistInternals?.cfg.mode === "always");
  await page.evaluate(async media => {
    const player = document.querySelector("video");
    const source = new MediaSource();
    player.src = URL.createObjectURL(source);
    const once = (target, event) => new Promise(resolve => target.addEventListener(event, resolve, { once: true }));
    await once(source, "sourceopen");
    source.duration = 10;
    const cache = window.__biliBufferCache, observer = window.__biliBufferPlaybackAssistInternals;
    const buffers = {
      video: source.addSourceBuffer('video/mp4; codecs="avc1.64001F"'),
      audio: source.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"')
    };
    const append = async (buffer, bytes) => { buffer.appendBuffer(bytes); await once(buffer, "updateend"); };
    for (const [role, row] of Object.entries(media)) {
      observer.trackFor(row.url).size = row.total;
      const init = new Uint8Array(row.bytes.slice(0, row.initEnd));
      await append(buffers[role], init);
      await append(buffers[role], new Uint8Array(row.bytes.slice(row.firstStart, row.firstEnd)));
    }
    window.testCommittedPromotion = async () => {
      const old = { StableBufferTime: 3, BufferTimeAtTopQuality: 3, BufferTimeAtTopQualityLongForm: 4 };
      const settings = { ...old }, adapter = {};
      let appended, complete;
      const pending = new Promise(resolve => { complete = resolve; });
      for (const key of Object.keys(settings)) {
        adapter[`get${key}`] = () => settings[key];
        adapter[`set${key}`] = value => {
          settings[key] = value;
          if (!appended && value > 5.5) {
            // 由播放器按原路径请求和追加，和正常播放使用同一组 SourceBuffer。
            appended = Promise.all(Object.entries(media).map(async ([role, row]) => {
              const segment = cache.index(row.url).segments[1];
              const response = await fetch(row.url, { headers: { Range: `bytes=${segment.start}-${segment.end - 1}` } });
              await append(buffers[role], await response.arrayBuffer());
            }));
            complete(appended);
          }
        };
      }
      window.player = { __core: () => ({ video: player, getCurrentPlayURLFor: role => media[role].url, getCorePlayer: () => adapter }) };
      const before = observer.publicStats().committedHits;
      await player.play();
      const deadline = AbortSignal.timeout(2200);
      const wait = new Promise((_, reject) => deadline.addEventListener("abort", () => reject(new Error("已落盘的分段没有在点击前进入播放器")), { once: true }));
      await Promise.race([pending, wait]);
      const ready = player.buffered.start(0) <= 6 && player.buffered.end(0) > 6 && player.currentTime < 4;
      const paused = once(player, "pause");
      player.pause();
      await paused;
      return { ready, restored: Object.keys(settings).every(key => settings[key] === old[key]), hits: observer.publicStats().committedHits - before };
    };
    window.testCommittedSeek = async () => {
      const before = observer.publicStats().committedHits;
      const alternate = role => media[role].url.replace("fixture.", "alternate.") + "?new-signature=1";
      const changedQuality = role => role === "video" ? alternate(role).replace("stored-video", "different-quality") : alternate(role);
      window.player = { __core: () => ({ video: player, getCurrentPlayURLFor: changedQuality }) };
      if (observer.normalizedCommittedRanges().length) throw new Error("已切清晰度时不能用旧画轨的落盘时间轴");
      window.player = { __core: () => ({ video: player, getCurrentPlayURLFor: alternate }) };
      if (!observer.normalizedCommittedRanges().length) throw new Error("同一媒体换备用地址时本地标记不能消失");
      await Promise.all(Object.entries(media).map(async ([role, row]) => {
        const segment = cache.index(row.url).segments[1];
        const response = await fetch(alternate(role), { headers: { Range: `bytes=${segment.start}-${segment.end - 1}` } });
        if (response.status !== 206) throw new Error("Expected local 206");
        await append(buffers[role], await response.arrayBuffer());
      }));
      const frame = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("目标段未出画")), 2000);
        const next = (_now, presented) => {
          if (Math.abs(presented.mediaTime - 6) < .15) { clearTimeout(timer); resolve(presented.mediaTime); }
          else player.requestVideoFrameCallback(next);
        };
        player.requestVideoFrameCallback(next);
      });
      player.currentTime = 6;
      await player.play();
      return { frame: await frame, hits: observer.publicStats().committedHits - before };
    };
  }, media);
  assert.deepEqual(await page.evaluate(() => window.__biliBufferPlaybackAssistInternals.normalizedCommittedRanges()), []);
  await seed(true);
  const notify = () => control.evaluate(async bvid => {
    const [tab] = await chrome.tabs.query({ url: `https://www.bilibili.com/video/${bvid}/*` });
    return chrome.tabs.sendMessage(tab.id, { type: "BILI_BUFFER_COMMITTED_CHANGED" }).catch(() => {});
  }, bvid);
  await notify();
  await page.waitForFunction(() => document.querySelector("[data-bili-buffer-committed]"), null, { timeout: 9000 });
  const marker = await page.locator("[data-bili-buffer-committed]").evaluate(node => {
    const points = getComputedStyle(node, "::after");
    return { dots: points.backgroundImage.startsWith("radial-gradient("), masked: points.maskImage !== "none", pointerEvents: points.pointerEvents };
  });
  assert.deepEqual(marker, { dots: true, masked: true, pointerEvents: "none" });
  const beforeNetwork = networkRequests.length;
  const promotion = await page.evaluate(() => window.testCommittedPromotion());
  assert.deepEqual(promotion, { ready: true, restored: true, hits: 2 });
  const seek = await page.evaluate(() => window.testCommittedSeek());
  assert.equal(seek.hits, 2, "目标点的两条轨都应直接命中落盘分块");
  const large = await page.evaluate(async ({ url, total, bytes }) => {
    const observer = window.__biliBufferPlaybackAssistInternals;
    const hits = observer.publicStats().committedHits;
    const response = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
    return { status: response.status, range: response.headers.get("content-range"),
      bytes: (await response.arrayBuffer()).byteLength, hits: observer.publicStats().committedHits - hits };
  }, { url: media.video.url, total: media.video.total, bytes: largeReadBytes });
  assert.deepEqual(large, { status: 206, range: `bytes 0-${largeReadBytes - 1}/${media.video.total}`, bytes: largeReadBytes, hits: 1 });
  assert.deepEqual(networkRequests.slice(beforeNetwork), [], "已标记区间跳转不能重新向 CDN 请求正文");
  await control.evaluate(async id => {
    const reply = await chrome.runtime.sendMessage({ target: "background", type: "DELETE_VIDEO", videoId: id, createdAt: 1 });
    if (!reply?.deleted) throw new Error("测试任务删除失败");
  }, id);
  await notify();
  await page.waitForFunction(() => !document.querySelector("[data-bili-buffer-committed]") &&
    !window.__biliBufferPlaybackAssistInternals.normalizedCommittedRanges().length);
  console.log(JSON.stringify({ ok: true, audioAndVideoRequired: true, promotion, largeLocalBytes: large.bytes, clearedOnQualityChange: true, frame: seek.frame, diskHits: seek.hits, seekMediaRequests: 0, clearedOnDelete: true }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await rm(extension + "_metadata", { recursive: true, force: true });
}
