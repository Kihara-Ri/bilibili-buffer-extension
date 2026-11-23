import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBilibiliOutput, mcpExportFilename } from "./bilibili-mcp-output.mjs";

export class BilibiliDownloadError extends Error {
  /** @param {string} code @param {string} message @param {{loginUrl?:string}} [details] */
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function extensionError(message) {
  // 某些网络错误附带带签名的源地址。调用方只需要可重试的原因。
  const detail = typeof message === "string" ? message.replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]").slice(0, 240) : "";
  return new BilibiliDownloadError("EXTENSION_ERROR", detail || "扩展暂时没有返回结果，请重试。");
}

/**
 * 通过真实扩展页调用 Service Worker，复用浏览器登录、缓存和下载能力。
 * @param {{context: import('playwright').BrowserContext, close: () => Promise<void>}} browser
 * @param {string} outputDirectory
 * @param {AbortSignal} signal
 */
export async function createBilibiliDownloadBrowser(browser, outputDirectory, signal) {
  const { context } = browser;
  const artifacts = createBilibiliOutput(outputDirectory);
  try {
    const isExtensionWorker = worker => worker.url().startsWith("chrome-extension://") && new URL(worker.url()).pathname === "/src/background.js";
    const worker = context.serviceWorkers().find(isExtensionWorker) || await context.waitForEvent("serviceworker", { predicate: isExtensionWorker, timeout: 15_000 });
    const control = await context.newPage();
    await control.goto(new URL("/privacy.html", worker.url()).href, { timeout: 15_000 });
    if (!await control.evaluate(() => Boolean(chrome.runtime?.id && chrome.downloads))) {
      throw new BilibiliDownloadError("EXTENSION_UNAVAILABLE", "专用 Chromium 未加载海内存知。");
    }
    let outputSetup;

    async function prepareOutput() {
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      const output = await realpath(outputDirectory);
      const staging = await mkdtemp(join(output, ".bilibili-browser-"));
      try {
        const cdp = await context.newCDPSession(control);
        // 调试会话与浏览器同寿命。Chrome 可能用 Blob UUID 命名，落盘后再按导出计划命名。
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: staging, eventsEnabled: false });
        return { output, staging };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }

    async function send(type, fields) {
      signal.throwIfAborted();
      const result = await control.evaluate(async message => {
        // MV3 后台有可能在切换生命周期时断开消息通道。为无响应的调用设上限。
        let timer;
        try {
          return await Promise.race([
            chrome.runtime.sendMessage(message),
            new Promise(resolve => { timer = setTimeout(() => resolve({ error: "扩展响应超时，请重试。" }), 30_000); })
          ]);
        } finally {
          clearTimeout(timer);
        }
      }, { target: "background", type, ...fields }).catch(() => null);
      if (!result?.ok) throw extensionError(result?.error);
      return result;
    }

    async function withVideo(url, callback) {
      signal.throwIfAborted();
      const page = await context.newPage();
      try {
        // 从扩展页取得这一个标签的 ID。并发下载同一分 P 时，按 URL 查询无法区分标签。
        await page.goto(control.url(), { waitUntil: "commit", timeout: 15_000 });
        const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        if (!Number.isInteger(tabId) || !page.url().startsWith("https://www.bilibili.com/")) {
          throw new BilibiliDownloadError("PAGE_UNAVAILABLE", "无法打开该 B 站视频页。");
        }
        return await callback(tabId);
      } finally {
        await page.close().catch(() => {});
      }
    }

    async function readJson(address, kind) {
      signal.throwIfAborted();
      const url = new URL(address);
      // 仅固定的 B 站 API 可带浏览器会话。字幕 CDN 拒绝重定向且不携带 Cookie。
      const permitted = kind === "cues"
        ? url.protocol === "https:" && (url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com"))
        : url.origin === "https://api.bilibili.com" && url.pathname === (kind === "nav" ? "/x/web-interface/nav" : "/x/player/wbi/v2");
      if (!permitted || url.username || url.password || url.port) throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "字幕接口地址无效。");
      const result = await control.evaluate(async ({ address, kind }) => {
        const response = await fetch(address, { credentials: kind === "cues" ? "omit" : "include", redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) return { httpStatus: response.status };
        const data = await response.json();
        if (kind === "nav") return { keys: data?.data?.wbi_img };
        if (kind === "tracks") return { code: data?.code, tracks: data?.data?.subtitle?.subtitles };
        return { body: data?.body };
      }, { address, kind }).catch(() => null);
      if (!result || result.httpStatus) throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "B 站字幕接口暂时不可用。");
      return result;
    }

    async function exportFiles(videoId, outputKey, { metadata, subtitle, maxBytes, beforePublish } = {}) {
      let stage, downloads;
      try {
        signal.throwIfAborted();
        outputSetup ??= prepareOutput().catch(error => { outputSetup = null; throw error; });
        const { output, staging } = await outputSetup;
        stage = await mkdtemp(join(output, ".bilibili-export-"));
        // 与弹窗共用后台导出，Offscreen 保护媒体直到 Chrome 下载结束。
        const plan = await control.evaluate(id => chrome.runtime.sendMessage({
          target: "background", type: "SAVE_VIDEO", videoId: id, saveAs: false
        }), videoId);
        if (!plan?.ok) throw extensionError(plan?.error);
        downloads = plan.downloadIds.map((id, index) => ({ id, filename: plan.filenames[index] }));

        // Chrome 报完成且所有文件通过落盘校验后，一次公开整组产物，避免暴露半个双轨导出。
        const complete = await waitForDownloads(control, downloads.map(({ id }) => id), signal, beforePublish);
        const files = [];
        for (const [index, item] of complete.entries()) {
          if (relative(staging, item.filename) !== basename(item.filename)) throw new Error("浏览器文件未写入预期目录");
          const file = await lstat(item.filename);
          if (!file.isFile() || !file.size || (item.totalBytes > 0 && file.size !== item.totalBytes)) {
            throw new Error("浏览器文件大小校验失败");
          }
          const name = mcpExportFilename(downloads[index].filename);
          await rename(item.filename, join(stage, name));
          files.push({ name, bytes: file.size });
        }
        const result = await artifacts.publish(outputKey, stage, { ...metadata, files, splitTracks: plan.splitTracks }, {
          subtitle, maxBytes, beforePublish, makeError: (code, message) => new BilibiliDownloadError(code, message)
        });
        stage = null;
        return result;
      } catch (error) {
        if (error instanceof BilibiliDownloadError || signal.aborted) throw error;
        throw new BilibiliDownloadError("EXPORT_FAILED", "缓存已就绪，但浏览器导出失败。请检查输出目录和剩余空间，然后重试。");
      } finally {
        if (stage) {
          if (downloads) await control.evaluate(items => Promise.allSettled(items.map(({ id }) => chrome.downloads.cancel(id))), downloads).catch(() => {});
          await rm(stage, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    return { send, withVideo, readJson, exportFiles, async close() {
      try { await browser.close(); }
      finally {
        const directories = await outputSetup?.catch(() => null);
        if (directories) await rm(directories.staging, { recursive: true, force: true }).catch(() => {});
      }
    } };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function waitForDownloads(control, ids, signal, beforePublish) {
  for (;;) {
    signal.throwIfAborted();
    await beforePublish?.();
    const items = await control.evaluate(ids => Promise.all(ids.map(async id => (await chrome.downloads.search({ id }))[0])), ids);
    if (items.some(item => !item || item.state === "interrupted")) throw new Error("浏览器下载中断");
    if (items.every(item => item.state === "complete")) return items;
    await delay(300, undefined, { signal });
  }
}
