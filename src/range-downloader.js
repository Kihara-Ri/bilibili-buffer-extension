import { t } from "./i18n.js";
import { parseContentRange } from "./utils.js";

export const DEFAULT_RANGE_CONCURRENCY = 6;
export const DEFAULT_RANGE_SIZE = 2 * 1024 * 1024;
export const DEFAULT_PROBE_SIZE = 64 * 1024;
export const DEFAULT_PROBE_TIMEOUT = 8_000;
// 分块只看「停滞」：首字节或正文连续这么久没有新字节才算卡住。
// 不设总时长上限——海外单连接常只有几十 KB/s，2 MiB 分块正常也可能要一分钟，
// 旧的 30 秒总超时会把仍在稳定传输的分块判死，进而让整个任务失败、等一分钟再续传。
export const DEFAULT_RANGE_TIMEOUT = 20_000;
// 单个分块的尝试次数：有别的地址就立刻换，同一地址重试按 1→8 秒退避。
export const DEFAULT_RANGE_ATTEMPTS = 6;
const DEFAULT_RETRY_BASE_MS = 1_000;

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
  const results = await Promise.allSettled(probeTargets.map((url) => probeCandidate(url, {
    fetchImpl,
    signal: options.signal,
    start: knownTotal > 0 ? Math.min(probeStart, knownTotal - 1) : probeStart,
    size: probeSize,
    expectedTotal: knownTotal,
    timeoutMs: options.timeoutMs || DEFAULT_PROBE_TIMEOUT
  })));

  const successful = [];
  const errors = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") successful.push(result.value);
    else errors.push(result.reason);
  }
  if (!successful.length) throw errors[0] || new Error(t("err.allProbesFailed"));

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
  let nextRange = 0;
  let nextCommit = 0;
  let fatalError = null;
  let commitQueue = Promise.resolve();
  const controller=new AbortController(),waiters=new Set();let bufferedBytes=0;
  const wake=()=>{for(const resolve of waiters)resolve();waiters.clear();};
  const cancel=()=>{controller.abort(options.signal.reason);wake();};
  options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();
  async function takeRange(){
    for(;;){
      if(controller.signal.aborted)throw controller.signal.reason;
      if(nextRange>=rangeCount)return -1;
      const range=rangeAt(nextRange),size=range.end-range.start+1;
      // 只有事务成功后才释放字节；慢首块与慢磁盘都会对后续请求产生背压。
      if(bufferedBytes+size<=maxBufferedBytes){bufferedBytes+=size;metrics.peakBufferedBytes=Math.max(metrics.peakBufferedBytes,bufferedBytes);return nextRange++;}
      await new Promise(resolve=>waiters.add(resolve));
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
      for (const entry of batch) completed.delete(entry.range.ordinal);
      nextCommit = cursor;
      const committed=batch.reduce((sum,entry)=>sum+entry.data.size,0);
      metrics.committedBytes += committed;bufferedBytes-=committed;wake();
    });
    commitQueue = operation;
    return operation;
  };

  const worker = async () => {
    while (!fatalError) {
      try {
        const index=await takeRange();if(index<0)return;
        const rank = () => rankDynamicCandidates(urls, candidateStats, options.slowTtfbMs);
        const rankedUrls = rank();
        if (rankedUrls[0] !== preferredUrl) {
          preferredUrl = rankedUrls[0];
          metrics.cdnSwitchCount += 1;
        }
        const result = await fetchRangeWithFallback(rank, rangeAt(index), {
          fetchImpl,
          signal: controller.signal,
          totalBytes: options.totalBytes,
          timeoutMs: options.timeoutMs,
          maxAttempts: options.maxAttempts,
          retryBaseMs: options.retryBaseMs,
          slowTtfbMs: options.slowTtfbMs,
          candidateStats,
          metrics,
          receive
        });
        // 已通过 Content-Range 逐字节校验的范围才交给镜像；回调失败绝不影响下载主流程。
        try {
          options.onVerifiedRange?.({
            url: result.url, start: result.range.start, end: result.range.end + 1,
            total: result.totalBytes, data: result.data, contentType: result.contentType
          });
        } catch { /* 镜像只是优化，失败不能中断下载。 */ }
        await commitCompleted(result);
      } catch (error) {
        fatalError ||= error;controller.abort(fatalError);wake();
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  try {
    await commitQueue;
  } catch (error) {
    fatalError ||= error;
  }
  options.signal?.removeEventListener("abort",cancel);wake();
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
  const startedAt = now();
  const end = options.start + options.size - 1;
  const attempt = createAttemptSignal(options.signal, options.timeoutMs || DEFAULT_PROBE_TIMEOUT);
  let result;
  try {
    result = await readRange(url, options.start, end, {
      fetchImpl: options.fetchImpl,
      signal: attempt.signal,
      expectedTotal: options.expectedTotal,
      requireExactEnd: false
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
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
  const rejected = new Set();
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_RANGE_ATTEMPTS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const url = rank().find((candidate) => !rejected.has(candidate));
    if (!url) break;
    if (attempt > 0 && url === lastUrl) {
      await abortableDelay(Math.min(8_000, (Number(options.retryBaseMs) || DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1)), options.signal);
    }
    lastUrl = url;
    let attemptBytes = 0;
    const idle = createAttemptSignal(options.signal, options.timeoutMs || DEFAULT_RANGE_TIMEOUT);
    options.metrics.requestCount += 1;
    if (attempt > 0) options.metrics.retryCount += 1;
    try {
      const result = await readRange(url, range.start, range.end, {
        fetchImpl: options.fetchImpl,
        signal: idle.signal,
        expectedTotal: options.totalBytes,
        requireExactEnd: true,
        onReceive: (bytes) => {
          idle.touch();
          attemptBytes += bytes;
          options.receive(bytes, { host: getHost(url), range });
        },
        onHeaders: idle.touch
      });
      recordCandidateSuccess(options.candidateStats?.get(url), result, options.slowTtfbMs);
      if (isSlowCandidateResult(options.candidateStats?.get(url), result, options.slowTtfbMs)) {
        options.metrics.slowRequestCount += 1;
      }
      return { ...result, range, url, host: getHost(url) };
    } catch (error) {
      recordCandidateFailure(options.candidateStats?.get(url));
      if (attemptBytes) options.receive(-attemptBytes, { host: getHost(url), range, rollback: true });
      if (options.signal?.aborted) throw error;
      if (!idle.didTimeout() && error?.name === "AbortError") throw error;
      lastError = idle.didTimeout() ? new Error(t("err.chunkStalled")) : error;
      if (/HTTP 403/.test(String(error?.message))) rejected.add(url);
    } finally {
      idle.cleanup();
    }
  }
  throw lastError || new Error(t("err.chunkAllFailed"));
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
  const response = await options.fetchImpl(url, {
    credentials: "omit",
    headers: { Range: `bytes=${start}-${end}` },
    signal: options.signal
  });
  const headersAt = now();
  options.onHeaders?.();
  if (!response.ok) {
    if (response.status === 403) throw new Error(t("err.range403"));
    if (response.status === 429) throw new Error(t("err.range429"));
    throw new Error(t("err.rangeHttp", { status: response.status }));
  }
  if (response.status !== 206) {
    await response.body?.cancel?.().catch(() => {});
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

  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    options.onReceive?.(value.byteLength);
  }
  const expectedBytes = contentRange.end - contentRange.start + 1;
  if (received !== expectedBytes) throw new Error(t("err.rangeEnded"));
  const completedAt = now();
  const ttfbMs = Math.max(0, headersAt - startedAt);
  const totalMs = Math.max(0, completedAt - startedAt);
  const bodyMs = Math.max(completedAt - headersAt, 0.1);
  return {
    data: new Blob(parts, { type: "application/octet-stream" }),
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
