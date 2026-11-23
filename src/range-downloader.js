import { t } from "./i18n.js";
import { parseContentRange } from "./utils.js";

export const DEFAULT_RANGE_CONCURRENCY = 6;
export const DEFAULT_RANGE_SIZE = 2 * 1024 * 1024;
export const DEFAULT_PROBE_SIZE = 64 * 1024;
export const DEFAULT_PROBE_TIMEOUT = 8_000;
const PROBE_GRACE_MS = 200;
// 分块只看「停滞」：首字节或正文连续这么久没有新字节才算卡住。
// 不设总时长上限——海外单连接常只有几十 KB/s，2 MiB 分块正常也可能要一分钟，
// 旧的 30 秒总超时会把仍在稳定传输的分块判死，进而让整个任务失败、等一分钟再续传。
export const DEFAULT_RANGE_TIMEOUT = 20_000;
// 单个分块的尝试次数：有别的地址就立刻换，同一地址重试按 1→8 秒退避。
export const DEFAULT_RANGE_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_MS = 1_000;
// 队头对冲：分块只能按序落盘，最前面那块卡在一条「涓流但不停滞」的连接上时，后面的块下完也只能在窗口里干等，
// 停滞超时又永远不触发。空闲工作者等了这么久（且不短于正常分块耗时的 3 倍）就对队头分块再发一次请求，
// 先拿到完整正文的一方胜出。同时在跑的对冲至多两路，额外内存至多 2 × 分块大小。
export const DEFAULT_HEDGE_AFTER_MS = 2_000;
const MAX_HEDGES_IN_FLIGHT = 2;
const HEDGE_LOST = new DOMException("对冲中另一方已完成", "AbortError");
function strongEtag(value) {
  return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : "";
}

function mediaVersionMismatch() {
  return Object.assign(new Error(t("err.mediaVersionMismatch")), { code: "MEDIA_VERSION_MISMATCH" });
}

export function buildByteRanges(start, totalBytes, rangeSize = DEFAULT_RANGE_SIZE) {
  const first = Math.max(0, Math.floor(Number(start) || 0));
  const total = Math.max(0, Math.floor(Number(totalBytes) || 0));
  const size = Math.max(1, Math.floor(Number(rangeSize) || DEFAULT_RANGE_SIZE));
  const ranges = [];
  for (let offset = first, ordinal = 0; offset < total; offset += size, ordinal += 1) {
    ranges.push({
      ordinal,
      start: offset,
      end: Math.min(total - 1, offset + size - 1)
    });
  }
  return ranges;
}

export async function rankRangeCandidates(urls, options = {}) {
  const candidates = uniqueHttpUrls(urls);
  if (!candidates.length) throw new Error(t("err.noCdn"));
  const fetchImpl = options.fetchImpl || platformFetch;
  const probeStart = Math.max(0, Math.floor(Number(options.start) || 0));
  const knownTotal = Math.max(0, Math.floor(Number(options.totalBytes) || 0));
  const probeSize = Math.max(1, Math.floor(Number(options.probeSize) || DEFAULT_PROBE_SIZE));
  const probeTargets = candidates.slice(0, Math.max(1, Number(options.maxCandidates) || 3));
  const probes = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, probes.signal]) : probes.signal;
  let graceTimer;
  const results = await Promise.allSettled(probeTargets.map(async url => {
    const result = await probeCandidate(url, {
      fetchImpl,
      signal,
      budget: options.budget,
      start: knownTotal > 0 ? Math.min(probeStart, knownTotal - 1) : probeStart,
      size: probeSize,
      expectedTotal: knownTotal,
      getEtag: () => strongEtag(options.etag),
      timeoutMs: options.timeoutMs || DEFAULT_PROBE_TIMEOUT
    });
    // 已经找到可用节点后，只给其他节点一小段比较时间。未探完的 URL 仍可用于正式下载。
    graceTimer ??= setTimeout(() => probes.abort(), PROBE_GRACE_MS);
    return result;
  }));
  clearTimeout(graceTimer);
  options.signal?.throwIfAborted();

  const successful = [];
  const errors = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") successful.push(result.value);
    else errors.push(result.reason);
  }
  if (!successful.length) throw errors.find(error => error?.code === "MEDIA_VERSION_MISMATCH") || errors[0] || new Error(t("err.allProbesFailed"));

  const totalBytes = knownTotal || successful[0].totalBytes;
  const ranked = successful
    .filter((entry) => entry.totalBytes === totalBytes)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) throw new Error(t("err.cdnSizeMismatch"));

  const rankedUrls = ranked.map((entry) => entry.url);
  const remaining = candidates.filter((url) => !rankedUrls.includes(url));
  return {
    urls: [...rankedUrls, ...remaining],
    totalBytes,
    probes: ranked.map(({ url, host, bytes, elapsedMs, ttfbMs, bodyMs, throughputKbps, score }) => ({
      url,
      host,
      bytes,
      elapsedMs,
      ttfbMs,
      bodyMs,
      throughputKbps,
      score
    }))
  };
}

