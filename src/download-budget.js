export const DOWNLOAD_LIMITS = Object.freeze({
  tasks: 2,
  requests: 8,
  playingRequests: 2,
  bytes: 24 * 1024 * 1024
});

const PRESSURE_MAX_AGE = 18_000;
const PLAYBACK_YIELD = new DOMException("为网页播放让出离线连接", "AbortError");
const PRESSURE_ORDER = { idle: 0, playing: 1, urgent: 2 };

/** Offscreen 内共享的任务、连接和工作正文额度。调用方在事务完成或放弃正文后归还字节。 */
export function createDownloadBudget(limits = DOWNLOAD_LIMITS) {
  const jobs = createPermitPool(limits.tasks);
  const requests = createPermitPool(limits.requests);
  const bytes = createPermitPool(limits.bytes);
  const playbackReady = createPermitPool(1);
  const running = new Set();
  const reports = new Map();
  let requestLimit = limits.requests;
  let expiryTimer;

  function applyPressure(level) {
    const next = level === "urgent" ? 0 : level === "playing" ? limits.playingRequests : limits.requests;
    if (next === requestLimit) return;
    requestLimit = next;
    requests.setLimit(next);
    playbackReady.setLimit(level === "urgent" ? 0 : 1);
    // 先给不能从任意字节续传的顺序流留位置，再按发出顺序保留额度内的 Range。
    let spare = next - [...running].filter(request => !request.interrupt).length;
    for (const request of running) {
      if (request.interrupt && --spare < 0) request.interrupt.abort(PLAYBACK_YIELD);
    }
  }

  function refreshPressure() {
    clearTimeout(expiryTimer);
    const now = Date.now();
    let expires = Infinity;
    let level = "idle";
    for (const [key, report] of reports) {
      const deadline = report.sampledAt + PRESSURE_MAX_AGE;
      if (deadline <= now) {
        reports.delete(key);
        continue;
      }
      expires = Math.min(expires, deadline);
      if (PRESSURE_ORDER[report.level] > PRESSURE_ORDER[level]) level = report.level;
    }
    applyPressure(level);
    // 标签关闭、导航、休眠或扩展上下文失联时，即使没有收到 idle 也能自动解除让行。
    if (Number.isFinite(expires)) expiryTimer = setTimeout(refreshPressure, expires - now);
  }

  /** @param {string} documentKey @param {"idle"|"playing"|"urgent"} level @param {number} sampledAt @param {boolean} [fullSpeed] */
  function updatePlayback(documentKey, level, sampledAt, fullSpeed = false) {
    const now = Date.now();
    if (!Object.hasOwn(PRESSURE_ORDER, level) || !Number.isSafeInteger(sampledAt) ||
        sampledAt <= now - PRESSURE_MAX_AGE || sampledAt > now + 1_000 ||
        sampledAt < (reports.get(documentKey)?.sampledAt || 0)) return;
    // 全速只放宽该文档稳定播放时的限速。其他文档的普通播放和所有急需分块依旧优先。
    reports.set(documentKey, { level: level === "playing" && fullSpeed ? "idle" : level, sampledAt });
    refreshPressure();
  }

  /** 排队不计入 CDN 超时或重试。让行中止的 Range 等播放缓和后重新排队。 */
  async function runRequest(operation, signal, { preemptible = true } = {}) {
    for (;;) {
      const release = await requests.acquire(1, signal);
      const interrupt = preemptible ? new AbortController() : null;
      const request = { interrupt };
      try {
        signal?.throwIfAborted();
        // 等待者可能在降额前获准，恢复运行时再核对一遍。
        if (running.size >= requestLimit) continue;
        running.add(request);
        const attempt = interrupt && signal ? AbortSignal.any([signal, interrupt.signal]) : interrupt?.signal || signal;
        return await operation(attempt);
      } catch (error) {
        if (interrupt?.signal.reason !== PLAYBACK_YIELD || signal?.aborted) throw error;
      } finally {
        running.delete(request);
        release();
      }
    }
  }

  return {
    acquireTask: (signal) => jobs.acquire(1, signal),
    reserveBytes: bytes.acquire,
    tryReserveBytes: bytes.tryAcquire,
    runRequest,
    updatePlayback,
    async waitForPlayback(signal) {
      while (requestLimit === 0) {
        const release = await playbackReady.acquire(1, signal);
        release();
      }
      signal?.throwIfAborted();
    }
  };
}

function createPermitPool(capacity) {
  const pending = [];
  let limit = capacity;
  let used = 0;

  function grant(weight) {
    used += weight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      used -= weight;
      drain();
    };
  }

  function drain() {
    // FIFO 也保住同轨请求的先后次序，队头有机会先拿到正文额度并落盘。
    while (pending.length && used + pending[0].weight <= limit) {
      const entry = pending.shift();
      entry.signal?.removeEventListener("abort", entry.cancel);
      entry.resolve(grant(entry.weight));
    }
  }

  return {
    setLimit(next) {
      limit = next;
      drain();
    },
    tryAcquire(weight) {
      return !pending.length && used + weight <= limit ? grant(weight) : null;
    },
    acquire(weight, signal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(weight) || weight <= 0 || weight > capacity) throw new RangeError("下载预算请求超过容量");
      if (!pending.length && used + weight <= limit) return Promise.resolve(grant(weight));
      return new Promise((resolve, reject) => {
        const entry = { weight, signal, resolve, cancel() {
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(signal.reason);
          drain();
        } };
        pending.push(entry);
        signal?.addEventListener("abort", entry.cancel, { once: true });
      });
    }
  };
}
