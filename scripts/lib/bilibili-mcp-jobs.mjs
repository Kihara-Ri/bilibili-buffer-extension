import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { committedBytes, taskProgress } from "../../src/task-presentation.js";
import { hasCompleteByteCount, isAudioOnlyCache, makeVideoId } from "../../src/utils.js";
import { MCP_BILI_LOGIN_URL } from "../../src/mcp-browser-requests.js";
import { BilibiliDownloadError } from "./bilibili-download-browser.mjs";
import {
  parseBilibiliMediaRequest, planBilibiliBudget, readBilibiliMediaInfo, readBilibiliParts,
  readBilibiliSubtitles, requireBilibiliPart, resolveBilibiliMediaRequest
} from "./bilibili-mcp-media.mjs";
import { createBilibiliOutput } from "./bilibili-mcp-output.mjs";
import { createBilibiliJobStore } from "./bilibili-mcp-store.mjs";

const ACTIVE = new Set(["starting", "downloading", "exporting"]);
const unfinished = state => state === "queued" || ACTIVE.has(state);
const findJob = (jobs, id) => jobs.find(job => job.jobId === id);
const completedBytes = job => job.items.reduce((sum, item) => sum + (item.state === "complete" ? item.artifactBytes : 0), 0);
const sessionBlocked = error => ["LOGIN_REQUIRED", "ACCOUNT_CHECK_UNAVAILABLE", "CHROME_NOT_CONNECTED"].includes(error?.code);

function deriveState(job) {
  const states = job.items.map(item => item.state);
  for (const state of ["exporting", "downloading", "starting", "queued", "interrupted", "paused", "cancelled"]) {
    if (states.includes(state)) return state;
  }
  return states.every(state => state === "complete") ? "complete" : states.includes("complete") ? "partial" : "failed";
}

function stopJob(job, state) {
  job.items.forEach(item => {
    if (unfinished(item.state) || (state !== "interrupted" && ["paused", "interrupted"].includes(item.state))) item.state = state;
  });
  job.state = deriveState(job);
  job.runId = null;
  job.command = null;
  job.updatedAt = Date.now();
}

function present(job) {
  const { jobId, kind, url, mode, state, items, createdAt, updatedAt, maxTotalBytes, command } = job;
  const publicItem = ({ key, cacheId, cacheCreatedAt, ...item }) => item;
  const common = { jobId, kind, url, mode, state, createdAt, updatedAt, ...(command ? { pendingAction: command } : {}) };
  if (kind === "single") return { ...publicItem(items[0]), ...common, ...(maxTotalBytes === undefined ? {} : { maxBytes: maxTotalBytes }) };
  return { ...common, title: job.title, maxTotalBytes, estimatedTotalBytes: job.estimatedTotalBytes,
    artifactBytes: completedBytes(job), items: items.map(publicItem) };
}

export function reportedError(error) {
  if (error instanceof BilibiliDownloadError) return { code: error.code, message: error.message, ...error.details };
  if (["EACCES", "EPERM", "ENOSPC", "ELOCKED", "ECOMPROMISED"].includes(error?.code)) {
    return { code: "LOCAL_STORAGE_ERROR", message: "本地任务记录暂时不可写，请检查磁盘空间和资料目录权限。" };
  }
  return { code: "BROWSER_ERROR", message: "Chrome 扩展连接中断，请重试。" };
}

async function requireAccount(browser) {
  if (!browser.accountStatus) return; // 旧的独立测试入口可继续跑匿名夹具。
  const account = await browser.accountStatus();
  if (account.status === "signed_in") return;
  if (account.status === "signed_out") {
    throw new BilibiliDownloadError("LOGIN_REQUIRED", "当前连接的 Chrome 尚未登录 B 站。请在同一个 Chrome 资料登录后继续。", { loginUrl: MCP_BILI_LOGIN_URL });
  }
  throw new BilibiliDownloadError("ACCOUNT_CHECK_UNAVAILABLE", "暂时无法核实当前 Chrome 的 B 站会话，请稍后重试。");
}

/**
 * 任务库跨进程共享。已提交的媒体断点和 Chrome 资料里的登录会话由扩展维护。
 * @param {Function} openBrowser @param {{jobDirectory:string,outputDirectory:string,fetcher?:typeof fetch}} options
 */