export async function downloadByteRanges(options) {
  // 整个乱序窗口（含正在下载和等待落盘的块）有字节上限，而不只是限制连接数。
  const maxBufferedBytes=Math.max(1,Math.min(16*1024*1024,Math.floor(Number(options.maxBufferedBytes)||16*1024*1024)));
  const rangeSize=Math.max(1,Math.min(maxBufferedBytes,DEFAULT_RANGE_SIZE,Math.floor(Number(options.rangeSize)||DEFAULT_RANGE_SIZE)));
  if(!Number.isSafeInteger(Number(options.totalBytes))||Number(options.totalBytes)<0)throw Error(t('err.invalidTotal'));
  const first=Math.max(0,Math.floor(Number(options.start)||0));
  let etag = strongEtag(options.etag);
  const verifyEtag = (received, requested) => {
    // 并发发出时可能还没有校验器。拿到首个强 ETag 后，任何分块都必须匹配，
    // 或由同一 If-Range 条件请求返回 206。无强 ETag 的旧 CDN 仍走范围与长度校验。
    if (etag && (received || requested) !== etag) throw mediaVersionMismatch();
    etag ||= received;
  };
  const rangeCount=Math.max(0,Math.ceil((Number(options.totalBytes)-first)/rangeSize));
  const rangeAt=ordinal=>({ordinal,start:first+ordinal*rangeSize,end:Math.min(Number(options.totalBytes)-1,first+(ordinal+1)*rangeSize-1)});
  const concurrency = Math.max(1, Math.min(
    Math.floor(Number(options.concurrency) || DEFAULT_RANGE_CONCURRENCY),
    rangeCount || 1, 32, Math.max(1,Math.floor(maxBufferedBytes/rangeSize))
  ));
  const metrics = {
    strategy: "parallel-range",
    concurrency,
    rangeSize, maxBufferedBytes, peakBufferedBytes: 0,
    requestCount: 0,
    retryCount: 0,
    slowRequestCount: 0,
    cdnSwitchCount: 0,
    hedgeCount: 0,
    hedgeWins: 0,
    networkBytes: 0,
    committedBytes: 0,
    rangeCount,
    startedAt: Date.now()
  };
  if (!rangeCount) return { metrics: { ...metrics, completedAt: Date.now() } };

  const urls = uniqueHttpUrls(options.urls);
  if (!urls.length) throw new Error(t("err.noCdn"));
  const fetchImpl = options.fetchImpl || platformFetch;
  const candidateStats = new Map(urls.map((url, index) => [url, makeCandidateStat(url, index)]));
  let preferredUrl = urls[0];
  const completed = new Map();
  const reservations = new Set();
  let nextRange = 0;
  let nextCommit = 0;
  let fatalError = null;
  let commitQueue = Promise.resolve();
  const controller=new AbortController(),waiters=new Set();let bufferedBytes=0;
  const wake=()=>{for(const resolve of waiters)resolve();waiters.clear();};
  const cancel=()=>{controller.abort(options.signal.reason);wake();};
  options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
  // 在途分块：ordinal → 槽位。槽位在胜出的一次尝试拿到完整正文时移除（随后才排队落盘）。
  const slots = new Map();
  const hedgeAfterMs = Math.max(1, Number(options.hedgeAfterMs) || DEFAULT_HEDGE_AFTER_MS);
  const durations = [];
  let hedgesInFlight = 0;
  // 对冲门槛随实测分块耗时自适应：正常分块本来就要 5 秒的慢链路上，不能 2 秒就重复请求。
  const hedgeThreshold = () => Math.max(hedgeAfterMs, 3 * (percentile(durations, 0.5) || 0));
  /** 队头（最小序号）的在途分块，等得够久且当前没有对冲在跑时才可对冲。 @returns {object|null} */
  const hedgeCandidate = () => {
    if (hedgesInFlight >= MAX_HEDGES_IN_FLIGHT || !slots.size) return null;
    const head = slots.get(Math.min(...slots.keys()));
    if (!head || head.liveHedge || !head.busyUrls.size) return null;
    return now() - Math.max(head.lastHedgeAt, head.startedAt) >= hedgeThreshold() ? head : null;
  };
  /** 下次可能出现对冲时机的等待毫秒数；没有在途分块时返回 0（只等唤醒）。 */
  const nextHedgeCheck = () => {
    if (!slots.size) return 0;
    const head = slots.get(Math.min(...slots.keys()));
    if (!head.busyUrls.size) return 0;
    return Math.max(10, Math.max(head.lastHedgeAt, head.startedAt) + hedgeThreshold() - now());
  };
  /**
   * 取下一份工作：优先领新分块；窗口已满或分块已领完时，不再空等，而是检查队头是否需要对冲。
   * @returns {Promise<{ordinal:number, hedge:boolean}|null>} null 表示没有新分块、也没有在途分块，工作者退出
   */
  async function takeWork(){
    for(;;){
      if(controller.signal.aborted)throw controller.signal.reason;
      if(nextRange<rangeCount){
        const range=rangeAt(nextRange),size=range.end-range.start+1;
        // 只有事务成功后才释放字节；慢首块与慢磁盘都会对后续请求产生背压。
        if(bufferedBytes+size<=maxBufferedBytes){bufferedBytes+=size;metrics.peakBufferedBytes=Math.max(metrics.peakBufferedBytes,bufferedBytes);return {ordinal:nextRange++,hedge:false};}
      } else if(!slots.size) return null;
      const head = hedgeCandidate();
      if (head) {
        hedgesInFlight += 1; head.liveHedge = true; head.lastHedgeAt = now();
        return { ordinal: head.ordinal, hedge: true };
      }
      const waitMs = nextHedgeCheck();
      await new Promise(resolve=>{
        let timer = null;
        const done = () => { clearTimeout(timer); resolve(); };
        waiters.add(done);
        if (waitMs) timer = setTimeout(() => { waiters.delete(done); resolve(); }, waitMs);
      });
    }
  }


  const receive = (delta, detail = {}) => {
    if (delta > 0) metrics.networkBytes += delta;
    options.onReceive?.(delta, detail);
  };

  const commitCompleted = (result) => {
    completed.set(result.range.ordinal, result);
    const operation = commitQueue.then(async () => {
      const batch = [];
      let cursor = nextCommit;
      while (completed.has(cursor)) {
        const entry = completed.get(cursor);
        batch.push(entry);
        cursor += 1;
      }
      if (!batch.length) return;
      await options.onCommit(batch);
      for (const entry of batch) {
        completed.delete(entry.range.ordinal);
        entry.releaseBytes?.();
      }
      nextCommit = cursor;
      const committed=batch.reduce((sum,entry)=>sum+entry.data.size,0);
      metrics.committedBytes += committed;bufferedBytes-=committed;wake();
    });
    commitQueue = operation;
    return operation;
  };
  const fail = (error) => { fatalError ||= error; controller.abort(fatalError); wake(); };

  /**
   * 跑一次分块尝试。对冲尝试与原尝试共享槽位：先拿到完整正文的一方胜出并取消另一方；
   * 败方已收字节在 fetchRangeWithFallback 里回滚，所以界面速度与在途字节不会重复计入。
   * 只有槽位里最后一个存活的尝试失败，才算这个分块失败（进而让整轨失败，交给上层续传）。
   */
  async function runAttempt({ ordinal, hedge }) {
    let slot = slots.get(ordinal);
    if (hedge && (!slot || slot.done)) { hedgesInFlight -= 1; wake(); return; }
    if (!slot) {
      slot = { ordinal, startedAt: 0, lastHedgeAt: 0, done: false, live: 0, liveHedge: hedge, controllers: new Set(), busyUrls: new Map() };
      slots.set(ordinal, slot);
    }
    const attempt = new AbortController();
    const abortFromJob = () => attempt.abort(controller.signal.reason);
    if (controller.signal.aborted) abortFromJob();
    else controller.signal.addEventListener("abort", abortFromJob, { once: true });
    slot.controllers.add(attempt);
    slot.live += 1;
    let result = null;
    let releaseBytes;
    try {
      const range = rangeAt(ordinal);
      if (options.budget) {
        const size = range.end - range.start + 1;
        // 按原分块序号先登记正文。对冲只用已有余量，避免一份副本排在正本前面。
        const permit = hedge ? options.budget.tryReserveBytes(size) : await options.budget.reserveBytes(size, attempt.signal);
        if (!permit) return;
        const release = () => { reservations.delete(release); permit(); };
        reservations.add(release);
        releaseBytes = release;
      }
      if (hedge) metrics.hedgeCount += 1;
      const rank = () => {
        const ranked = rankDynamicCandidates(urls, candidateStats, options.slowTtfbMs);
        if (!hedge) return ranked;
        // 对冲优先换一个节点；只有一个节点时仍可用同一地址的新连接，绕开那条涓流连接。
        return [...ranked.filter((url) => !slot.busyUrls.has(url)), ...ranked.filter((url) => slot.busyUrls.has(url))];
      };
      const rankedUrls = rank();
      if (!hedge && rankedUrls[0] !== preferredUrl) {
        preferredUrl = rankedUrls[0];
        metrics.cdnSwitchCount += 1;
      }
      result = await fetchRangeWithFallback(rank, range, {
        fetchImpl,
        budget: options.budget,
        signal: attempt.signal,
        totalBytes: options.totalBytes,
        getEtag: () => etag,
        verifyEtag,
        timeoutMs: options.timeoutMs,
        maxAttempts: options.maxAttempts,
        retryBaseMs: options.retryBaseMs,
        slowTtfbMs: options.slowTtfbMs,
        candidateStats,
        metrics,
        receive,
        onAttemptUrl(url, active) {
          const count = slot.busyUrls.get(url) || 0;
          if (active) {
            if (!slot.busyUrls.size) slot.startedAt = now();
            slot.busyUrls.set(url, count + 1);
            wake();
          } else if (count > 1) slot.busyUrls.set(url, count - 1);
          else slot.busyUrls.delete(url);
        }
      });
      if (slot.done) {
        // 与胜方几乎同时完成：这份正文作废，已计入的字节回滚。
        receive(-result.data.size, { range: result.range, rollback: true });
        result = null;
      } else {
        // 正文胜方交给提交队列，败方和取消的正文由各自尝试归还。
        result.releaseBytes = releaseBytes;
        releaseBytes = null;
        slot.done = true;
        slots.delete(ordinal);
        for (const other of slot.controllers) if (other !== attempt) other.abort(HEDGE_LOST);
        if (hedge) metrics.hedgeWins += 1;
        boundedPush(durations, now() - slot.startedAt, 50);
      }
    } catch (error) {
      // 败方被取消，或另一个尝试仍在跑：都不算这个分块失败。
      if (!slot.done && !controller.signal.aborted && attempt.signal.reason !== HEDGE_LOST && slot.live <= 1) fail(error);
      else if (controller.signal.aborted) fatalError ||= error;
    } finally {
      releaseBytes?.();
      slot.live -= 1;
      slot.controllers.delete(attempt);
      controller.signal.removeEventListener("abort", abortFromJob);
      if (hedge) { hedgesInFlight -= 1; slot.liveHedge = false; }
      wake();
    }
    if (!result) return;
    // 已通过 Content-Range 逐字节校验的范围才交给镜像；回调失败绝不影响下载主流程。
    try {
      options.onVerifiedRange?.({
        url: result.url, start: result.range.start, end: result.range.end + 1,
        total: result.totalBytes, data: result.data, contentType: result.contentType
      });
    } catch { /* 镜像只是优化，失败不能中断下载。 */ }
    try { await commitCompleted(result); } catch (error) { fail(error); }
  }

  const worker = async () => {
    while (!fatalError) {
      let work;
      try { work = await takeWork(); } catch (error) { fail(error); return; }
      if (!work) return;
      await runAttempt(work);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    try { await commitQueue; }
    catch (error) { fatalError ||= error; }
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    for (const release of reservations) release();
    wake();
  }
  if (fatalError) throw fatalError;
  if (nextCommit !== rangeCount) throw new Error(t("err.notContiguous"));
  metrics.completedAt = Date.now();
  metrics.cdnHost = getHost(preferredUrl);
  metrics.hosts = publicCandidateStats(candidateStats);
  const ttfbs = [...candidateStats.values()].flatMap((entry) => entry.ttfbs);
  metrics.ttfbP50 = percentile(ttfbs, 0.5);
  metrics.ttfbP95 = percentile(ttfbs, 0.95);
  return { metrics };
}

async function probeCandidate(url, options) {
  const end = options.start + options.size - 1;
  const operation = (signal) => probeRange(url, end, options, signal);
  if (!options.budget) return operation(options.signal);
  const release = await options.budget.reserveBytes(options.size, options.signal);
  try { return await options.budget.runRequest(operation, options.signal); }
  finally { release(); }
}

async function probeRange(url, end, options, signal) {
  const startedAt = now();
  const attempt = createAttemptSignal(signal, options.timeoutMs || DEFAULT_PROBE_TIMEOUT);
  let result;
  try {
    result = await readRange(url, options.start, end, {
      fetchImpl: options.fetchImpl,
      signal: attempt.signal,
      expectedTotal: options.expectedTotal,
      getEtag: options.getEtag,
      requireExactEnd: false
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (attempt.didTimeout()) throw new Error(t("err.probeTimeout"));
    throw error;
  } finally {
    attempt.cleanup();
  }
  const elapsedMs = Math.max(now() - startedAt, 1);
  // 测速排序仍按端到端有效吞吐，TTFB 与正文吞吐另行保留，避免小探针的正文计时噪声反客为主。
  const score = result.data.size * 8 / elapsedMs;
  return {
    url,
    host: getHost(url),
    totalBytes: result.totalBytes,
    bytes: result.data.size,
    elapsedMs,
    ttfbMs: result.ttfbMs,
    bodyMs: result.bodyMs,
    throughputKbps: result.throughputKbps,
    score
  };
}

/**
 * 下载一个固定分块，在分块内部消化可恢复的故障，只有确实无法完成时才向上抛（导致整个任务重试）。
 * - 每次尝试前按实时成绩重新排序候选：失败多的地址会被排到后面，下一次自然换节点；
 * - 换到别的地址立即重试；只剩同一地址时按 1→8 秒退避，给节点或网络恢复的时间；
 * - 403 表示该签名地址被拒，从本分块的候选里剔除；全部被拒就抛出，由上层刷新播放地址。
 * @param {() => string[]} rank 返回当前排序后的候选地址
 */
async function fetchRangeWithFallback(rank, range, options) {
  let lastError, lastUrl = null;
  let versionError;
  const rejected = new Set();
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_RANGE_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidates = rank().filter(candidate => !rejected.has(candidate));
    const url = candidates.find(candidate => candidate !== lastUrl) || candidates[0];
    if (!url) break;
    if (attempt > 0 && url === lastUrl) {
      await abortableDelay(Math.min(8_000, (Number(options.retryBaseMs) || DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1)), options.signal);
    }
    lastUrl = url;
    if (attempt > 0) options.metrics.retryCount += 1;
    const request = (signal) => fetchRangeAttempt(url, range, options, signal);
    try {
      const result = options.budget
        ? await options.budget.runRequest(request, options.signal)
        : await request(options.signal);
      recordCandidateSuccess(options.candidateStats?.get(url), result, options.slowTtfbMs);
      if (isSlowCandidateResult(options.candidateStats?.get(url), result, options.slowTtfbMs)) {
        options.metrics.slowRequestCount += 1;
      }
      return { ...result, range, url, host: getHost(url) };
    } catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw error;
      recordCandidateFailure(options.candidateStats?.get(url));
      lastError = error;
      if (error?.code === "MEDIA_VERSION_MISMATCH") versionError = error;
      if (error?.code === "MEDIA_VERSION_MISMATCH" || /HTTP 403/.test(String(error?.message))) rejected.add(url);
    }
  }
  throw versionError || lastError || new Error(t("err.chunkAllFailed"));
}

async function fetchRangeAttempt(url, range, options, signal) {
  const idle = createAttemptSignal(signal, options.timeoutMs || DEFAULT_RANGE_TIMEOUT);
  options.onAttemptUrl?.(url, true);
  options.metrics.requestCount += 1;
  let attemptBytes = 0;
  const host = getHost(url);
  try {
    return await readRange(url, range.start, range.end, {
      fetchImpl: options.fetchImpl,
      signal: idle.signal,
      expectedTotal: options.totalBytes,
      getEtag: options.getEtag,
      verifyEtag: options.verifyEtag,
      requireExactEnd: true,
      onReceive(bytes) {
        idle.touch();
        attemptBytes += bytes;
        options.receive(bytes, { host, range });
      },
      onHeaders: idle.touch
    });
  } catch (error) {
    if (attemptBytes) options.receive(-attemptBytes, { host, range, rollback: true });
    signal?.throwIfAborted();
    if (idle.didTimeout()) throw new Error(t("err.chunkStalled"));
    throw error;
  } finally {
    idle.cleanup();
    options.onAttemptUrl?.(url, false);
  }
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readRange(url, start, end, options) {
  const startedAt = now();
  const expectedEtag = options.getEtag?.() || "";
  const headers = { Range: `bytes=${start}-${end}` };
  if (expectedEtag) headers["If-Range"] = expectedEtag;
  const response = await options.fetchImpl(url, {
    credentials: "omit",
    headers,
    priority: "low",
    signal: options.signal
  });
  const headersAt = now();
  options.onHeaders?.();
  if (!response.ok) {
    await response.body?.cancel?.().catch(() => {});
    if (response.status === 403) throw new Error(t("err.range403"));
    if (response.status === 429) throw new Error(t("err.range429"));
    throw new Error(t("err.rangeHttp", { status: response.status }));
  }
  if (response.status !== 206) {
    await response.body?.cancel?.().catch(() => {});
    if (expectedEtag) throw mediaVersionMismatch();
    throw new Error(t("err.not206"));
  }
  const contentRange = parseContentRange(response.headers.get("content-range"));
  if (!contentRange || contentRange.start !== start) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(t("err.wrongStart"));
  }
  if (options.requireExactEnd && contentRange.end !== end) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(t("err.notFullRange"));
  }
  if (contentRange.end > end) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(t("err.pastEnd"));
  }
  if (options.expectedTotal > 0 && contentRange.total !== options.expectedTotal) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error(t("err.totalMismatch"));
  }
  if (!response.body) throw new Error(t("err.noStream"));
  const etag = strongEtag(response.headers.get("etag"));
  try {
    if (expectedEtag && etag && expectedEtag !== etag) throw mediaVersionMismatch();
    options.verifyEtag?.(etag, expectedEtag);
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }

  const reader = response.body.getReader();
  const expectedBytes = contentRange.end - contentRange.start + 1;
  const parts = [];
  let received = 0;
  let ended = false;
  const cancelRead = () => reader.cancel().catch(() => {});
  options.signal?.addEventListener("abort", cancelRead, { once: true });
  try {
    options.signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      // 服务端即使发超长正文，扩展积累的正文仍不能超过预约范围。
      if (value.byteLength > expectedBytes - received) throw new Error(t("err.pastEnd"));
      parts.push(value);
      received += value.byteLength;
      options.onReceive?.(value.byteLength);
    }
    options.signal?.throwIfAborted();
  } finally {
    options.signal?.removeEventListener("abort", cancelRead);
    if (!ended) await cancelRead();
    reader.releaseLock();
  }
  if (received !== expectedBytes) throw new Error(t("err.rangeEnded"));
  const completedAt = now();
  const ttfbMs = Math.max(0, headersAt - startedAt);
  const totalMs = Math.max(0, completedAt - startedAt);
  const bodyMs = Math.max(completedAt - headersAt, 0.1);
  return {
    data: new Blob(parts, { type: "application/octet-stream" }),
    etag: etag || expectedEtag,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    totalBytes: contentRange.total,
    contentRange,
    ttfbMs,
    bodyMs,
    totalMs,
    throughputKbps: received * 8 / bodyMs
  };
}

