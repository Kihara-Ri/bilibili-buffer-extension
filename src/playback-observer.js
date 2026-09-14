(() => {
  "use strict";

  const NS = "__biliBufferPlaybackAssistV1";
  if (window[NS]) return;
  window[NS] = true;

  const markObserverReady = () => {
    if (document.documentElement) document.documentElement.dataset.biliBufferAssistMain = "2.5.0";
  };
  markObserverReady();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", markObserverReady, { once: true });

  const CHANNEL = "bili-buffer-playback-assist-v1";
  const ESTIMATOR_KEY = "bilibili_dash_throughput_lru_v1";
  const ESTIMATOR_BACKUP_KEY = "__bili_buffer_estimator_backup_v1";
  const MEDIA_RE = /^https?:\/\/[^/]*(?:bilivideo\.com|bilivideo\.cn|akamaized\.net)\//i;
  const MB = 1024 * 1024;
  const PREHEAT_STYLE_ID = "bili-buffer-preheat-progress-style";
  const DEFAULT_PREHEAT_COLOR = "#ff8a1f";
  const DEFAULTS = {
    mode: "pending",
    slowTtfbMs: 800,
    leadSeconds: 45,
    minWatchedSec: 0,
    minBufferAheadSec: 0,
    maxPrefetchMBPerTrack: 200,
    maxConcurrency: 4,
    estimatorGuard: true,
    progressColor: "#00a1d6",
    showPreheatHighlight: true,
    preheatColor: DEFAULT_PREHEAT_COLOR
  };
  const cfg = { ...DEFAULTS };
  const tracks = new Map();
  const observedVideos = new WeakSet();
  let lastPageKey = currentPageKey();
  let playerSequence = 0;
  const stats = {
    requests: 0,
    slowRequests: 0,
    requestErrors: 0,
    prefetchChunks: 0,
    prefetchBytes: 0,
    prefetchErrors: 0,
    prefetching: 0,
    stalls: 0,
    stallMs: 0,
    waitingSince: 0,
    playedSec: 0,
    lastSlowAt: 0,
    hosts: Object.create(null)
  };

  const playbackCache = window.__biliBufferCache;
  const prefetchControllers = new Set();
  const nativeFetch = window.fetch;
  const storageProto = window.Storage?.prototype;
  const nativeStorageSet = storageProto?.setItem;

  function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  }

  function boundedPush(values, value, limit = 200) {
    if (!Number.isFinite(value)) return;
    values.push(value);
    if (values.length > limit) values.splice(0, values.length - limit);
  }

  function parseRangeHeader(value) {
    const match = /bytes=(\d+)-(\d*)/i.exec(String(value || ""));
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : null;
    return Number.isSafeInteger(start) && (end === null || (Number.isSafeInteger(end) && end >= start))
      ? { start, end }
      : null;
  }

  function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? 0 : Number(match[3]);
    return end >= start && (!total || end < total) ? { start, end, total } : null;
  }

  function hostFor(input) {
    try { return new URL(input, location.href).hostname; } catch { return ""; }
  }

  function currentPageKey() {
    try {
      const pageUrl = new URL(location.href);
      const pathVideoId = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(pageUrl.pathname)?.[1];
      const videoId = pathVideoId || pageUrl.searchParams.get("bvid") || pageUrl.searchParams.get("oid") || pageUrl.pathname;
      const page = Math.max(1, Number.parseInt(pageUrl.searchParams.get("p") || "1", 10) || 1);
      return `${String(videoId).toUpperCase()}:p${page}`;
    } catch {
      return String(location.pathname || location.href);
    }
  }

  function pathFor(input) {
    try { return new URL(input, location.href).pathname; } catch { return ""; }
  }

  function hostStat(host) {
    if (!host) host = "unknown";
    if (!stats.hosts[host]) {
      stats.hosts[host] = {
        requests: 0,
        slow: 0,
        errors: 0,
        ttfbs: [],
        hotTtfbs: [],
        hotThroughputsKbps: [],
        prefetchSuccesses: 0,
        prefetchErrors: 0,
        prefetchConcurrency: 2,
        chunkBytes: 512 * 1024,
        lastSlowAt: 0
      };
    }
    return stats.hosts[host];
  }

  function slowThreshold(host) {
    const baseline = percentile(hostStat(host).hotTtfbs, 0.5);
    return Math.max(Number(cfg.slowTtfbMs) || DEFAULTS.slowTtfbMs, baseline ? baseline * 6 : 0);
  }

  function dynamicEstimatorFloor(host) {
    const samples = hostStat(host).hotThroughputsKbps;
    if (samples.length < 3) return 0;
    return Math.round(Math.max(1000, Math.min(12000, percentile(samples, 0.25) * 0.55)));
  }

  function addRange(list, start, end) {
    if (!(end > start)) return;
    list.push([start, end]);
    list.sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of list) {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range.slice());
    }
    list.splice(0, list.length, ...merged);
  }

  function firstGap(ranges, from, to) {
    let cursor = from;
    for (const [start, end] of ranges) {
      if (end <= cursor) continue;
      if (start > cursor) return [cursor, Math.min(start, to)];
      cursor = Math.max(cursor, end);
      if (cursor >= to) return null;
    }
    return cursor < to ? [cursor, to] : null;
  }

  function trackFor(url, playerRequest = true) {
    const path = pathFor(url);
    if (!path) return null;
    const host = hostFor(url);
    const key = `${host}|${path}`;
    let track = tracks.get(key);
    if (!track) {
      for (const existing of tracks.values()) {
        if (existing.path === path) existing.active = false;
      }
      track = {
        key,
        path,
        url,
        host,
        active: true,
        size: 0,
        anchor: 0,
        covered: [],
        prefetchedRanges: [],
        inflight: [],
        cold: false,
        prefetchedBytes: 0,
        consecutivePrefetchErrors: 0,
        cooldownUntil: 0,
        prefetchDisabled: false,
        lastSeen: Date.now(),
        lastPlayerSeen: ++playerSequence
      };
      tracks.set(key, track);
    } else if (playerRequest) {
      for (const existing of tracks.values()) {
        if (existing !== track && existing.path === path) existing.active = false;
      }
      track.url = url;
      track.host = hostFor(url) || track.host;
      track.active = true;
      track.lastSeen = Date.now();
      track.lastPlayerSeen = ++playerSequence;
    }
    return track;
  }

  function recordMedia({ url, range, bytes = 0, ttfbMs = null, totalMs = null, contentRange = null, status = 0, completed = false, error = false }) {
    if (!MEDIA_RE.test(String(url || ""))) return;
    stats.requests += 1;
    const track = trackFor(url, false);
    if (!track || track.url !== url) return;
    const host = hostStat(track.host);
    host.requests += 1;
    if (error || status >= 400) {
      stats.requestErrors += 1;
      host.errors += 1;
    }
    if (Number.isFinite(ttfbMs)) {
      boundedPush(host.ttfbs, ttfbMs);
      const threshold = slowThreshold(track.host);
      if (ttfbMs > threshold) {
        stats.slowRequests += 1;
        stats.lastSlowAt = Date.now();
        host.slow += 1;
        host.lastSlowAt = Date.now();
        track.cold = true;
      } else {
        boundedPush(host.hotTtfbs, ttfbMs);
      }
      if (completed && bytes > 0 && Number.isFinite(totalMs) && totalMs > ttfbMs && ttfbMs <= threshold) {
        boundedPush(host.hotThroughputsKbps, bytes * 8 / (totalMs - ttfbMs));
      }
      if (track.cold && cfg.estimatorGuard) queueEstimatorCleanup();
    }
    const parsed = primeTrackFromHeaders(track, range, contentRange, status);
    if (completed && status >= 200 && status < 300 && bytes > 0) {
      const start = range?.start ?? parsed?.start ?? 0;
      const end = start + bytes;
      addRange(track.covered, start, end);
      track.anchor = Math.max(track.anchor, end);
    }
  }

  function primeTrackFromHeaders(track, range, contentRange, status) {
    const parsed = parseContentRange(contentRange);
    if (!parsed) return null;
    if (parsed.total) track.size = parsed.total;
    const expectedStart = range?.start;
    if (status >= 200 && status < 300 && (!Number.isSafeInteger(expectedStart) || parsed.start === expectedStart)) {
      track.anchor = Math.max(track.anchor, parsed.end + 1);
    }
    return parsed;
  }

  function installXhrObserver() {
    const proto = window.XMLHttpRequest?.prototype;
    if (!proto || proto[NS]) return;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const nativeSetHeader = proto.setRequestHeader;
    proto.open = function (method, url) {
      this[NS] = { method: String(method || ""), url: String(url || ""), pageKey: currentPageKey() };
      return nativeOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      const state = this[NS];
      if (state && String(name).toLowerCase() === "range") state.rangeHeader = String(value);
      return nativeSetHeader.apply(this, arguments);
    };
    proto.send = function () {
      const state = this[NS];
      if (state?.rangeHeader && MEDIA_RE.test(state.url)) {
        resetTracksAfterNavigation();
        trackFor(state.url);
        state.startedAt = performance.now();
        state.range = parseRangeHeader(state.rangeHeader);
        state.ttfbMs = null;
        this.addEventListener("readystatechange", () => {
          if (this.readyState !== 2 || state.ttfbMs !== null || currentPageKey() !== state.pageKey) return;
          state.ttfbMs = performance.now() - state.startedAt;
          const track = trackFor(state.url, false);
          if (track) {
            primeTrackFromHeaders(
              track,
              state.range,
              safeXhrHeader(this, "content-range"),
              Number(this.status) || 0
            );
          }
        });
        this.addEventListener("loadend", () => {
          if (currentPageKey() !== state.pageKey) return;
          let bytes = 0;
          try {
            if (this.response && typeof this.response.byteLength === "number") bytes = this.response.byteLength;
            else if (typeof this.response === "string") bytes = this.response.length;
          } catch { /* 只观察，不影响播放器。 */ }
          recordMedia({
            url: state.url,
            range: state.range,
            bytes,
            ttfbMs: state.ttfbMs,
            totalMs: performance.now() - state.startedAt,
            contentRange: safeXhrHeader(this, "content-range"),
            status: Number(this.status) || 0,
            completed: true,
            error: this.status === 0
          });
        }, { once: true });
      }
      return nativeSend.apply(this, arguments);
    };
    proto[NS] = true;
  }

  function safeXhrHeader(xhr, name) {
    try { return xhr.getResponseHeader(name); } catch { return null; }
  }

  function installFetchObserver() {
    if (typeof nativeFetch !== "function" || nativeFetch[NS]) return;
    const wrapped = function (...args) {
      const input = args[0];
      const init = args[1];
      const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
      let rangeHeader = "";
      try {
        rangeHeader = new Headers(init?.headers || input?.headers).get("range") || "";
      } catch { /* ignore */ }
      if (!rangeHeader || !MEDIA_RE.test(url)) return nativeFetch.apply(this, args);
      resetTracksAfterNavigation();
      trackFor(url);
      const pageKey = currentPageKey();
      const startedAt = performance.now();
      return nativeFetch.apply(this, args).then((response) => {
        if (currentPageKey() !== pageKey) return response;
        recordMedia({
          url,
          range: parseRangeHeader(rangeHeader),
          ttfbMs: performance.now() - startedAt,
          totalMs: performance.now() - startedAt,
          contentRange: response.headers.get("content-range"),
          status: response.status,
          completed: false
        });
        return response;
      }, (error) => {
        if (currentPageKey() === pageKey) recordMedia({ url, range: parseRangeHeader(rangeHeader), error: true });
        throw error;
      });
    };
    wrapped[NS] = true;
    window.fetch = wrapped;
  }

  function currentBufferAhead() {
    let best = 0;
    for (const video of document.querySelectorAll("video")) {
      const buffered = video.buffered;
      for (let index = 0; index < buffered.length; index += 1) {
        if (video.currentTime >= buffered.start(index) - 0.1 && video.currentTime <= buffered.end(index) + 0.1) {
          best = Math.max(best, buffered.end(index) - video.currentTime);
        }
      }
    }
    return best;
  }

  function anyVideoPlaying() {
    return [...document.querySelectorAll("video")]
      .some((video) => !video.paused && !video.ended && video.readyState > 2);
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);
    const beginWaiting = () => {
      if (!video.paused && !video.ended && !stats.waitingSince) {
        stats.waitingSince = performance.now();
        stats.stalls += 1;
      }
    };
    const endWaiting = () => {
      if (!stats.waitingSince) return;
      stats.stallMs += Math.max(0, performance.now() - stats.waitingSince);
      stats.waitingSince = 0;
    };
    video.addEventListener("waiting", beginWaiting);
    video.addEventListener("stalled", beginWaiting);
    video.addEventListener("playing", endWaiting);
    video.addEventListener("canplay", endWaiting);
    video.addEventListener("ended", endWaiting);
    video.addEventListener("pause", endWaiting);
  }

  function scanVideos() {
    for (const video of document.querySelectorAll("video")) observeVideo(video);
  }

  function leadBytes(track) {
    const duration = Math.max(0, ...[...document.querySelectorAll("video")].map((video) => Number(video.duration) || 0));
    const estimatedBytesPerSecond = track.size > 0 && duration > 0 ? track.size / duration : 0;
    const requested = estimatedBytesPerSecond > 0
      ? estimatedBytesPerSecond * Math.max(10, Number(cfg.leadSeconds) || DEFAULTS.leadSeconds)
      : 24 * MB;
    return Math.max(8 * MB, Math.min(48 * MB, requested));
  }

  function shouldPrefetch(track) {
    if (cfg.mode !== "always") return false;
    if (track.prefetchDisabled || Date.now() < track.cooldownUntil) return false;
    if (track.prefetchedBytes >= Math.max(1, Number(cfg.maxPrefetchMBPerTrack) || 1) * MB) return false;
    return true;
  }

  function pickJob() {
    const candidates = [...tracks.values()]
      .filter((track) => track.active !== false && track.anchor > 0 && shouldPrefetch(track))
      .sort((left, right) => right.lastSeen - left.lastSeen);
    for (const track of candidates) {
      const host = hostStat(track.host);
      const sameHostInflight = track.inflight.length;
      if (sameHostInflight >= Math.min(cfg.maxConcurrency, host.prefetchConcurrency)) continue;
      const byteCap = Math.max(1, Number(cfg.maxPrefetchMBPerTrack) || 1) * MB;
      const reservedBytes = track.inflight.reduce((sum, [start, end]) => sum + Math.max(0, end - start), 0);
      const remainingBytes = byteCap - track.prefetchedBytes - reservedBytes;
      if (remainingBytes <= 0) continue;
      const to = track.size
        ? Math.min(track.size, track.anchor + leadBytes(track), track.anchor + remainingBytes)
        : Math.min(track.anchor + leadBytes(track), track.anchor + remainingBytes);
      // 优先补齐初始化区，SIDX 一般在文件头；最多探测 1 MiB，未知格式不伪造时间映射。
      const index = playbackCache?.index(track.url);
      if (playbackCache && !index && (track.indexProbeBytes || 0) < Math.min(track.size || MB, MB)) {
        if (track.inflight.length) continue;
        const probeEnd = Math.min(track.size || MB, track.indexProbeBytes ? MB : 64 * 1024);
        track.indexProbeBytes = probeEnd;
        const gap = firstGap(playbackCache.ranges(track.url), 0, probeEnd);
        if (gap) return { track, start: gap[0], end: Math.min(gap[1], gap[0] + remainingBytes) };
      }
      if (index && playbackCache) {
        // 清晰度切换后只为播放器最近使用的同类轨道预取，不用文件大小猜音视频。
        const newer = [...tracks.values()].some(other => other !== track && other.active !== false && playbackCache.index(other.url)?.role === index.role
          && other.lastPlayerSeen > track.lastPlayerSeen);
        if (newer) continue;
        const video = [...document.querySelectorAll("video")].find(item => !item.paused) || document.querySelectorAll("video")[0];
        const now = Number(video?.currentTime) || 0;
        const targets = [[0, index.segments[0].start], ...index.segments
          .filter(segment => segment.timeEnd > now && segment.timeStart < now + cfg.leadSeconds)
          .map(segment => [segment.start, segment.end])];
        const resident = playbackCache.ranges(track.url);
        for (const [left, right] of targets) {
          const coverage = resident.map(range => range.slice());
          for (const [a, b] of track.inflight) addRange(coverage, a, b);
          const gap = firstGap(coverage, left, right);
          if (gap) return { track, start: gap[0], end: Math.min(gap[1], gap[0] + host.chunkBytes, gap[0] + remainingBytes) };
        }
        continue;
      }
      let cursor = track.anchor;
      for (let guard = 0; guard < 128 && cursor < to; guard += 1) {
        const gap = firstGap(track.covered, cursor, to);
        if (!gap) break;
        const start = gap[0];
        const end = Math.min(gap[1], start + host.chunkBytes);
        if (!track.inflight.some(([left, right]) => start < right && end > left)) return { track, start, end };
        cursor = end;
      }
    }
    return null;
  }

  async function prefetch(job) {
    const { track, start, end } = job;
    const host = hostStat(track.host);
    track.inflight.push([start, end]);
    stats.prefetching += 1;
    const controller = new AbortController();
    prefetchControllers.add(controller);
    const pageKey = currentPageKey(), requestUrl = track.url;
    const timer = setTimeout(() => controller.abort(new DOMException("预热超时", "TimeoutError")), 45000);
    const startedAt = performance.now();
    try {
      const response = await nativeFetch.call(window, requestUrl, {
        credentials: "omit",
        headers: { Range: `bytes=${start}-${end - 1}` },
        priority: "low",
        signal: controller.signal
      });
      if (response.status !== 206 || !response.body) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`预热 Range 返回 HTTP ${response.status}`);
      }
      const contentRange = parseContentRange(response.headers.get("content-range"));
      if (!contentRange || contentRange.start !== start || contentRange.end > end - 1) {
        await response.body.cancel().catch(() => {});
        throw new Error("预热 Range 范围不一致");
      }
      if (contentRange.total) track.size = contentRange.total;
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > end - start) { await reader.cancel(); throw new Error("预热响应超出请求范围"); }
        chunks.push(value);
      }
      const expected = contentRange.end - contentRange.start + 1;
      if (bytes !== expected) throw new Error("预热响应提前结束");
      // 导航/关闭/签名地址切换后到达的旧响应不能重新填充已清理的缓存。
      if (controller.signal.aborted || cfg.mode !== "always" || currentPageKey() !== pageKey || tracks.get(track.key) !== track || track.url !== requestUrl) return;
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      playbackCache?.put(requestUrl, start, body, contentRange.total, { contentType: response.headers.get("content-type") || "application/octet-stream" });
      addRange(track.covered, start, start + bytes);
      addRange(track.prefetchedRanges, start, start + bytes);
      track.prefetchedBytes += bytes;
      track.lastSeen = Date.now();
      stats.prefetchChunks += 1;
      stats.prefetchBytes += bytes;
      host.prefetchSuccesses += 1;
      track.consecutivePrefetchErrors = 0;
      track.cooldownUntil = 0;
      const elapsed = performance.now() - startedAt;
      if (elapsed < 12000 && host.prefetchConcurrency < cfg.maxConcurrency) host.prefetchConcurrency += 1;
      if (elapsed < 8000) host.chunkBytes = MB;
      renderPreheatProgress();
    } catch {
      if (controller.signal.aborted && controller.signal.reason?.name !== "TimeoutError") return;
      stats.prefetchErrors += 1;
      host.prefetchErrors += 1;
      track.consecutivePrefetchErrors += 1;
      track.cooldownUntil = Date.now() + Math.min(30000, 1000 * (2 ** Math.min(track.consecutivePrefetchErrors, 5)));
      if (track.consecutivePrefetchErrors >= 6) track.prefetchDisabled = true;
      host.prefetchConcurrency = Math.max(1, Math.ceil(host.prefetchConcurrency / 2));
      host.chunkBytes = 512 * 1024;
    } finally {
      clearTimeout(timer);
      prefetchControllers.delete(controller);
      stats.prefetching = Math.max(0, stats.prefetching - 1);
      const index = track.inflight.findIndex(([left, right]) => left === start && right === end);
      if (index >= 0) track.inflight.splice(index, 1);
    }
  }

  function sanitizeEstimator(raw) {
    if (!cfg.estimatorGuard || cfg.mode !== "always") return raw;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    if (!parsed?.entries || typeof parsed.entries !== "object") return raw;
    let changed = false;
    for (const [key, entry] of Object.entries(parsed.entries)) {
      const host = String(key).split("|")[1] || "";
      const hostStats = stats.hosts[host];
      const floor = dynamicEstimatorFloor(host);
      if (!hostStats || !floor || Date.now() - hostStats.lastSlowAt > 15000 || !Array.isArray(entry?.samples)) continue;
      const kept = entry.samples.filter((sample) => Number.isFinite(sample) && sample >= floor);
      const samples = kept.length ? kept : [floor];
      if (kept.length !== entry.samples.length) {
        entry.samples = samples;
        entry.samplesCount = samples.length;
        changed = true;
      }
      const p25 = percentile(samples, 0.25);
      const p50 = percentile(samples, 0.5);
      if (Number(entry.p25Kbps) < floor || entry.p25Kbps !== p25) {
        entry.p25Kbps = p25;
        changed = true;
      }
      if (Number(entry.p50Kbps) < floor || entry.p50Kbps !== p50) {
        entry.p50Kbps = p50;
        changed = true;
      }
      if (Number(entry.ewmaKbps) < floor) {
        entry.ewmaKbps = floor;
        changed = true;
      }
      const latencyCeiling = Math.max(200, Math.min(1000, (percentile(hostStats.hotTtfbs, 0.95) || 100) * 3));
      if (Number(entry.latencyMs) > latencyCeiling) {
        entry.latencyMs = Math.round(latencyCeiling);
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : raw;
  }

  let estimatorCleanupQueued = false;
  function queueEstimatorCleanup() {
    if (estimatorCleanupQueued || !cfg.estimatorGuard || cfg.mode !== "always" || !nativeStorageSet) return;
    estimatorCleanupQueued = true;
    queueMicrotask(() => {
      estimatorCleanupQueued = false;
      try {
        const raw = localStorage.getItem(ESTIMATOR_KEY);
        if (!raw) return;
        const clean = sanitizeEstimator(raw);
        if (clean !== raw) nativeStorageSet.call(localStorage, ESTIMATOR_KEY, clean);
      } catch { /* 护栏失败不得影响播放器。 */ }
    });
  }

  function readEstimator() {
    try {
      const raw = localStorage.getItem(ESTIMATOR_KEY);
      if (!raw) return { present: false, suspect: false, entries: [] };
      const parsed = JSON.parse(raw);
      const entries = Object.entries(parsed?.entries || {}).map(([key, entry]) => {
        const host = String(key).split("|")[1] || key;
        const floor = dynamicEstimatorFloor(host);
        const p25 = Math.round(Number(entry?.p25Kbps) || 0);
        return { host, p25, p50: Math.round(Number(entry?.p50Kbps) || 0), latencyMs: Math.round(Number(entry?.latencyMs) || 0), floor };
      });
      return { present: true, suspect: entries.some((entry) => entry.floor > 0 && entry.p25 > 0 && entry.p25 < entry.floor), entries };
    } catch {
      return { present: true, suspect: false, entries: [] };
    }
  }

  function backupAndClearEstimator() {
    try {
      const raw = localStorage.getItem(ESTIMATOR_KEY);
      if (raw) nativeStorageSet.call(localStorage, ESTIMATOR_BACKUP_KEY, JSON.stringify({ at: Date.now(), raw }));
      localStorage.removeItem(ESTIMATOR_KEY);
      return Boolean(raw);
    } catch { return false; }
  }

  function restoreEstimator() {
    try {
      const backup = JSON.parse(localStorage.getItem(ESTIMATOR_BACKUP_KEY) || "null");
      if (!backup?.raw) return false;
      nativeStorageSet.call(localStorage, ESTIMATOR_KEY, backup.raw);
      localStorage.removeItem(ESTIMATOR_BACKUP_KEY);
      return true;
    } catch { return false; }
  }

  function installEstimatorGuard() {
    if (!storageProto || !nativeStorageSet || storageProto[NS]) return;
    storageProto.setItem = function (key, value) {
      if (key === ESTIMATOR_KEY) {
        try { value = sanitizeEstimator(String(value)); } catch { /* 原样写入。 */ }
      }
      return nativeStorageSet.call(this, key, value);
    };
    storageProto[NS] = true;
  }

  function publicStats() {
    const hosts = {};
    for (const [name, host] of Object.entries(stats.hosts)) {
      hosts[name] = {
        requests: host.requests,
        slow: host.slow,
        errors: host.errors,
        ttfbP50: percentile(host.ttfbs, 0.5),
        ttfbP95: percentile(host.ttfbs, 0.95),
        hotKbpsP25: percentile(host.hotThroughputsKbps, 0.25),
        prefetchConcurrency: host.prefetchConcurrency,
        chunkKB: Math.round(host.chunkBytes / 1024)
      };
    }
    return {
      at: Date.now(),
      mode: cfg.mode,
      estimatorGuard: Boolean(cfg.estimatorGuard),
      requests: stats.requests,
      slowRequests: stats.slowRequests,
      requestErrors: stats.requestErrors,
      activeTracks: tracks.size,
      coldTracks: [...tracks.values()].filter((track) => track.cold).length,
      disabledTracks: [...tracks.values()].filter((track) => track.prefetchDisabled).length,
      cacheHits: playbackCache?.stats.hits || 0,
      cacheHitMB: +((playbackCache?.stats.hitBytes || 0) / MB).toFixed(2),
      cacheResidentMB: +((playbackCache?.stats.bytes || 0) / MB).toFixed(2),
      prefetchChunks: stats.prefetchChunks,
      prefetchMB: +(stats.prefetchBytes / MB).toFixed(1),
      prefetchErrors: stats.prefetchErrors,
      prefetching: stats.prefetching,
      stalls: stats.stalls,
      stallMs: Math.round(stats.stallMs + (stats.waitingSince ? performance.now() - stats.waitingSince : 0)),
      playedSec: stats.playedSec,
      bufferAheadSec: +currentBufferAhead().toFixed(1),
      pageHidden: document.hidden,
      warmingUp: stats.playedSec < cfg.minWatchedSec,
      minWatchedSec: cfg.minWatchedSec,
      minBufferAheadSec: cfg.minBufferAheadSec,
      estimator: readEstimator(),
      hosts
    };
  }

  function normalizedPrefetchedRanges() {
    const eligible = [...tracks.values()].filter(track => track.active !== false);
    const pair = chooseCurrentDashPair(eligible);
    if (!pair) return [];
    // 新清晰度的初始化尚未解析时，不能继续借旧清晰度画黄色。
    if (eligible.some(track => !playbackCache?.index(track.url)?.role && track.lastPlayerSeen > Math.min(pair.video.lastPlayerSeen, pair.audio.lastPlayerSeen))) return [];
    return intersectRanges(normalizedTrackRanges(pair.video), normalizedTrackRanges(pair.audio));
  }

  function normalizedTrackRanges(track) {
    const normalized = [];
    const video = [...document.querySelectorAll("video")].find(item => !item.paused) || document.querySelectorAll("video")[0];
    const duration = Number(video?.duration);
    if (!playbackCache || !(duration > 0) || !Number.isFinite(duration)) return normalized;
    // SIDX 给出每段真实时长；绝不把可变码率的字节占比伪装成可播放时间。
    for (const [start, end] of playbackCache.timeRanges(track.url)) {
      const left = Math.max(0, Math.min(1, start / duration));
      const right = Math.max(0, Math.min(1, end / duration));
      if (right > left) addRange(normalized, left, right);
    }
    return normalized;
  }

  function chooseCurrentDashPair(candidates) {
    const newest = role => candidates.filter(track => playbackCache?.index(track.url)?.role === role)
      .sort((left, right) => right.lastPlayerSeen - left.lastPlayerSeen)[0];
    const video = newest("video"), audio = newest("audio");
    return video && audio ? { video, audio } : null;
  }

  function intersectRanges(leftRanges, rightRanges) {
    const result = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftRanges.length && rightIndex < rightRanges.length) {
      const left = leftRanges[leftIndex];
      const right = rightRanges[rightIndex];
      const start = Math.max(left[0], right[0]);
      const end = Math.min(left[1], right[1]);
      if (end > start) addRange(result, start, end);
      if (left[1] <= right[1]) leftIndex += 1;
      else rightIndex += 1;
    }
    return result;
  }

  function normalizePreheatColor(value) {
    const color = String(value || "").trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_PREHEAT_COLOR;
  }

  // 黄色记录插件贡献，不能因进入播放器缓冲而变灰；已播放进度仍在最上层。
  function timelineStates(played, nativeRanges, pluginRanges) {
    played = Math.max(0, Math.min(1, Number(played) || 0));
    const clean = (ranges) => (ranges || []).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .map(([a, b]) => [Math.max(0, Math.min(1, a)), Math.max(0, Math.min(1, b))]);
    const native = clean(nativeRanges);
    const plugin = clean(pluginRanges);
    const points = [...new Set([0, played, 1, ...native.flat(), ...plugin.flat()])].sort((a, b) => a - b);
    const result = [];
    for (let i = 1; i < points.length; i += 1) {
      const start = points[i - 1], end = points[i];
      if (end <= start) continue;
      const midpoint = (start + end) / 2;
      const contains = (ranges) => ranges.some(([a, b]) => a <= midpoint && midpoint < b);
      const state = midpoint < played ? "played" : contains(plugin) ? "plugin" : contains(native) ? "native" : "empty";
      const previous = result.at(-1);
      if (previous?.state === state) previous.end = end;
      else result.push({ start, end, state });
    }
    return result;
  }

  // Native elements retain their dimensions, transforms, visibility and event handlers.
  // Only the unplayed background is partitioned; the native played bar stays above it.
  function timelineGradient(states, bufferColor = "#b8b8b8") {
    const colors = {
      played: "transparent",
      native: bufferColor,
      plugin: cfg.showPreheatHighlight === false ? bufferColor : normalizePreheatColor(cfg.preheatColor),
      empty: "transparent"
    };
    return `linear-gradient(to right, ${states.map(({ start, end, state }) => `${colors[state]} ${start * 100}% ${end * 100}%`).join(", ")})`;
  }

  function timelineVideo(root) {
    const player = root.closest?.(".bpx-player-container, #bilibili-player");
    const candidates = [...(player || document).querySelectorAll("video")];
    return candidates.find((video) => !video.paused && !video.ended) || candidates[0];
  }

  function ensurePreheatProgressStyle() {
    if (document.getElementById?.(PREHEAT_STYLE_ID)) return;
    const style = document.createElement?.("style");
    if (!style) return;
    style.id = PREHEAT_STYLE_ID;
    style.textContent = `
      .bpx-player-progress-schedule[data-bili-buffer-colors] > .bpx-player-progress-schedule-current {
        background-color: var(--bili-buffer-played-color, #00a1d6) !important;
      }
      .bpx-player-progress-schedule[data-bili-buffer-paint] {
        background-image: var(--bili-buffer-state-fill) !important;
      }
      .bpx-player-progress-schedule[data-bili-buffer-paint] > .bpx-player-progress-schedule-buffer {
        background-color: transparent !important;
      }
    `;
    (document.head || document.documentElement)?.append(style);
  }

  const nativeBufferColors = new WeakMap();
  function bufferColorFor(element) {
    if (!element) return "rgba(255, 255, 255, 0.3)";
    if (!nativeBufferColors.has(element)) nativeBufferColors.set(element, window.getComputedStyle(element).backgroundColor);
    return nativeBufferColors.get(element);
  }

  function projectTimelineRanges(ranges, start, end) {
    if (!(end > start)) return [];
    return ranges.map(([a, b]) => [Math.max(start, a), Math.min(end, b)])
      .filter(([a, b]) => b > a)
      .map(([a, b]) => [(a - start) / (end - start), (b - start) / (end - start)]);
  }

  function renderPreheatProgress() {
    ensurePreheatProgressStyle();
    const pluginRanges = normalizedPrefetchedRanges();
    for (const root of document.querySelectorAll(".bpx-player-progress, .bpx-player-shadow-progress-area")) {
      const video = timelineVideo(root);
      const duration = Number(video?.duration);
      const schedules = [...root.querySelectorAll(".bpx-player-progress-schedule")];
      const widths = schedules.map((schedule) => schedule.getBoundingClientRect().width);
      const total = widths.reduce((sum, width) => sum + width, 0);
      const native = [];
      if (duration > 0 && Number.isFinite(duration)) {
        for (let i = 0; i < (video.buffered?.length || 0); i += 1) native.push([video.buffered.start(i) / duration, video.buffered.end(i) / duration]);
      }
      const fallbackColor = bufferColorFor(root.querySelector(".bpx-player-progress-schedule-buffer"));
      let cursor = 0;
      for (let i = 0; i < schedules.length; i += 1) {
        const schedule = schedules[i];
        const start = total > 0 ? cursor / total : 0;
        cursor += widths[i];
        const end = total > 0 ? cursor / total : 0;
        schedule.dataset.biliBufferColors = "true";
        const playedColor = /^#[0-9a-f]{6}$/i.test(cfg.progressColor || "") ? cfg.progressColor : "#00a1d6";
        schedule.style.setProperty("--bili-buffer-played-color", playedColor);
        const plugin = projectTimelineRanges(pluginRanges, start, end);
        if (!(duration > 0) || !Number.isFinite(duration) || !plugin.length || !(widths[i] > 0)) {
          delete schedule.dataset.biliBufferPaint;
          schedule.style.removeProperty("--bili-buffer-state-fill");
          continue;
        }
        const current = schedule.querySelector(".bpx-player-progress-schedule-current");
        // Read the native played geometry. Never infer/reposition the TV handle.
        const played = current ? Math.max(0, Math.min(1, current.getBoundingClientRect().width / widths[i])) : 0;
        const buffer = schedule.querySelector(".bpx-player-progress-schedule-buffer");
        const bufferColor = buffer ? bufferColorFor(buffer) : fallbackColor;
        const states = timelineStates(played, projectTimelineRanges(native, start, end), plugin);
        const fill = timelineGradient(states, bufferColor);
        if (schedule.style.getPropertyValue("--bili-buffer-state-fill") !== fill) schedule.style.setProperty("--bili-buffer-state-fill", fill);
        schedule.dataset.biliBufferPaint = "true";
      }
    }
  }

  function resetTracksAfterNavigation() {
    const nextPageKey = currentPageKey();
    if (nextPageKey === lastPageKey) return false;
    lastPageKey = nextPageKey;
    for (const controller of prefetchControllers) controller.abort();
    playbackCache?.clear();
    tracks.clear();
    renderPreheatProgress();
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "ext->page") return;
    if (message.type === "config" && message.payload && typeof message.payload === "object") {
      Object.assign(cfg, message.payload);
      cfg.mode = ["off", "observe"].includes(cfg.mode) ? "off" : "always";
      cfg.maxConcurrency = Math.max(1, Math.min(6, Number(cfg.maxConcurrency) || DEFAULTS.maxConcurrency));
      if (cfg.mode === "off") {
        for (const controller of prefetchControllers) controller.abort();
        playbackCache?.clear();
        for (const track of tracks.values()) {
          track.indexProbeBytes = 0;
          track.prefetchedBytes = 0;
          track.prefetchedRanges = [];
          track.covered = [];
        }
      }
      cfg.minWatchedSec = 0;
      cfg.minBufferAheadSec = 0;
      cfg.maxPrefetchMBPerTrack = Math.max(16, Math.min(1024, Number(cfg.maxPrefetchMBPerTrack) || DEFAULTS.maxPrefetchMBPerTrack));
      cfg.preheatColor = normalizePreheatColor(cfg.preheatColor);
      renderPreheatProgress();
      if (cfg.estimatorGuard) queueEstimatorCleanup();
    } else if (message.type === "command") {
      const success = message.payload?.name === "clearEstimator"
        ? backupAndClearEstimator()
        : message.payload?.name === "restoreEstimator"
          ? restoreEstimator()
          : false;
      window.postMessage({ channel: CHANNEL, dir: "page->ext", type: "commandResult", payload: { name: message.payload?.name, success } }, "*");
    }
  });

  window.__biliBufferPlaybackAssistInternals = {
    cfg,
    stats,
    tracks,
    percentile,
    parseRangeHeader,
    parseContentRange,
    addRange,
    firstGap,
    trackFor,
    recordMedia,
    slowThreshold,
    dynamicEstimatorFloor,
    sanitizeEstimator,
    queueEstimatorCleanup,
    shouldPrefetch,
    pickJob,
    normalizedPrefetchedRanges,
    normalizedTrackRanges,
    chooseCurrentDashPair,
    intersectRanges,
    normalizePreheatColor,
    timelineStates,
    timelineGradient,
    renderPreheatProgress,
    resetTracksAfterNavigation,
    setPlayedSec(value) { stats.playedSec = Number(value) || 0; },
    publicStats
  };

  installEstimatorGuard();
  installXhrObserver();
  installFetchObserver();
  playbackCache?.install({
    enabled: () => { resetTracksAfterNavigation(); return cfg.mode === "always"; },
    onChange: renderPreheatProgress,
    onHit: (url, hit) => {
      // 本地命中不是 CDN 吞吐样本，不能污染播放器的网络能力估计。
      const track = trackFor(url);
      if (track) primeTrackFromHeaders(track, { start: hit.start }, `bytes ${hit.start}-${hit.end - 1}/${hit.total}`, 206);
    }
  });
  scanVideos();
  new MutationObserver(scanVideos).observe(document, { childList: true, subtree: true });
  setInterval(() => {
    resetTracksAfterNavigation();
    if (anyVideoPlaying()) stats.playedSec += 1;
    scanVideos();
  }, 1000);
  setInterval(renderPreheatProgress, 750);
  if (typeof window.requestAnimationFrame === "function") {
    let lastPaint = 0;
    const animate = (now) => {
      if (!document.hidden && now - lastPaint >= 33) { lastPaint = now; renderPreheatProgress(); }
      window.requestAnimationFrame(animate);
    };
    window.requestAnimationFrame(animate);
  }
  setInterval(() => {
    resetTracksAfterNavigation();
    if (cfg.mode !== "always") return;
    while (stats.prefetching < cfg.maxConcurrency) {
      const job = pickJob();
      if (!job) break;
      void prefetch(job);
    }
  }, 400);
  setInterval(() => {
    window.postMessage({ channel: CHANNEL, dir: "page->ext", type: "stats", payload: publicStats() }, "*");
  }, 1000);
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, track] of tracks) if (track.lastSeen < cutoff && !track.inflight.length) tracks.delete(key);
  }, 30000);
})();