export function createBilibiliDownloadJobs(openBrowser, { jobDirectory, outputDirectory, fetcher } = {}) {
  const store = createBilibiliJobStore(jobDirectory);
  const output = createBilibiliOutput(outputDirectory);
  const shutdown = new AbortController();
  const signal = shutdown.signal;
  let browserPromise, worker;
  let browserClosing = Promise.resolve();
  let browserUsers = 0;
  const canRun = job => job.state === "queued" && job.outputDirectory === outputDirectory;

  function releaseBrowser() {
    if (browserPromise) {
      browserClosing = browserPromise.then(browser => browser.close()).catch(() => {});
      browserPromise = null;
    }
    return browserClosing;
  }

  async function useBrowser(operation) {
    signal.throwIfAborted();
    browserUsers++;
    browserPromise ??= browserClosing.then(() => openBrowser(signal));
    try {
      const browser = await browserPromise;
      signal.throwIfAborted();
      return await operation(browser);
    } finally {
      if (--browserUsers === 0) await releaseBrowser();
    }
  }

  function lookup(jobs, id) {
    const job = findJob(jobs, id);
    if (!job) throw new BilibiliDownloadError("JOB_NOT_FOUND", "找不到这个下载任务。");
    return job;
  }

  const editJob = (id, edit) => store.update(jobs => {
    const job = lookup(jobs, id);
    edit(job);
    job.updatedAt = Date.now();
    return job;
  });

  async function runJob(initial, leaseSignal) {
    const { jobId, runId } = initial;
    const stopped = error => signal.aborted || leaseSignal.aborted || error?.code === "JOB_STOPPED";
    const guard = async () => {
      signal.throwIfAborted();
      leaseSignal.throwIfAborted();
      const job = lookup(await store.read(), jobId);
      if (job.command || job.runId !== runId) throw new BilibiliDownloadError("JOB_STOPPED", "任务已请求停止。");
      return job;
    };
    const patch = edit => editJob(jobId, job => {
      leaseSignal.throwIfAborted();
      if (job.runId !== runId) throw new BilibiliDownloadError("JOB_STOPPED", "任务已由其他会话接管。");
      edit(job);
    });
    const partPatch = (part, changes) => patch(job => {
      Object.assign(job.items.find(item => item.page === part), changes);
      const state = deriveState(job);
      job.state = ACTIVE.has(state) ? state : "starting"; // 执行者持有批次直到发布最终状态。
    });

    try {
      // 先对照持久清单，收回上次原子导出后还来不及写入任务库的结果。
      for (const item of initial.items.filter(item => item.state === "queued")) {
        await guard();
        const saved = await output.read(item.key);
        if (saved) await partPatch(item.page, { ...saved, state: "complete", progress: 1 });
      }
      if ((await guard()).items.some(item => item.state === "queued")) {
        await useBrowser(async browser => {
          await guard();
          await requireAccount(browser);
          await guard();
          const base = parseBilibiliMediaRequest(initial.url);
          const catalog = await readBilibiliParts(browser, base);
          await guard();
          await patch(job => {
            job.title = catalog.title;
            for (const item of job.items.filter(item => item.state === "queued")) {
              const part = catalog.parts.find(part => part.page === item.page);
              if (!part) {
                item.state = "failed";
                item.error = { code: "PART_UNAVAILABLE", message: `这个视频只有 ${catalog.pageCount} P，无法选择 P${item.page}。` };
              } else if (item.cid && item.cid !== part.cid) {
                item.state = "failed";
                item.error = { code: "PART_CHANGED", message: `P${item.page} 已变化，请重新查询分 P。` };
              } else {
                Object.assign(item, { url: part.url, cid: part.cid, bvid: catalog.bvid, title: catalog.title, partTitle: part.title });
              }
            }
          });
          const planned = new Map();
          if (initial.maxTotalBytes !== undefined) {
            const current = await guard();
            const inputs = [];
            for (const item of current.items.filter(item => item.state === "queued")) {
              await guard();
              try {
                const info = await browser.withVideo(item.url, tabId => readBilibiliMediaInfo(browser, item, tabId));
                const options = qualityOptions(initial, item, info);
                if (!options.some(option => Number.isSafeInteger(option.bytes) && option.bytes > 0)) {
                  throw new BilibiliDownloadError("BUDGET_UNKNOWN", `P${item.page} 的体积未知，无法纳入预算。`);
                }
                inputs.push({ item, options });
              } catch (error) {
                if (stopped(error) || sessionBlocked(error)) throw error;
                await partPatch(item.page, { state: "failed", error: reportedError(error) });
              }
            }
            const selections = planBilibiliBudget(inputs, initial.maxTotalBytes - completedBytes(current));
            await patch(job => {
              job.estimatedTotalBytes = completedBytes(job) + selections.reduce((sum, choice) => sum + choice.bytes, 0);
              inputs.forEach(({ item }, index) => {
                const choice = selections[index];
                planned.set(item.page, choice);
                Object.assign(job.items.find(part => part.page === item.page), { requestedQuality: choice.quality, plannedBytes: choice.bytes });
              });
            });
          }

          for (const item of (await guard()).items.filter(item => item.state === "queued")) {
            await downloadPart(browser, initial, item, {
              planned: planned.get(item.page), guard, update: changes => partPatch(item.page, changes), signal, leaseSignal, stopped
            });
          }
        });
      }
      await patch(job => {
        job.state = deriveState(job);
        job.runId = null;
        job.command = null;
      });
    } catch (error) {
      if (leaseSignal.aborted) return;
      await patch(job => {
        if (stopped(error)) {
          const state = job.command === "pause" ? "paused" : job.command === "cancel" ? "cancelled" : "interrupted";
          stopJob(job, state);
        } else if (sessionBlocked(error)) {
          const failure = reportedError(error);
          for (const item of job.items.filter(item => unfinished(item.state))) item.error = failure;
          stopJob(job, "paused");
        } else {
          for (const item of job.items.filter(item => unfinished(item.state))) {
            Object.assign(item, { state: "failed", error: reportedError(error) });
          }
          job.state = deriveState(job);
          job.runId = null;
          job.command = null;
        }
      });
    }
  }

  async function drain() {
    while (!signal.aborted && (await store.read()).some(canRun)) {
      const lease = new AbortController();
      const release = await store.claimRunner(error => lease.abort(error));
      if (!release) {
        await delay(750, undefined, { signal });
        continue;
      }
      try {
        await store.update(jobs => {
          for (const job of jobs.filter(job => ACTIVE.has(job.state))) {
            stopJob(job, job.command === "pause" ? "paused" : job.command === "cancel" ? "cancelled" : "interrupted");
          }
        });
        while (!signal.aborted && !lease.signal.aborted && (await store.read()).some(canRun)) {
          const next = await store.update(jobs => {
            const job = jobs.find(canRun);
            if (job) Object.assign(job, { state: "starting", runId: randomUUID(), updatedAt: Date.now() });
            return job;
          });
          if (next) await runJob(next, lease.signal);
        }
      } finally {
        await release().catch(() => {});
      }
    }
  }

  function schedule() {
    if (worker || signal.aborted) return;
    worker = drain().then(() => true, () => false).then(async check => {
      worker = null;
      if (check && !signal.aborted && (await store.read()).some(canRun)) schedule();
    }).catch(() => {});
  }

  async function start({ url, pages, mode = "video", quality, maxBytes, maxTotalBytes = maxBytes, subtitles }) {
    if (mode === "audio" && quality !== undefined) throw new BilibiliDownloadError("INVALID_QUALITY", "仅音频会自动选原轨，quality 参数只用于视频。");
    const request = await resolveBilibiliMediaRequest(url, fetcher);
    const kind = pages ? "batch" : "single";
    const selected = pages ? [...new Set(pages)].sort((a, b) => a - b) : [request.page];
    const canonical = pages ? request.url.split("?")[0] : request.url;
    const captions = subtitles ? { language: subtitles.language, format: subtitles.format || "both" } : undefined;
    const key = JSON.stringify([kind, canonical, selected, mode, quality, maxTotalBytes, captions, outputDirectory]);
    const result = await store.update(async jobs => {
      const previous = jobs.findLast(job => job.key === key && job.state !== "cancelled");
      if (previous && (previous.state !== "complete" || (await Promise.all(previous.items.map(item => output.read(item.key)))).every(Boolean))) return previous;
      const jobId = randomUUID();
      const job = { jobId, kind, key, url: canonical, mode, quality, maxTotalBytes, subtitles: captions, outputDirectory,
        state: "queued", command: null, createdAt: Date.now(), updatedAt: Date.now(),
        items: selected.map(page => ({ page, state: "queued", key: pages ? `${jobId}/P${page}` : jobId })) };
      jobs.push(job);
      return job;
    });
    if (result.state === "queued") schedule();
    return present(result);
  }

  async function status(jobId, waitSeconds = 0, requestSignal) {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const job = lookup(await store.read(), jobId);
      if (ACTIVE.has(job.state) && !await store.runnerActive()) stopJob(job, job.command === "pause" ? "paused" : job.command === "cancel" ? "cancelled" : "interrupted");
      if (!unfinished(job.state) || Date.now() >= deadline) return present(job);
      await delay(Math.min(400, Math.max(0, deadline - Date.now())), undefined, { signal: requestSignal });
    }
  }

  async function control(jobId, action) {
    const changed = await store.update(async jobs => {
      const job = lookup(jobs, jobId);
      if (ACTIVE.has(job.state) && !await store.runnerActive()) stopJob(job, job.command === "pause" ? "paused" : job.command === "cancel" ? "cancelled" : "interrupted");
      if (action === "pause" || action === "cancel") {
        if (ACTIVE.has(job.state)) {
          if (job.command !== "cancel") job.command = action;
        } else if (job.items.some(item => ["queued", "paused", "interrupted"].includes(item.state))) {
          stopJob(job, action === "pause" ? "paused" : "cancelled");
        }
      } else if (ACTIVE.has(job.state)) {
        throw new BilibiliDownloadError("JOB_RUNNING", "任务正在执行或收尾，请等待当前状态落定。");
      } else if (job.state !== "cancelled") {
        if (job.outputDirectory !== outputDirectory) throw new BilibiliDownloadError("OUTPUT_DIRECTORY_CHANGED", "请切回这个任务原先使用的输出目录后再继续。");
        const allowed = action === "resume" ? ["paused", "interrupted"] : ["failed"];
        for (const item of job.items.filter(item => allowed.includes(item.state))) {
          item.state = "queued";
          item.error = null;
        }
        job.state = deriveState(job);
      }
      job.updatedAt = Date.now();
      return job;
    });
    if (changed.state === "queued") schedule();
    return present(changed);
  }

  return {
    start, status, control,
    accountStatus: () => useBrowser(browser => browser.accountStatus?.() || { status: "unavailable" }),
    async list(limit = 20) {
      const jobs = await store.read();
      const running = await store.runnerActive();
      return { jobs: jobs.slice(-limit).reverse().map(job => {
        if (ACTIVE.has(job.state) && !running) stopJob(job, job.command === "pause" ? "paused" : job.command === "cancel" ? "cancelled" : "interrupted");
        return present(job);
      }) };
    },
    async inspect(url) {
      const request = await resolveBilibiliMediaRequest(url, fetcher);
      return useBrowser(async browser => {
        await requireAccount(browser);
        const catalog = requireBilibiliPart(await readBilibiliParts(browser, request), request.page);
        const info = await browser.withVideo(catalog.url, tabId => readBilibiliMediaInfo(browser, request, tabId));
        return { ...info, parts: catalog.parts };
      });
    },
    async subtitles({ url, language, format = "none", offset = 0, limit = 200 }) {
      const request = await resolveBilibiliMediaRequest(url, fetcher);
      const result = await useBrowser(async browser => {
        await requireAccount(browser);
        const part = requireBilibiliPart(await readBilibiliParts(browser, request), request.page);
        return { ...await readBilibiliSubtitles(browser, part, language), url: part.url, page: part.page, cid: part.cid };
      });
      if (result.status !== "ready") return result;
      const { cues, ...info } = result;
      const saved = format === "none" ? {} : await output.saveSubtitle(randomUUID(), { ...result, format });
      return { ...info, ...saved, cues: cues.slice(offset, offset + limit), totalCues: cues.length,
        nextOffset: offset + limit < cues.length ? offset + limit : null };
    },
    async close() {
      shutdown.abort();
      await releaseBrowser();
      await worker;
    }
  };
}