function makeCandidateStat(url, initialIndex) {
  return {
    url,
    host: getHost(url),
    initialIndex,
    successes: 0,
    errors: 0,
    ttfbs: [],
    hotTtfbs: [],
    throughputsKbps: [],
    lastTtfbMs: null
  };
}

function candidateSlowThreshold(stat, configuredThreshold) {
  const baseline = percentile(stat?.hotTtfbs || [], 0.5);
  return Math.max(200, Number(configuredThreshold) || 800, baseline ? baseline * 6 : 0);
}

function isSlowCandidateResult(stat, result, configuredThreshold) {
  return Number(result?.ttfbMs) > candidateSlowThreshold(stat, configuredThreshold);
}

function recordCandidateSuccess(stat, result, configuredThreshold) {
  if (!stat) return;
  stat.successes += 1;
  stat.lastTtfbMs = Number(result.ttfbMs) || 0;
  boundedPush(stat.ttfbs, stat.lastTtfbMs, 100);
  boundedPush(stat.throughputsKbps, Number(result.throughputKbps) || 0, 100);
  if (!isSlowCandidateResult(stat, result, configuredThreshold)) {
    boundedPush(stat.hotTtfbs, stat.lastTtfbMs, 100);
  }
}

function recordCandidateFailure(stat) {
  if (stat) stat.errors += 1;
}

