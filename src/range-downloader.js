import { parseContentRange } from "./utils.js";

export const DEFAULT_RANGE_CONCURRENCY = 3;
export const DEFAULT_RANGE_SIZE = 2 * 1024 * 1024;
export const DEFAULT_PROBE_SIZE = 64 * 1024;
export const DEFAULT_PROBE_TIMEOUT = 8_000;
export const DEFAULT_RANGE_TIMEOUT = 30_000;

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
  if (!candidates.length) throw new Error("没有可用的 CDN 地址");
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
  if (!successful.length) throw errors[0] || new Error("所有 CDN 测速请求均失败");

  const totalBytes = knownTotal || successful[0].totalBytes;
  const ranked = successful
    .filter((entry) => entry.totalBytes === totalBytes)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) throw new Error("CDN 返回的媒体大小不一致");

  const rankedUrls = ranked.map((entry) => entry.url);
  const remaining = candidates.filter((url) => !rankedUrls.includes(url));
  return {
    urls: [...rankedUrls, ...remaining],
    totalBytes,
    probes: ranked.map(({ url, host, bytes, elapsedMs, score }) => ({
      url,
      host,
      bytes,
      elapsedMs,
      score
    }))
  };
}

export async function downloadByteRanges(options) {
  const ranges = buildByteRanges(options.start, options.totalBytes, options.rangeSize);
  const concurrency = Math.max(1, Math.min(
    Math.floor(Number(options.concurrency) || DEFAULT_RANGE_CONCURRENCY),
    ranges.length || 1
  ));
  const metrics = {
    strategy: "parallel-range",
    concurrency,
    rangeSize: Math.max(1, Math.floor(Number(options.rangeSize) || DEFAULT_RANGE_SIZE)),
    requestCount: 0,
    retryCount: 0,
    networkBytes: 0,
    committedBytes: 0,
    rangeCount: ranges.length,
    startedAt: Date.now()
  };
  if (!ranges.length) return { metrics: { ...metrics, completedAt: Date.now() } };

  const urls = uniqueHttpUrls(options.urls);
  if (!urls.length) throw new Error("没有可用的 CDN 地址");
  const fetchImpl = options.fetchImpl || platformFetch;
  const completed = new Map();
  let nextRange = 0;
  let nextCommit = 0;
  let fatalError = null;
  let commitQueue = Promise.resolve();

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
      metrics.committedBytes += batch.reduce((sum, entry) => sum + entry.data.size, 0);
    });
    commitQueue = operation;
    return operation;
  };

  const worker = async () => {
    while (!fatalError) {
      const index = nextRange;
      nextRange += 1;
      if (index >= ranges.length) return;
      try {
        const result = await fetchRangeWithFallback(urls, ranges[index], {
          fetchImpl,
          signal: options.signal,
          totalBytes: options.totalBytes,
          timeoutMs: options.timeoutMs,
          metrics,
          receive
        });
        await commitCompleted(result);
      } catch (error) {
        fatalError = error;
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
  if (fatalError) throw fatalError;
  if (nextCommit !== ranges.length) throw new Error("并发分块没有形成连续结果");
  metrics.completedAt = Date.now();
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
    if (attempt.didTimeout()) throw new Error("CDN 测速超时");
    throw error;
  } finally {
    attempt.cleanup();
  }
  const elapsedMs = Math.max(now() - startedAt, 1);
  return {
    url,
    host: getHost(url),
    totalBytes: result.totalBytes,
    bytes: result.data.size,
    elapsedMs,
    score: result.data.size / elapsedMs
  };
}

async function fetchRangeWithFallback(urls, range, options) {
  let lastError;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    let attemptBytes = 0;
    const attempt = createAttemptSignal(options.signal, options.timeoutMs || DEFAULT_RANGE_TIMEOUT);
    options.metrics.requestCount += 1;
    if (index > 0) options.metrics.retryCount += 1;
    try {
      const result = await readRange(url, range.start, range.end, {
        fetchImpl: options.fetchImpl,
        signal: attempt.signal,
        expectedTotal: options.totalBytes,
        requireExactEnd: true,
        onReceive: (bytes) => {
          attemptBytes += bytes;
          options.receive(bytes, { host: getHost(url), range });
        }
      });
      return { ...result, range, url, host: getHost(url) };
    } catch (error) {
      if (attemptBytes) options.receive(-attemptBytes, { host: getHost(url), range, rollback: true });
      if (options.signal?.aborted) throw error;
      if (attempt.didTimeout()) {
        lastError = new Error("CDN 分块下载超时，已尝试切换备用节点");
      } else {
        if (error?.name === "AbortError") throw error;
        lastError = error;
      }
    } finally {
      attempt.cleanup();
    }
  }
  throw lastError || new Error("所有 CDN 地址均无法完成该分块");
}

async function readRange(url, start, end, options) {
  const response = await options.fetchImpl(url, {
    credentials: "omit",
    headers: { Range: `bytes=${start}-${end}` },
    signal: options.signal
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error("CDN 拒绝了范围下载（HTTP 403）");
    if (response.status === 429) throw new Error("CDN 请求过于频繁（HTTP 429）");
    throw new Error(`CDN 范围下载失败（HTTP ${response.status}）`);
  }
  if (response.status !== 206) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("CDN 没有按 Range 返回 HTTP 206");
  }
  const contentRange = parseContentRange(response.headers.get("content-range"));
  if (!contentRange || contentRange.start !== start) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("CDN 返回了错误的范围起点");
  }
  if (options.requireExactEnd && contentRange.end !== end) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("CDN 没有返回完整的固定范围");
  }
  if (contentRange.end > end) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("CDN 返回范围超过请求终点");
  }
  if (options.expectedTotal > 0 && contentRange.total !== options.expectedTotal) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("CDN 返回的媒体总大小不一致");
  }
  if (!response.body) throw new Error("浏览器没有提供可读取的下载流");

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
  if (received !== expectedBytes) throw new Error("CDN 范围响应提前结束");
  return {
    data: new Blob(parts, { type: "application/octet-stream" }),
    totalBytes: contentRange.total,
    contentRange
  };
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

function createAttemptSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("CDN 分块请求超时", "TimeoutError"));
  }, Math.max(1, Number(timeoutMs) || DEFAULT_RANGE_TIMEOUT));
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}