function unavailableQuality(info) {
  const offered = info.videoQualities.map(item => `${item.label} (${item.quality})`).join("、");
  return new BilibiliDownloadError("QUALITY_UNAVAILABLE", `当前会话可用画质为 ${offered || "无"}，请重新选择。`);
}

function qualityOptions(job, item, info) {
  if (item.cid !== info.cid || item.bvid !== info.bvid) throw new BilibiliDownloadError("PART_CHANGED", "分 P 在下载前发生变化，请重新选择。");
  if (job.mode === "audio") return info.audio ? [info.audio] : [];
  // 已在片库建档的 P 保留续传档位。仅做过估算的 P 可以按剩余预算重新选档。
  const chosen = job.quality ?? (item.cacheId ? item.requestedQuality : undefined);
  const options = chosen === undefined ? info.videoQualities : info.videoQualities.filter(option => option.quality === chosen);
  if (!options.length) throw unavailableQuality(info);
  return options;
}

async function downloadPart(browser, job, item, { planned, guard, update, signal, leaseSignal, stopped }) {
  let target;
  try {
    await guard();
    await update({ state: "starting", error: null });
    await browser.withVideo(item.url, async tabId => {
      const choice = planned || qualityOptions(job, item, await readBilibiliMediaInfo(browser, item, tabId))[0];
      const quality = choice?.quality;
      await guard();
      await update({ requestedQuality: quality, plannedBytes: choice?.bytes ?? null });
      const expectedPageId = makeVideoId(item.bvid, item.cid);
      const existing = item.cacheId ? (await browser.send("GET_VIDEO", { videoId: item.cacheId })).video : null;
      await guard();
      const resumable = existing?.pageId === expectedPageId && Number(existing.createdAt || 0) === item.cacheCreatedAt && existing.status === "paused";
      const { video, pageChanged } = resumable
        ? await browser.send("RESUME_CACHE", { videoId: existing.id, createdAt: item.cacheCreatedAt, tabId })
        : await browser.send("START_CACHE", { url: item.url, tabId, mode: job.mode, quality, expectedPageId });
      if (pageChanged || !video?.id || (video.pageId && video.pageId !== expectedPageId)) {
        throw new BilibiliDownloadError(pageChanged ? "PART_CHANGED" : "CACHE_UNAVAILABLE", "扩展暂时无法为此分 P 建立缓存。");
      }
      target = { videoId: video.id, createdAt: Number(video.createdAt) || 0 };
      await update({ cacheId: target.videoId, cacheCreatedAt: target.createdAt });
      let current = video;
      for (;;) {
        const latest = (await guard()).items.find(part => part.page === item.page);
        if (!current || !["downloading", "complete"].includes(current.status)) {
          throw new BilibiliDownloadError("CACHE_INTERRUPTED", "扩展缓存中断。重新尝试可复用已有断点。");
        }
        const cachedBytes = committedBytes(current), progress = taskProgress(current), totalBytes = Number(current.totalBytes) || null;
        if (latest.state !== "downloading" || latest.cachedBytes !== cachedBytes || latest.totalBytes !== totalBytes || latest.progress !== progress) {
          await update({ state: "downloading", progress, cachedBytes, totalBytes });
        }
        if (current.status === "complete") break;
        await delay(700, undefined, { signal });
        ({ video: current } = await browser.send("GET_VIDEO", { videoId: target.videoId }));
      }
      if (!hasCompleteByteCount(current)) throw new BilibiliDownloadError("CACHE_INCOMPLETE", "扩展缓存缺少媒体数据，请重试。");
      const audioOnly = job.mode === "audio";
      if (isAudioOnlyCache(current) !== audioOnly || (!audioOnly && Number(current.quality) !== quality)) {
        throw new BilibiliDownloadError("FORMAT_CHANGED", "实际缓存的媒体与请求不符，请重新查询可用画质。");
      }
      const qualityLabel = (audioOnly ? current.audioLabel || current.qualityLabel : current.qualityLabel) || "";
      const codec = audioOnly ? current.tracks?.audio?.codecs || "" : current.codecLabel || current.codec || "";
      await update({ state: "exporting", qualityLabel, codec });
      let subtitle;
      if (job.subtitles) {
        try {
          subtitle = { ...await readBilibiliSubtitles(browser, item, job.subtitles.language), format: job.subtitles.format };
        } catch (error) {
          if (stopped(error)) throw error;
          subtitle = { status: "error", source: "bilibili", error: reportedError(error) };
        }
      }
      const latest = await guard();
      const saved = await browser.exportFiles(target.videoId, item.key, {
        subtitle, beforePublish: guard,
        maxBytes: job.maxTotalBytes === undefined ? undefined : job.maxTotalBytes - completedBytes(latest),
        metadata: { url: item.url, page: item.page, bvid: item.bvid, cid: item.cid, title: item.title, partTitle: item.partTitle,
          qualityLabel, codec, requestedQuality: quality }
      });
      await update({ ...saved, state: "complete", progress: 1 });
    });
  } catch (error) {
    if (stopped(error)) {
      if (target && !leaseSignal.aborted) await browser.send("PAUSE_CACHE", target).catch(() => {});
      throw error;
    }
    if (sessionBlocked(error)) throw error;
    await update({ state: "failed", error: reportedError(error) });
  }
}