function rankDynamicCandidates(urls, stats, configuredThreshold) {
  return urls.slice().sort((leftUrl, rightUrl) => {
    const left = stats.get(leftUrl);
    const right = stats.get(rightUrl);
    const leftTier = candidateTier(left, configuredThreshold);
    const rightTier = candidateTier(right, configuredThreshold);
    if (leftTier !== rightTier) return leftTier - rightTier;
    if (leftTier === 0 || leftTier === 2) {
      const ttfbDifference = (percentile(left.ttfbs, 0.5) ?? Infinity) - (percentile(right.ttfbs, 0.5) ?? Infinity);
      if (ttfbDifference) return ttfbDifference;
      const throughputDifference = (percentile(right.throughputsKbps, 0.5) || 0) - (percentile(left.throughputsKbps, 0.5) || 0);
      if (throughputDifference) return throughputDifference;
    }
    return left.initialIndex - right.initialIndex;
  });
}

function candidateTier(stat, configuredThreshold) {
  if (!stat?.successes) return stat?.errors ? 3 : 1;
  if (stat.errors > stat.successes) return 3;
  return stat.lastTtfbMs > candidateSlowThreshold(stat, configuredThreshold) ? 2 : 0;
}

function publicCandidateStats(stats) {
  const hosts = {};
  for (const stat of stats.values()) {
    const current = hosts[stat.host] || {
      successes: 0,
      errors: 0,
      ttfbs: [],
      throughputsKbps: []
    };
    current.successes += stat.successes;
    current.errors += stat.errors;
    current.ttfbs.push(...stat.ttfbs);
    current.throughputsKbps.push(...stat.throughputsKbps);
    hosts[stat.host] = current;
  }
  return Object.fromEntries(Object.entries(hosts).map(([host, stat]) => [host, {
    successes: stat.successes,
    errors: stat.errors,
    ttfbP50: percentile(stat.ttfbs, 0.5),
    ttfbP95: percentile(stat.ttfbs, 0.95),
    throughputKbpsP50: percentile(stat.throughputsKbps, 0.5)
  }]));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function boundedPush(values, value, limit) {
  if (!Number.isFinite(value)) return;
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function uniqueHttpUrls(urls) {
  return [...new Set((Array.isArray(urls) ? urls : [])
    .map((url) => String(url || ""))
    .filter((url) => /^https?:\/\//i.test(url)))];
}

function getHost(input) {
  try {
    return new URL(input).hostname;
  } catch {
    return "";
  }
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function platformFetch(...args) {
  return globalThis.fetch(...args);
}

/**
 * 尝试级信号：父信号取消时随之取消；timeoutMs 内没有任何活动（touch）就以 TimeoutError 中止。
 * 测速探针只在开始时计时一次（不 touch），等价于总时长上限；分块下载每收到数据就 touch。
 */
function createAttemptSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const limit = Math.max(1, Number(timeoutMs) || DEFAULT_RANGE_TIMEOUT);
  let timedOut = false, timer = null;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(t("err.chunkStalled"), "TimeoutError"));
    }, limit);
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
