// 真实站点冒烟：在真实 Chromium 里加载未打包扩展，打开一个 B 站视频，走和弹窗完全一致的
// GET_QUALITY_OPTIONS → START_CACHE 链路，等缓存完成后再用 <video> 实际播放缓存结果。
//
// 为什么需要它：单元 / 集成测试全部用 mock，只能证明「我们按假设的接口行为写对了」。
// 2.12.1 的 HTTP 412（老 view 端点被风控）这类「站点端行为变了」的问题，mock 测不出来，
// 只有对真实站点跑一次完整链路才能暴露。需要联网，因此不进 npm test。
//
// 用法：npm run test:live [-- <视频地址>]   （默认 BV11En46qETe；匿名身份，只能取到 480P）
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
import { chromiumLaunchOptions } from "./lib/browser-launch.mjs";

const extension = fileURLToPath(new URL("../", import.meta.url));
const url = process.argv[2] || "https://www.bilibili.com/video/BV11En46qETe/";
const TIMEOUT_MS = 10 * 60 * 1000;
const profile = await mkdtemp(`${tmpdir()}/haineicunzhi-live-`);
const context = await chromium.launchPersistentContext(profile, {
  ...chromiumLaunchOptions({ headless: false }),
  // B 站会对 navigator.webdriver / --enable-automation 的浏览器返回 412 风控页，
  // 必须抹掉自动化特征，否则测到的是风控而不是扩展。
  ignoreDefaultArgs: ["--enable-automation"],
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--disable-blink-features=AutomationControlled"
  ]
});
let failure = "";
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("video", { timeout: 60000 });
  const ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  const send = (type, data = {}) => ui.evaluate(
    ([type, data]) => chrome.runtime.sendMessage({ target: "background", type, ...data }), [type, data]);
  // 页面地址可能带语言前缀（/zh-Hans/video/…），这里用后台实际看到的标签。
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({}))
    .find((tab) => /bilibili\.com\/(?:[\w-]+\/)?video\//.test(tab.url || ""))?.id);

  const options = await send("GET_QUALITY_OPTIONS", { url, tabId });
  if (!options?.qualities?.length) throw new Error(`取画质失败：${options?.error || JSON.stringify(options)}`);
  console.log("可选画质", options.qualities.map((q) => q.quality).join(","), "→ 选", options.defaultQuality);
  const started = await send("START_CACHE", { url, tabId, quality: options.defaultQuality, codec: options.defaultCodec, mode: "video" });
  if (!started?.ok) throw new Error(`启动缓存失败：${started?.error}`);

  const t0 = Date.now();
  let last = "";
  let video;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    video = (await send("LIST_VIDEOS")).videos?.[0];
    const line = video ? `${video.status} ${video.downloadedBytes}/${video.totalBytes}` : "（无任务）";
    if (line !== last) console.log(`${Math.round((Date.now() - t0) / 1000)}s ${line}`);
    last = line;
    if (video && ["complete", "error"].includes(video.status)) break;
  }
  if (video?.status !== "complete") throw new Error(`缓存未完成：${video?.status} ${video?.error || ""}`);

  const playback = await send("GET_PLAYBACK_URL", { videoId: video.id });
  const played = await ui.evaluate(async (src) => {
    const element = document.createElement("video");
    element.muted = true;
    element.src = src;
    document.body.append(element);
    await new Promise((resolve, reject) => {
      element.onloadedmetadata = resolve;
      element.onerror = () => reject(new Error(`媒体错误 ${element.error?.code}`));
      setTimeout(() => reject(new Error("读取元数据超时")), 15000);
    });
    await element.play();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return { duration: element.duration, time: element.currentTime, width: element.videoWidth };
  }, playback.playbackUrl);
  if (!(played.time > 1 && played.width > 0)) throw new Error(`缓存结果无法播放：${JSON.stringify(played)}`);
  console.log("缓存可播放", JSON.stringify(played));
} catch (error) {
  failure = error?.message || String(error);
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
if (failure) {
  console.error(`失败：${failure}`);
  process.exit(1);
}
console.log("ok");
