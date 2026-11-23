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
  const MEDIA_RE = /^https?:\/\/[^/]*(?:bilivideo\.com|bilivideo\.cn|hdslb\.com|akamaized\.net)\//i;
  const MB = 1024 * 1024;
  const MAX_RANGE = 16 * MB;
  const PREHEAT_STYLE_ID = "bili-buffer-preheat-progress-style";
  const DEFAULT_PREHEAT_COLOR = "#ff8a1f";
  // 回看窗口：拖动后短暂回到刚看过的位置也应命中，但窗口要小，避免保护过多历史数据。
  const RETENTION_REWIND_SECONDS = 5;
  // 90 是媒体秒的安全上限。播放倍率、连续余量和实测吞吐决定每次的目标窗口。
  const MAX_LEAD_SECONDS = 90;
  const STARTUP_SECONDS = 6;
  const STEADY_SECONDS = 30;
  const AHEAD_BYTES_CAP = 96 * MB;
  // 只在稳态借用播放器自己的追加队列。扩大前向目标时同时限制时间和完整分片的字节数。
  const PLAYER_EXTRA_SECONDS = 10;
  const PLAYER_EXTRA_BYTES = 16 * MB;
  const PLAYER_BUFFER_SETTINGS = ["StableBufferTime", "BufferTimeAtTopQuality", "BufferTimeAtTopQualityLongForm"];
  const HOVER_DELAY_MS = 120;
  const HOVER_READ_INTERVAL_MS = 350;
  const HOVER_SLICE_BYTES = 4 * MB;
  const HOVER_PAIR_BYTES = 20 * MB;
  const SEEK_RETRY_MS = 40;
  const SEEK_WINDOW_MS = 245;
  const SEEK_AUDIO_BYTES = MB;
  // 索引未知时先取文件头解析 SIDX：64 KiB 覆盖绝大多数视频，超长视频的索引再扩到 1 MiB。
  const INDEX_PROBES = [64 * 1024, MB];
  // 后台分片排队深度：略多于引擎的后台槽位，分片一完成就有下一片可发，流水线不断档。
  const BACKGROUND_QUEUE = 16;
  const PIECE = window.BiliPlaybackNetwork.BACKGROUND_PIECE || 512 * 1024;
  const DEFAULTS = {
    mode: "pending",
    slowTtfbMs: 800,
    leadSeconds: MAX_LEAD_SECONDS,
    progressColor: "#00a1d6",
    showPreheatHighlight: true,
    preheatColor: DEFAULT_PREHEAT_COLOR
  };
  // 只接受这些由桥下发的用户配置；网络策略是内部常量，历史存储里的旧字段一律忽略。
  const CONFIG_KEYS = ["progressColor", "showPreheatHighlight", "preheatColor"];
  const cfg = { ...DEFAULTS };
  const tracks = new Map();
  const observedVideos = new WeakSet();
  let lastPageKey = currentPageKey();
  let playerSequence = 0;
  let sessionGeneration = 0;
  let refilling = false;
  let retentionAhead = STEADY_SECONDS;
  let playerBufferTarget = null;
  let committedHover = null, lastHoverReadAt = -Infinity, committedSeek = null;
  let rateAt = performance.now();
  let rateBytes = 0;
  let usefulRates = [];
  const stats = {
    requests: 0,
    slowRequests: 0,
    requestErrors: 0,
    stalls: 0,
    stallMs: 0,
    waitingSince: 0,
    playedSec: 0,
    reuseHits: 0,
    reuseBytes: 0,
    committedHits: 0,
    committedBytes: 0,
    lastSlowAt: 0,
    lastStallAt: 0,
    hosts: Object.create(null)
  };

  const playbackCache = window.__biliBufferCache;
  const nativeFetch = window.fetch;
  // 分片落地即写入页面缓存（预热与播放器急需共用），并立刻规划下一批，保持流水线连续。
  const network = window.BiliPlaybackNetwork.createNetwork({
    fetch: (...args) => nativeFetch.apply(window, args),
    onPiece(url, start, bytes, total, contentType) {
      const track = tracks.get(trackKey(url));
      if (track) { track.size = total; track.failures = 0; track.retryAt = 0; }
      recordUsefulBytes(bytes.length);
      // 分片字节归缓存所有（引擎不会再改写），直接保存不复制。
      playbackCache?.put(url, start, bytes, total, { contentType, owned: true });
      queuePump();
    },
    onPieceError(url, urgent) {
      // 后台分片在全部候选节点上重试仍失败：该轨道短暂退避，避免对拒绝中的节点反复发同一批请求。
      const track = tracks.get(trackKey(url));
      if (track && !urgent) { track.failures += 1; track.retryAt = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(track.failures, 4)); }
      queuePump();
    }
  });
  // 离线原始范围的读取器由 playback-reuse.js 提供；缺失时全部走网络，功能整体降级。
  const reuse = globalThis.BiliPlaybackReuse;
  const reuseClient = reuse?.createReuseClient?.() || null;
  const committedClient = reuse?.createCommittedClient?.() || null;
  const committedMaxBytes = reuse?.COMMITTED_MAX_BYTES || MAX_RANGE;
  const PLAYURL_RE = /^https:\/\/api\.bilibili\.com\/x\/(?:player\/(?:wbi\/)?playurl|player\/v2)(?:\?|$)/;
  function capturePlayurl(payload, pageKey) {
    if (currentPageKey() !== pageKey) return;
    const quality = Number((payload?.data || payload?.result || payload)?.quality);
    const root = document.documentElement;
    if ((payload?.code == null || payload.code === 0) && Number.isSafeInteger(quality) && quality > 0 && quality <= 127 && root &&
        (root.dataset.biliBufferQuality !== String(quality) || root.dataset.biliBufferQualityUrl !== location.href)) {
      // 清单到达才唤醒等待中的完整缓存，不转发 CDN 签名或账户信息。
      root.dataset.biliBufferQuality = String(quality);
      root.dataset.biliBufferQualityUrl = location.href;
      document.dispatchEvent(new Event("bili-buffer-site-quality"));
    }
    try { network.register(payload); } catch { /* 非 DASH 或站点字段变化时继续使用原地址。 */ }
    // 同时记录本次会话授权的精确地址，离线已下载的原始范围只对这些地址开放。
    reuse?.notePlayurl(payload);
  }
  let initialPlayinfo = null;
  function captureInitialPlayinfo() {
    const payload = window.__playinfo__;
    if (payload && payload !== initialPlayinfo) {
      initialPlayinfo = payload;
      capturePlayurl(payload, currentPageKey());
    }
  }
  document.addEventListener("DOMContentLoaded", captureInitialPlayinfo, { once: true });
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
    if (!stats.hosts[host]) stats.hosts[host] = { requests: 0, slow: 0, errors: 0, ttfbs: [], hotTtfbs: [], hotThroughputsKbps: [], lastSlowAt: 0 };
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

  /** [from,to) 中未被 ranges（有序、不重叠）覆盖的部分。 @returns {number[][]} */
  function missingRanges(ranges, from, to) {
    const gaps = [];
    let cursor = from;
    for (const [start, end] of ranges) {
      if (end <= cursor) continue;
      if (start >= to) break;
      if (start > cursor) gaps.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (cursor < to) gaps.push([cursor, to]);
    return gaps;
  }

  // 同一路径换 CDN 主机视为新轨道；查询串（签名）变化仍是同一轨道。
  const trackKey = url => `${hostFor(url)}|${pathFor(url)}`;

  function trackFor(url, playerRequest = true) {
    const path = pathFor(url);
    if (!path) return null;
    const host = hostFor(url);
    const key = trackKey(url);
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
        cold: false,
        failures: 0,
        retryAt: 0,
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

  // 只观察原生发出的媒体请求（插件未接管或回退时），为估计器护栏积累同节点的首字节与吞吐样本。
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
      if (track.cold) queueEstimatorCleanup();
    }
    const parsed = primeTrackFromHeaders(track, range, contentRange, status);
    if (completed && status >= 200 && status < 300 && bytes > 0) {
      track.anchor = Math.max(track.anchor, (range?.start ?? parsed?.start ?? 0) + bytes);
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
      if (state && PLAYURL_RE.test(state.url)) {
        resetTracksAfterNavigation();
        const capture = () => {
          if (this.readyState !== 4) return;
          this.removeEventListener("readystatechange", capture, true);
          try { capturePlayurl(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), state.pageKey); } catch { /* 忽略非 JSON 响应。 */ }
        };
        // 完成状态早于 load：播放器在 onload 内立即发媒体请求前先登记备用地址。
        this.addEventListener("readystatechange", capture, true);
      }
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
          if (track) primeTrackFromHeaders(track, state.range, safeXhrHeader(this, "content-range"), Number(this.status) || 0);
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
      if (PLAYURL_RE.test(url)) {
        resetTracksAfterNavigation();
        const pageKey = currentPageKey();
        return nativeFetch.apply(this, args).then(response => {
          void response.clone().json().then(payload => capturePlayurl(payload, pageKey)).catch(() => {});
          return response;
        });
      }
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

  function videos() {
    return [...document.querySelectorAll("video")];
  }

  function playerVideo(root) {
    const candidates = [...root.querySelectorAll("video")];
    return candidates.find(video => !video.paused && !video.ended) || candidates[0];
  }

  function currentVideo() {
    const player = document.querySelector?.("#bilibili-player");
    return (player && playerVideo(player)) || playerVideo(document);
  }

  function currentBufferAhead() {
    const video = currentVideo();
    const position = video?.currentTime;
    const range = nativeBufferRanges(video).find(([start, end]) => start <= position && position < end);
    return range ? range[1] - position : 0;
  }

  function anyVideoPlaying() {
    return videos().some((video) => !video.paused && !video.ended && video.readyState > 2);
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);
    const interruptPromotion = () => {
      if (playerBufferTarget?.video === video) restorePlayerBufferTarget();
      if (committedHover?.video === video) cancelCommittedHover();
    };
    const beginWaiting = () => {
      interruptPromotion();
      if (!video.paused && !video.ended && !stats.waitingSince) {
        stats.waitingSince = performance.now();
        stats.stalls += 1;
        if (video.currentTime > 0 && !video.seeking) stats.lastStallAt = Date.now();
      }
      queuePump();
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
    video.addEventListener("pause", () => { endWaiting(); interruptPromotion(); });
    // 拖动后旧窗口的后台分片立即让位，新窗口马上开始规划。
    video.addEventListener("seeking", () => {
      interruptPromotion();
      queueCommittedSeek(video);
      queuePump();
    });
    const endSeekPreparation = () => { if (committedSeek?.video === video) cancelCommittedSeek(); };
    video.addEventListener("seeked", endSeekPreparation);
    video.addEventListener("emptied", () => { interruptPromotion(); endSeekPreparation(); });
  }

  function scanVideos() {
    for (const video of videos()) observeVideo(video);
  }

  /** 原地址的文件头可能来自原生初始化响应或离线复用；规划器会跳过这些已驻留字节，
   * 因此必须主动把现成身份交给调度器，否则永远不会再有 start=0 的下载来启用镜像。
   * @param {string} url @returns {void} */
  function seedCachedReference(url) {
    if (!network.needsReference?.(url) || !playbackCache?.copy) return;
    const prefix = playbackCache.ranges(url)[0];
    if (!prefix || prefix[0] !== 0) return;
    const size = Math.min(1024, prefix[1]);
    if (!Number.isSafeInteger(size) || size <= 0) return;
    const bytes = new Uint8Array(size);
    const meta = playbackCache.copy(url, 0, size, bytes, 0);
    if (meta) network.seedReference(url, bytes, meta.total);
  }

  // ---- 播放器请求 ----------------------------------------------------------------

  /**
   * 拼出播放器请求的完整范围：驻留字节同步复制成快照（下载期间缓存可能回收），
   * 缺口交给分片引擎——它会直接复用已在途的后台分片，而不是取消重下。
   * 任一缺口失败就取消其余缺口，由缓存适配器整体回退原生请求，绝不交付半成品。
   * @returns {Promise<{body: Uint8Array, start: number, end: number, total: number, contentType: string, reused: number}>}
   */
  async function assembleRange(url, start, end, signal, total) {
    // 已取消的信号不会再派发 abort 事件（例如在复用查询的 await 期间被取消）；
    // 不先检查，就会为一个已没人要的请求发出整段急需分片，白占槽位。
    if (signal.aborted) throw signal.reason || new DOMException("已取消", "AbortError");
    const body = new Uint8Array(end - start);
    // 驻留部分立即复制进 body：下载缺口期间缓存可能回收这些块。
    const covered = [];
    let reused = 0, size = 0, contentType = "";
    for (const [left, right] of playbackCache?.ranges(url) || []) {
      const from = Math.max(left, start), to = Math.min(right, end);
      const meta = to > from ? playbackCache.copy(url, from, to, body, from - start) : null;
      if (!meta) continue;
      covered.push([from, to]); reused += to - from; size = meta.total; contentType = meta.contentType;
    }
    const gaps = missingRanges(covered, start, end);
    const controller = new AbortController();
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    try {
      // 缺口字节由分片引擎直接写进 body 的对应位置，不再经过中间缓冲。
      const fetched = await Promise.all(gaps.map(([from, to]) => network.get(url, from, to, { signal: controller.signal, total, into: body, at: from - start })));
      for (const result of fetched) {
        if (size && result.total !== size) throw new Error("缓存与网络的文件总长不一致");
        size = result.total; contentType = result.contentType;
      }
      return { body, start, end, total: size || total, contentType: contentType || "application/octet-stream", reused };
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }


  // 只接管播放器实际请求的媒体范围，不依赖先成功收到原节点响应头。
  async function loadPlayerRange(url, range, signal) {
    const parsed = /^bytes=(\d+)-(\d*)$/i.exec(range || "");
    if (!parsed || signal.aborted || cfg.mode !== "always") return null;
    resetTracksAfterNavigation(); captureInitialPlayinfo();
    const track = trackFor(url);
    if (!track) return null;
    seedCachedReference(url);
    const known = track.size || network.total(url) || reuse?.totalHint?.(url);
    const committed = committedClient?.find(url, known);
    const start = Number(parsed[1]);
    const end = parsed[2] ? Number(parsed[2]) + 1 : (known || committed?.total);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || (known && end > known)) return null;
    // 超过网络拼接预算的整段只允许直读已完整落盘的正文，避免把 4K 大段拆成一批高峰网络请求。
    const localOnly = end - start > MAX_RANGE;
    if (localOnly && (end - start > committedMaxBytes || end > (committed?.end || 0))) return null;
    // 预热窗口（无索引时）从播放器正在要的位置之后接续；向后拖动也必须允许回退。
    track.anchor = end;
    const pageKey = currentPageKey(), generation = sessionGeneration;
    const current = () => !signal.aborted && cfg.mode === "always" && generation === sessionGeneration &&
      currentPageKey() === pageKey && tracks.get(track.key) === track && track.url === url;
    if (committed && end <= committed.total && start < committed.end) {
      const stop = Math.min(end, committed.end);
      const readEnd = stop === end ? committedReadEnd(url, start, end, committed.end) : stop;
      const hit = await committedClient.read(committed, url, start, readEnd, signal);
      if (!current()) throw new DOMException("旧媒体请求已取消", "AbortError");
      if (hit) {
        track.size = hit.total;
        stats.committedHits++;
        stats.committedBytes += stop - start;
        const expanded = readEnd > end;
        // 把连续的下一小段留给播放器后续 Range，省去逐段往返 Offscreen。交付正文仍保持精确字节范围。
        const body = expanded ? hit.body.slice(0, end - start) : hit.body;
        playbackCache?.put(url, start, hit.body, hit.total, { contentType: hit.contentType, owned: expanded || stop < end });
        seedCachedReference(url);
        if (stop === end) return { ...hit, body, start, end };
      }
    }
    if (localOnly) return null;
    // 只有本次会话已在 playurl 里授权过的地址才尝试复用本机已下载的原始范围；
    // 未授权、无总量、超限、超时或桥不可用都返回 null，随后走网络路径。
    if (reuseClient) {
      const reuseTotal = reuse.totalHint(url) || known;
      const reused = reuseTotal > 0 ? await reuseClient.read({ url, start, end, total: reuseTotal }) : null;
      // 离线查询的 await 期间也可能取消、导航或关闭后重开；命中与未命中都要先核对归属，
      // 不能把旧会话字节重新放回刚清空的缓存，也不能用它建立新会话的镜像身份。
      if (!current()) throw new DOMException("旧媒体请求已取消", "AbortError");
      if (reused) {
        track.size = reused.total;
        // 复用的字节来自本机磁盘，单独计数，不参与 CDN 吞吐与节点健康度统计。
        stats.reuseHits += 1;
        stats.reuseBytes += reused.body.length;
        playbackCache?.put(url, start, reused.body, reused.total, { contentType: reused.contentType });
        seedCachedReference(url);
        return { body: reused.body, start, end: start + reused.body.length, total: reused.total, contentType: reused.contentType };
      }
    }
    try {
      // assembleRange 同步登记急需分片后才让规划器运行，后台不会抢先把同一段切成大分片。
      const pending = assembleRange(url, start, end, signal, known);
      queuePump();
      const result = await pending;
      if (!current()) throw new DOMException("旧媒体请求已取消", "AbortError");
      track.size = result.total;
      return result;
    } catch (error) {
      if (!signal.aborted) network.fallback();
      throw error;
    }
  }

  // ---- 后台预热规划 -----------------------------------------------------------------

  /** 每种角色只预热播放器最近用过的轨道；索引尚未解析的活动轨道也纳入，以便先取到索引。 */
  function prefetchTracks() {
    const newest = new Map(), unindexed = [];
    for (const track of tracks.values()) {
      if (track.active === false) continue;
      const role = playbackCache?.index(track.url)?.role;
      if (!role) { unindexed.push(track); continue; }
      if (!newest.has(role) || track.lastPlayerSeen > newest.get(role).lastPlayerSeen) newest.set(role, track);
    }
    return [...newest.values(), ...unindexed];
  }

  function residentPrefix(url) {
    const first = playbackCache?.ranges(url)[0];
    return first && first[0] === 0 ? first[1] : 0;
  }

  /** 轨道前方想要的字节区间，附带 order（距播放点的秒数），越近越先下载。
   * @returns {{start: number, end: number, order: number}[]} */
  function wantedRanges(track, position, lead = cfg.leadSeconds, native = []) {
    seedCachedReference(track.url);
    const index = playbackCache?.index(track.url);
    if (index?.segments?.length) {
      const wanted = [{ start: 0, end: index.segments[0].start, order: 0 }];
      let bytes = 0;
      for (let i = firstSegmentAfter(index.segments, position); i < index.segments.length; i++) {
        const segment = index.segments[i];
        if (segment.timeStart >= position + lead || bytes >= AHEAD_BYTES_CAP) break;
        // 原生可播放区间只影响预热。播放器之后要求同一段时仍可直接从网络补齐。
        if (native.some(([start, end]) => start <= segment.timeStart && end >= segment.timeEnd)) continue;
        wanted.push({ start: segment.start, end: segment.end, order: Math.max(0, segment.timeStart - position) });
        bytes += segment.end - segment.start;
      }
      return wanted;
    }
    if (!playbackCache) return [];
    const head = residentPrefix(track.url);
    for (const probe of INDEX_PROBES) {
      const end = track.size ? Math.min(track.size, probe) : probe;
      if (head < end) return [{ start: 0, end, order: 0 }];
    }
    // 没有可用索引（非 DASH 或格式变化）：按平均码率从播放器最近请求处向后推进，只用于调度不用于标黄。
    if (!track.size || !track.anchor) return [];
    const duration = Number(currentVideo()?.duration) || 0;
    const rate = duration > 0 ? track.size / duration : 0;
    // 时长通常含小数，平均码率对应的窗口也可能有小数；HTTP Range 必须用整数，
    // 向下取整既不越过字节预算，也避免最后一片因小数终点被 CDN 拒绝。
    const bytes = Math.floor(Math.min(AHEAD_BYTES_CAP, rate ? rate * lead : 2 * MB));
    return [{ start: track.anchor, end: Math.min(track.size, track.anchor + bytes), order: 1 }];
  }

  function firstSegmentAfter(segments, position) {
    let lo = 0, hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].timeEnd <= position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function firstSegmentBeyondBytes(segments, end) {
    let left = 0, right = segments.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (segments[middle].end <= end) left = middle + 1;
      else right = middle;
    }
    return left;
  }

  function committedReadEnd(url, start, end, available) {
    const index = playbackCache?.index(url);
    if (!index?.segments.length) return end;
    const limit = Math.min(available, start + MAX_RANGE, end + (index.role === "audio" ? 384 * 1024 : 4 * MB));
    const first = firstSegmentBeyondBytes(index.segments, end);
    // 最多顺读三个已完整落盘的相邻分段。远处拖动不建立长时间驻留窗口。
    for (let i = first; i < Math.min(first + 3, index.segments.length); i++) {
      const segment = index.segments[i];
      if (segment.start > end || segment.end > limit) break;
      end = segment.end;
    }
    return end;
  }

  function activeDashCore(video = currentVideo()) {
    try {
      const core = window.player?.__core?.();
      return core?.video === video ? core : null;
    } catch { return null; }
  }

  function cancelCommittedHover() {
    if (!committedHover) return;
    clearTimeout(committedHover.timer);
    committedHover.controller.abort();
    committedHover = null;
  }

  function onProgressHover(event) {
    if (cfg.mode !== "always" || !committedClient?.hasSources() || event.buttons || event.pointerType !== "mouse") return;
    const schedule = event.target?.closest?.(".bpx-player-progress-schedule");
    const root = schedule?.closest(".bpx-player-progress");
    if (!root) return;
    if (committedHover?.schedule === schedule && Math.abs(event.clientX - committedHover.x) < 2) return;
    cancelCommittedHover();
    const video = currentVideo();
    if (!video || timelineVideo(root, video) !== video) return;
    const hover = committedHover = { schedule, root, video, x: event.clientX, controller: new AbortController() };
    // 鼠标扫过刻度时只保留最后一个点，快速来回时也不会反复读盘。
    const delay = Math.max(HOVER_DELAY_MS, HOVER_READ_INTERVAL_MS - (performance.now() - lastHoverReadAt));
    hover.timer = setTimeout(() => void prepareCommittedHover(hover).catch(() => {}), delay);
  }

  async function prepareCommittedHover(hover) {
    const { schedule, root, video, x, controller } = hover;
    const healthy = () => !controller.signal.aborted && cfg.mode === "always" && !document.hidden &&
      video === currentVideo() && !video.paused && !video.seeking && !video.ended && !video.error &&
      video.dataset?.biliCachePlayback !== "local" && video.readyState >= 3 &&
      currentBufferAhead() >= 4 * Math.max(1, video.playbackRate || 1);
    if (!healthy() || !schedule.isConnected) return;
    const schedules = [...root.querySelectorAll(".bpx-player-progress-schedule")];
    const rects = schedules.map(node => node.getBoundingClientRect());
    const index = schedules.indexOf(schedule), rect = rects[index];
    const width = rects.reduce((total, item) => total + item.width, 0);
    if (!rect?.width || x < rect.left || x > rect.right) return;
    const position = (rects.slice(0, index).reduce((total, item) => total + item.width, 0) + x - rect.left) / width * video.duration;
    if (!isCommittedTime(video, position) || nativeBufferRanges(video).some(([left, right]) => left <= position && position < right)) return;
    const core = activeDashCore(video);
    if (!core) return;

    const plans = ["audio", "video"].map(role => {
      const url = core.getCurrentPlayURLFor(role);
      const source = committedClient.find(url, tracks.get(trackKey(url))?.size, role);
      const segments = source && playbackCache.index(url)?.segments;
      const segment = segments?.[firstSegmentAfter(segments, position)];
      if (!segment || segment.timeStart > position || segment.end > source.end) return null;
      return { role, url, source, gaps: missingRanges(playbackCache.ranges(url), segment.start, segment.end) };
    });
    if (plans.some(plan => !plan)) return;
    // 紧邻前向缓冲的分段可以马上交给站点自己的追加队列。离散位置只准备正文，
    // 让跳转后的原生队列追加，避免乱序写入 SourceBuffer 触发回收或切换状态。
    if (position > video.currentTime && position <= video.currentTime + MAX_LEAD_SECONDS) updatePlayerBufferTarget();
    const pendingBytes = plans.reduce((total, plan) => total + plan.gaps.reduce((n, [left, right]) => n + right - left, 0), 0);
    if (!pendingBytes || pendingBytes > HOVER_PAIR_BYTES || pendingBytes > playbackCache.freeBytes()) return;
    lastHoverReadAt = performance.now();
    const generation = sessionGeneration;
    const current = plan => {
      const source = committedClient.find(plan.url, plan.source.total, plan.role);
      return healthy() && generation === sessionGeneration && activeDashCore(video) === core &&
        source && core.getCurrentPlayURLFor(plan.role) === plan.url && source.id === plan.source.id &&
        source.createdAt === plan.source.createdAt && source.runStartedAt === plan.source.runStartedAt;
    };
    for (const plan of plans) {
      for (const [left, right] of plan.gaps) {
        for (let start = left; start < right;) {
          if (!current(plan)) return;
          const end = Math.min(right, start + HOVER_SLICE_BYTES);
          const hit = await committedClient.read(plan.source, plan.url, start, end, controller.signal, true);
          if (!hit || !current(plan) || !playbackCache.put(plan.url, start, hit.body, hit.total,
            { contentType: hit.contentType, owned: true, allowEviction: false })) return;
          start = end;
        }
      }
    }
  }

  function isCommittedTime(video, target) {
    return normalizedCommittedRanges(video).some(([left, right]) => left * video.duration <= target && target < right * video.duration);
  }

  /** @param {{video: HTMLVideoElement, target: number, signal: AbortSignal}} seek
   * @param {"audio"|"video"} role @returns {Promise<boolean>} 是否还需等待原队列空闲
   */
  async function prepareSeekTrack(seek, role) {
    const { video, target, signal } = seek;
    const current = () => !signal.aborted && video.seeking && !document.hidden && currentVideo() === video &&
      Math.abs(video.currentTime - target) <= .2 && isCommittedTime(video, target);
    if (!current()) return false;
    try {
      const core = activeDashCore(video), adapter = core?.getCorePlayer?.();
      const stream = adapter?.getActiveStream?.();
      const processor = stream?.getProcessors?.()?.find(track => track.getType?.() === role);
      if (!processor) return false;
      const buffer = processor.getBufferController(), sink = buffer.getBuffer()?.getBuffer?.();
      const scheduler = processor.getScheduleController(), model = processor.getFragmentModel();
      if (!sink || scheduler.isStarted() !== true) return false;
      const ready = () => nativeBufferRanges(sink).some(([left, right]) => left <= target && target < right);
      const canSubmit = () => {
        const pending = scheduler.getSeekTarget();
        return Number.isFinite(pending) && Math.abs(pending - target) <= .2 &&
          !sink.updating && !buffer.getIsPruningInProgress() && !model.getLoadingRequests().length;
      };
      if (ready()) return false;
      if (!canSubmit()) return true;

      // 请求由站点当前的分段索引生成，恢复索引游标以保留正常调度。完整且已落盘的
      // 正文准备好后才交给站点 FragmentModel / SourceBuffer 队列。
      const index = processor.getIndexHandler();
      const representation = processor.getRepresentationController().getCurrentRepresentation();
      if (!representation) return false;
      const cursor = index.getIndex();
      let request;
      try { request = index.getSegmentRequestForTime(representation, target, { keepIdx: true, timeThreshold: 0 }); }
      finally { if (index.getIndex() !== cursor) index.setIndex(cursor); }
      const match = /^([0-9]+)-([0-9]+)$/.exec(request?.range || "");
      if (request?.action !== "download" || request.mediaType !== role || !match || model.isFragmentLoadedOrPending(request)) return false;
      const { url } = request, start = Number(match[1]), end = Number(match[2]) + 1;
      const source = committedClient.find(url, tracks.get(trackKey(url))?.size, role);
      if (!source || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          end <= start || end > source.end || end - start > MAX_RANGE) return false;
      if (!playbackCache.ranges(url).some(([left, right]) => left <= start && end <= right)) {
        // 画段只用已经驻留的正文。点击时额外读取大画段会和播放器自己的前台读取争用。
        if (role !== "audio" || end - start > SEEK_AUDIO_BYTES) return false;
        const hit = await committedClient.read(source, url, start, end, signal);
        if (!hit || !current() || activeDashCore(video) !== core || adapter.getActiveStream() !== stream ||
            processor.getRepresentationController().getCurrentRepresentation() !== representation ||
            !canSubmit() || ready() || model.isFragmentLoadedOrPending(request)) return false;
        if (!playbackCache.put(url, start, hit.body, hit.total, { contentType: hit.contentType, owned: true })) return false;
      }
      // executeRequest 用当前 Range 的正常取段及追加路径。此时正文已完整驻留，
      // 站点的下一轮检查仍按原计时运行，不会因提前尝试把 300 ms 等待往后推。
      model.executeRequest(request);
      return false;
    } catch { return false; }
  }

  function cancelCommittedSeek() {
    if (!committedSeek) return;
    for (const track of committedSeek.tracks) clearTimeout(track.timer);
    committedSeek.controller.abort();
    committedSeek = null;
  }

  function queueCommittedSeek(video) {
    cancelCommittedSeek();
    const target = video.currentTime;
    if (!committedClient?.hasSources() || !isCommittedTime(video, target)) return;
    const controller = new AbortController(), until = performance.now() + SEEK_WINDOW_MS;
    const seek = committedSeek = { controller, video, tracks: [{ role: "audio" }, { role: "video" }] };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SEEK_WINDOW_MS)]);
    // 两轨可以独立完成剪裁和读取，避免慢的一轨挡住另一轨已驻留的分段。
    for (const track of seek.tracks) {
      const tick = async () => {
        if (signal.aborted || performance.now() >= until) return;
        if (await prepareSeekTrack({ video, target, signal }, track.role) && !signal.aborted && performance.now() < until)
          track.timer = setTimeout(tick, SEEK_RETRY_MS);
      };
      track.timer = setTimeout(tick, SEEK_RETRY_MS);
    }
  }

  function seedCommittedIndices(video) {
    if (!committedClient?.hasSources() || document.hidden) return;
    const core = activeDashCore(video);
    for (const role of ["video", "audio"]) {
      let url;
      try { url = core?.getCurrentPlayURLFor?.(role); } catch { continue; }
      if (url && committedClient.find(url, 0, role) && tracks.get(trackKey(url))?.url !== url) trackFor(url);
    }
    for (const track of prefetchTracks()) {
      const { url } = track;
      if (playbackCache?.index(url) || track.indexRead || Date.now() < (track.indexRetryAt || 0)) continue;
      const source = committedClient.find(url, track.size);
      if (!source) continue;
      const head = residentPrefix(url);
      const end = INDEX_PROBES.map(limit => Math.min(limit, source.end)).find(limit => limit > head);
      if (!end) continue;
      // 有时 B 站已在配置到达前读过索引。先从本地补头部，进度条不依赖播放器再向 CDN 取一次。
      const generation = sessionGeneration, pageKey = currentPageKey();
      track.indexRead = committedClient.read(source, url, 0, end, AbortSignal.timeout(650)).then(reply => {
        if (!reply || generation !== sessionGeneration || pageKey !== currentPageKey() ||
            cfg.mode !== "always" || track.url !== url) return;
        track.size = reply.total;
        playbackCache?.put(url, 0, reply.body, reply.total, { prefetched: false, contentType: reply.contentType, owned: true });
        queuePump();
      }).catch(() => {}).finally(() => {
        track.indexRead = null;
        track.indexRetryAt = Date.now() + 400;
      });
    }
  }

  function recordUsefulBytes(bytes) {
    const now = performance.now(), elapsed = now - rateAt;
    if (elapsed >= 1500) {
      // 只统计校验后交付的正文。空闲间隔不会把限速估计压低，也不会把对冲副本算两次。
      if (elapsed < 5000 && rateBytes > 0) boundedPush(usefulRates, rateBytes * 1000 / elapsed, 12);
      if (elapsed > 15_000) usefulRates = [];
      rateBytes = 0;
      rateAt = now;
    }
    rateBytes += bytes;
  }

  function nativeBufferRanges(video) {
    const buffered = video?.buffered;
    return Array.from({ length: buffered?.length || 0 }, (_, i) => [buffered.start(i), buffered.end(i)]);
  }

  /** 以两个轨道的连续驻留覆盖限制播放器的额外缓冲，按整段计入字节预算。
   * @param {number} end 播放器连续缓冲的末端 @param {number} ordinaryEnd 原配置的目标
   * @param {{segments: object[], ranges: number[][]}[]} sources @returns {number}
   */
  function residentPlayerBufferEnd(end, ordinaryEnd, sources) {
    // SIDX 的分段边界与 MSE 解码后上报的最后帧时间存在小偏差，只用于衔接相邻分段。
    const tails = sources.map(source => source.ranges.find(([left, right]) => left <= end + .15 && right > end)?.[1] || end);
    const limit = Math.min(ordinaryEnd + PLAYER_EXTRA_SECONDS, ...tails);
    if (limit <= Math.max(end, ordinaryEnd)) return end;
    const candidates = [];
    for (const { segments } of sources) {
      for (let i = firstSegmentAfter(segments, ordinaryEnd); i < segments.length; i += 1) {
        const segment = segments[i];
        if (segment.timeStart >= limit) break;
        // 站点本来就会取到跨过原目标的那个完整片段，尤其是 4K，不能把它再算成新增开销。
        if (segment.timeStart >= ordinaryEnd) candidates.push(segment);
      }
    }
    candidates.sort((a, b) => a.timeStart - b.timeStart);
    let remaining = PLAYER_EXTRA_BYTES;
    for (const segment of candidates) {
      remaining -= segment.end - segment.start;
      if (remaining < 0) return Math.max(end, segment.timeStart);
    }
    return limit;
  }

  function restorePlayerBufferTarget() {
    const owner = playerBufferTarget;
    if (!owner) return;
    playerBufferTarget = null;
    PLAYER_BUFFER_SETTINGS.forEach((key, index) => {
      if (owner.applied[index] === owner.original[index]) return;
      try {
        // 跟踪站点自己的配置修改、切换或销毁，回退时只恢复仍由插件持有的值。
        if (owner.adapter[`get${key}`]() === owner.applied[index]) owner.adapter[`set${key}`](owner.original[index]);
      } catch { /* 失效的播放器交还给站点。 */ }
    });
  }

  function updatePlayerBufferTarget() {
    const video = currentVideo();
    if (cfg.mode !== "always" || document.hidden || !video || video.paused || video.seeking || video.ended ||
        video.error || video.readyState < 3 || video.dataset?.biliCachePlayback === "local") return restorePlayerBufferTarget();
    const position = video.currentTime;
    const rate = Math.max(1, Number(video.playbackRate) || 1);
    const playableEnd = nativeBufferRanges(video).find(([start, end]) => start <= position && position < end)?.[1] || 0;
    if (playableEnd - position < 3 * rate) return restorePlayerBufferTarget();
    try {
      // B 站的 DASH 内核与当前 video 必须同属一个实例。使用其前向目标接口，由原调度器请求并追加，
      // 避免直接写 SourceBuffer 与站点正在处理的 appendBuffer、清晰度切换争抢。
      const dash = window.player?.__core?.();
      if (dash?.video !== video) return restorePlayerBufferTarget();
      const urls = ["video", "audio"].map(role => dash.getCurrentPlayURLFor(role));
      const pair = chooseCurrentDashPair([...tracks.values()].filter(track => track.active !== false));
      if (!pair || pair.video.url !== urls[0] || pair.audio.url !== urls[1]) return restorePlayerBufferTarget();
      const adapter = dash.getCorePlayer();
      const current = PLAYER_BUFFER_SETTINGS.map(key => adapter[`get${key}`]());
      if (!current.every(value => Number.isFinite(value) && value > 0) ||
          !PLAYER_BUFFER_SETTINGS.every(key => typeof adapter[`set${key}`] === "function")) return restorePlayerBufferTarget();

      if (playerBufferTarget && (playerBufferTarget.adapter !== adapter || playerBufferTarget.video !== video ||
          playerBufferTarget.source !== video.currentSrc || urls.some((url, index) => url !== playerBufferTarget.urls[index]) ||
          current.some((value, index) => value !== playerBufferTarget.applied[index]))) {
        return restorePlayerBufferTarget();
      }
      const original = playerBufferTarget?.original || current;
      const baseline = Math.max(...original);
      const sources = ["video", "audio"].map(role => {
        const track = pair[role];
        const ranges = playbackCache.timeRanges(track.url).map(range => range.slice());
        // 落盘段也可以交给站点自己的追加队列。只扩到完整双轨都已本地可读的位置，
        // 落盘不足时不会因这次扩展调高网页的网络预热目标。
        for (const [start, end] of committedTrackRanges(track, role)) addRange(ranges, start, end);
        return { ranges, segments: playbackCache.index(track.url).segments };
      });
      const end = Math.min(position + MAX_LEAD_SECONDS, residentPlayerBufferEnd(playableEnd, position + baseline, sources));
      // 留出一轮 500 ms 检查期间的播放推进量，并向下取整，避免把目标推过缓存末端。
      const target = Math.floor((end - position - (.65 * rate + .15)) * 2) / 2;
      if (target <= Math.max(baseline, playableEnd - position)) return restorePlayerBufferTarget();
      playerBufferTarget ||= { adapter, video, source: video.currentSrc, urls, original, applied: current.slice() };
      PLAYER_BUFFER_SETTINGS.forEach((key, index) => {
        if (current[index] === target) return;
        playerBufferTarget.applied[index] = target;
        adapter[`set${key}`](target);
      });
    } catch {
      // 未识别到站点版本或内核正切换时，继续走已有 Range 复用路径。
      restorePlayerBufferTarget();
    }
  }

  function adaptiveWindow(video, active, native) {
    const position = Number(video?.currentTime) || 0;
    if (!video || video.ended || video.dataset?.biliCachePlayback === "local" ||
        (video.paused && (document.hidden || (!video.seeking && (position > 0 || video.played?.length))))) {
      refilling = false;
      return { position, lead: 0, refill: false };
    }
    const rate = Math.max(0.25, Number(video.playbackRate) || 1);
    const duration = Number(video.duration);
    const ready = native.map(range => range.slice());
    if (Number.isFinite(duration) && duration > 0) {
      for (const [start, end] of normalizedPrefetchedRanges(video)) addRange(ready, start * duration, end * duration);
    }
    const ahead = (ready.find(([start, end]) => start <= position && position < end)?.[1] - position || 0) / rate;
    const early = video.seeking || (video.readyState != null && video.readyState < 3) || ahead < 2 || video.paused;
    let target = early ? STARTUP_SECONDS : STEADY_SECONDS;
    const demand = duration > 0 ? active.reduce((sum, track) => sum + (track.size || 0), 0) * rate / duration : 0;
    const supply = usefulRates.length >= 3 && performance.now() - rateAt < 10_000 ? percentile(usefulRates, .25) : 0;
    if (demand && supply) {
      if (supply < demand) target = STARTUP_SECONDS;
      else if (!early && duration >= 300 && supply >= 1.25 * demand &&
          Date.now() - Math.max(stats.lastStallAt, stats.lastSlowAt) < 60_000) target = 60;
    }
    const lead = Math.max(0, Math.min(cfg.leadSeconds, target * rate,
      Number.isFinite(duration) && duration > 0 ? duration - position : Infinity));
    const realTarget = lead / rate;
    if (ahead >= realTarget) refilling = false;
    else if (ahead < Math.min(realTarget, target / 2)) refilling = true;
    return { position, lead, refill: refilling };
  }

  function budgetedRanges(active, position, lead, native) {
    const candidates = active.flatMap(track => wantedRanges(track, position, lead, native).map(range => ({ track, range })));
    candidates.sort((left, right) => left.range.order - right.range.order);
    const byUrl = new Map(active.map(track => [track.url, []]));
    let remaining = AHEAD_BYTES_CAP;
    for (const { track, range } of candidates) {
      const bytes = range.end - range.start;
      if (bytes <= 0 || bytes > remaining) continue;
      byUrl.get(track.url).push(range);
      remaining -= bytes;
    }
    return byUrl;
  }

  let pumpQueued = false;
  function queuePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    setTimeout(() => { pumpQueued = false; planPrefetch(); }, 0);
  }

  /**
   * 事件驱动的预热流水线：任何分片完成、播放器请求或拖动都会触发一次规划。
   * 1. 先取消不再需要的后台分片（拖动/换清晰度后旧窗口的数据），让出槽位；
   * 2. 再把前方窗口内 未驻留且未在途 的缺口按 距播放点秒数 排序，补足到排队深度。
   * 音视频按同一时间轴交错排序，因此不会出现视频跑得很远、音频却还没到的情况。
   */
  function planPrefetch() {
    if (cfg.mode !== "always") return;
    const video = currentVideo();
    if (video?.seeking && normalizedCommittedRanges(video).some(([start, end]) =>
      video.currentTime >= start * video.duration && video.currentTime < end * video.duration)) {
      // 跳到落盘区间时先让出页面的预热请求。没有命中的播放器急需请求仍可补网。
      network.pruneBackground(() => false);
      return;
    }
    seedCommittedIndices(video);
    const active = prefetchTracks(), native = nativeBufferRanges(video);
    const { position, lead, refill } = adaptiveWindow(video, active, native);
    retentionAhead = lead;
    updateRetentionHints();
    const byUrl = lead ? budgetedRanges(active, position, lead, native) : new Map();
    const committedEnds = new Map(active.map(track => [track.url, committedClient?.find(track.url, track.size)?.end || 0]));
    network.pruneBackground((url, start, end) => end > (committedEnds.get(url) || 0) &&
      byUrl.get(url)?.some(range => start < range.end && end > range.start));
    if (!refill) return;
    let room = BACKGROUND_QUEUE - network.backgroundPending();
    if (room <= 0) return;
    const jobs = [];
    for (const track of active) {
      if (Date.now() < track.retryAt) continue;
      const busy = playbackCache ? playbackCache.ranges(track.url) : [];
      const committedEnd = committedEnds.get(track.url);
      if (committedEnd) addRange(busy, 0, committedEnd);
      for (const range of network.inflightRanges(track.url)) addRange(busy, range[0], range[1]);
      for (const range of byUrl.get(track.url) || []) {
        for (const [start, end] of missingRanges(busy, range.start, range.end)) jobs.push({ track, start, end, order: range.order });
      }
    }
    jobs.sort((left, right) => left.order - right.order);
    while (room > 0 && jobs.length) {
      const job = jobs.shift();
      const end = Math.min(job.end, job.start + PIECE);
      room -= network.prefetch(job.track.url, job.start, end, { order: job.order, total: job.track.size });
      if (end < job.end) {
        job.start = end;
        // 同一时刻先各给一片，避免大视频段占满名额，音频一直等不到第一片。
        const next = jobs.findIndex(other => other.order > job.order);
        jobs.splice(next < 0 ? jobs.length : next, 0, job);
      }
    }
  }

  // ---- 估计器护栏 -----------------------------------------------------------------

  function sanitizeEstimator(raw) {
    if (cfg.mode !== "always") return raw;
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
    if (estimatorCleanupQueued || cfg.mode !== "always" || !nativeStorageSet) return;
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

  // ---- 统计 ---------------------------------------------------------------------

  function publicStats() {
    const transfer = network.snapshot();
    const hosts = {};
    for (const [name, host] of Object.entries(stats.hosts)) {
      hosts[name] = {
        requests: host.requests,
        slow: host.slow,
        errors: host.errors,
        ttfbP50: percentile(host.ttfbs, 0.5),
        ttfbP95: percentile(host.ttfbs, 0.95),
        hotKbpsP25: percentile(host.hotThroughputsKbps, 0.25)
      };
    }
    const cache = playbackCache?.stats || {};
    return {
      at: Date.now(),
      mode: cfg.mode,
      requests: stats.requests,
      slowRequests: stats.slowRequests,
      requestErrors: stats.requestErrors,
      activeTracks: [...tracks.values()].filter(track => track.active !== false).length,
      networkSpeed: transfer.speed,
      networkActive: transfer.active,
      networkLimit: transfer.limit,
      networkQueued: transfer.queued,
      networkHost: transfer.host,
      networkRescues: transfer.rescues,
      acceleratedRequests: transfer.accelerated,
      acceleratedMB: +(transfer.acceleratedBytes / MB).toFixed(2),
      nativeFallbacks: transfer.nativeFallbacks,
      reuseHits: stats.reuseHits,
      reuseMB: +(stats.reuseBytes / MB).toFixed(2),
      committedHits: stats.committedHits,
      committedMB: +(stats.committedBytes / MB).toFixed(2),
      blockedNodes: transfer.blocked,
      networkReceivedMB: +(transfer.receivedBytes / MB).toFixed(2),
      prefetchAheadSec: prefetchAhead(),
      coldTracks: [...tracks.values()].filter((track) => track.cold).length,
      cacheHits: (cache.hits || 0) + (cache.partialHits || 0) + stats.committedHits,
      cacheHitMB: +(((cache.hitBytes || 0) + (cache.partialHitBytes || 0) + stats.committedBytes) / MB).toFixed(2),
      cacheResidentMB: +((cache.bytes || 0) / MB).toFixed(2),
      prefetchMB: +(transfer.prefetchBytes / MB).toFixed(1),
      prefetchErrors: transfer.prefetchErrors,
      prefetching: transfer.prefetching,
      stalls: stats.stalls,
      stallMs: Math.round(stats.stallMs + (stats.waitingSince ? performance.now() - stats.waitingSince : 0)),
      playedSec: stats.playedSec,
      bufferAheadSec: +currentBufferAhead().toFixed(1),
      pageHidden: document.hidden,
      hosts
    };
  }

  function prefetchAhead() {
    const video = currentVideo();
    if (!(video?.duration > 0)) return 0;
    const now = video.currentTime / video.duration;
    const range = normalizedPrefetchedRanges(video).find(([start, end]) => start <= now && end > now);
    return range ? +((range[1] - now) * video.duration).toFixed(1) : 0;
  }

  // ---- 进度条着色 -------------------------------------------------------------------

  // 进度条按帧刷新；驻留、轨道和时长都没变时直接复用上次的音视频交集。
  let timelineMemo = { video: null, key: "", ranges: [] };
  let committedTimelineMemo = { video: null, key: "", ranges: [] };
  const oversizedCommittedSegments = new WeakMap();
  function eligibleDashPair() {
    const eligible = [...tracks.values()].filter(track => track.active !== false);
    const pair = chooseCurrentDashPair(eligible);
    // 播放器刚切档时先撤下旧轨的颜色，等新轨索引出现。
    if (pair && !eligible.some(track => !playbackCache?.index(track.url)?.role &&
        track.lastPlayerSeen > Math.min(pair.video.lastPlayerSeen, pair.audio.lastPlayerSeen))) return pair;
    return null;
  }

  document.addEventListener("bili-buffer-request-source-selection", () => {
    const data = document.documentElement?.dataset;
    if (!data) return;
    const pair = eligibleDashPair();
    const dash = activeDashCore();
    for (const [role, key] of [["video", "biliBufferSourceVideo"], ["audio", "biliBufferSourceAudio"]]) {
      let url;
      try { url = dash?.getCurrentPlayURLFor?.(role); } catch { /* 内核可能正在切源。 */ }
      url ||= pair?.[role].url;
      if (reuse?.authorizedMediaPath?.(url)) data[key] = pathFor(url);
      else delete data[key];
    }
  });

  function normalizedPrefetchedRanges(video = currentVideo()) {
    const revision = playbackCache?.revision?.();
    const duration = Number(video?.duration);
    const key = `${revision}|${playerSequence}|${tracks.size}|${duration}`;
    if (revision !== undefined && video === timelineMemo.video && key === timelineMemo.key) return timelineMemo.ranges;
    const pair = eligibleDashPair();
    const ranges = pair ? intersectRanges(normalizedTrackRanges(pair.video, duration), normalizedTrackRanges(pair.audio, duration)) : [];
    timelineMemo = { video, key, ranges };
    return ranges;
  }

  /** SIDX 的段末字节索引单调递增。以已提交分块为上界找真实媒体时间，半个段不会冒充就绪。 */
  function committedTrackRanges(track, role) {
    const source = committedClient?.find(track.url, track.size, role);
    if (!source) return [];
    let index = playbackCache?.index(track.url);
    if (!index) {
      // CDN 主备切换时复用同一路径、同一总长已经解析过的索引，直到新地址的初始化段到达。
      const path = pathFor(track.url);
      for (const previous of tracks.values()) {
        if (previous.path !== path || previous.size !== source.total) continue;
        const candidate = playbackCache?.index(previous.url);
        if (candidate?.role === role) { index = candidate; break; }
      }
    }
    const segments = index?.segments;
    if (index?.role !== role || !segments?.length || segments[0].start >= source.end) return [];
    const count = firstSegmentBeyondBytes(segments, source.end);
    if (!count) return [];
    let gaps = oversizedCommittedSegments.get(index);
    if (!gaps) {
      gaps = segments.filter(segment => segment.end - segment.start > committedMaxBytes)
        .map(segment => [segment.timeStart, segment.timeEnd]);
      oversizedCommittedSegments.set(index, gaps);
    }
    return missingRanges(gaps, segments[0].timeStart, segments[count - 1].timeEnd);
  }

  function normalizedCommittedRanges(video = currentVideo()) {
    const duration = Number(video?.duration);
    if (!committedClient?.hasSources() || cfg.mode !== "always" || !Number.isFinite(duration) || duration <= 0 ||
        video?.dataset?.biliCachePlayback === "local") return [];
    let urls;
    try {
      const core = activeDashCore(video);
      if (core?.getCurrentPlayURLFor) urls = ["video", "audio"].map(role => core.getCurrentPlayURLFor(role));
    } catch { /* 站点切换内核时回退到播放请求观测结果。 */ }
    const key = `${committedClient.revision()}|${playbackCache?.revision?.()}|${playerSequence}|${tracks.size}|${duration}|${urls?.join("|") || ""}`;
    if (video === committedTimelineMemo.video && key === committedTimelineMemo.key) return committedTimelineMemo.ranges;
    // 内核已换轨、但新分片尚未到达时，旧请求记录仍活跃，不能据此把旧画质标成可用。
    const pair = urls?.every(Boolean)
      ? { video: tracks.get(trackKey(urls[0])) || { url: urls[0] }, audio: tracks.get(trackKey(urls[1])) || { url: urls[1] } }
      : eligibleDashPair();
    const ranges = pair ? intersectRanges(committedTrackRanges(pair.video, "video"), committedTrackRanges(pair.audio, "audio"))
      .map(([left, right]) => [Math.min(1, left / duration), Math.min(1, right / duration)])
      .filter(([left, right]) => right > left) : [];
    committedTimelineMemo = { video, key, ranges };
    return ranges;
  }

  function normalizedTrackRanges(track, duration = Number(currentVideo()?.duration)) {
    const normalized = [];
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

  /** 按顺序绘制相对当前进度条段的半开区间，空档保留原底色。
   * @param {Array<[number, number, string?]>} ranges @param {string} color @returns {string} */
  function timelineGradient(ranges, color) {
    const stops = [];
    let cursor = 0;
    for (const [start, end, rangeColor = color] of ranges) {
      if (start > cursor) stops.push(`transparent ${cursor * 100}%, transparent ${start * 100}%`);
      stops.push(`${rangeColor} ${start * 100}%, ${rangeColor} ${end * 100}%`);
      cursor = end;
    }
    if (cursor < 1) stops.push(`transparent ${cursor * 100}%, transparent 100%`);
    return `linear-gradient(to right, ${stops.join(", ")})`;
  }

  function timelineVideo(root, main) {
    const player = root.closest?.(".bpx-player-container, #bilibili-player");
    return player ? playerVideo(player) : main;
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
        opacity: 0 !important;
      }
      .bpx-player-progress-schedule[data-bili-buffer-preheat]::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: repeating-linear-gradient(135deg, var(--bili-buffer-preheat-color) 0 2px, transparent 2px 5px);
        -webkit-mask-image: var(--bili-buffer-preheat-mask);
        mask-image: var(--bili-buffer-preheat-mask);
      }
      .bpx-player-progress-schedule[data-bili-buffer-committed]::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image: radial-gradient(circle at center, var(--bili-buffer-committed-color) 1px, transparent 1.5px);
        background-size: 5px 100%;
        -webkit-mask-image: var(--bili-buffer-committed-mask);
        mask-image: var(--bili-buffer-committed-mask);
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

  function setTimelineProperty(style, name, value) {
    if (style.getPropertyValue(name) === value) return;
    if (value) style.setProperty(name, value);
    else style.removeProperty(name);
  }

  // 只把“用户正在看哪里”交给缓存，内存管理仍由缓存自身负责；
  // 失活轨道显式释放，避免旧清晰度/旧 CDN 地址继续占用保护名额。
  function updateRetentionHints() {
    if (!playbackCache?.retain) return;
    // 渲染在关闭辅助后仍运行，不能重新保护刚被清理的旧轨道。
    if (cfg.mode !== "always") { playbackCache.clearRetention?.(); return; }
    const video = currentVideo();
    const position = Number(video?.currentTime) || 0;
    const duration = Number(video?.duration) || 0;
    const ahead = Math.min(cfg.leadSeconds, retentionAhead);
    for (const track of tracks.values()) {
      if (track.active === false) playbackCache.release?.(track.url);
      else playbackCache.retain(track.url, { active: true, position, ahead, rewind: RETENTION_REWIND_SECONDS, duration, protectInit: true });
    }
  }

  function renderPreheatProgress() {
    updateRetentionHints();
    ensurePreheatProgressStyle();
    const main = currentVideo();
    const prefetched = cfg.showPreheatHighlight !== false && main?.dataset?.biliCachePlayback !== "local"
      ? normalizedPrefetchedRanges(main) : [];
    const committed = cfg.showPreheatHighlight !== false ? normalizedCommittedRanges(main) : [];
    const playedColor = /^#[0-9a-f]{6}$/i.test(cfg.progressColor || "") ? cfg.progressColor : "#00a1d6";
    const preheatColor = normalizePreheatColor(cfg.preheatColor);
    for (const root of document.querySelectorAll(".bpx-player-progress, .bpx-player-shadow-progress-area")) {
      const video = timelineVideo(root, main);
      const duration = Number(video?.duration);
      const hasTimeline = duration > 0 && Number.isFinite(duration);
      const schedules = [...root.querySelectorAll(".bpx-player-progress-schedule")];
      if (!schedules.length) continue;
      const widths = schedules.length === 1 ? [1] : schedules.map((schedule) => schedule.getBoundingClientRect().width);
      const total = widths.reduce((sum, width) => sum + width, 0);
      const native = hasTimeline ? nativeBufferRanges(video).map(([start, end]) => [start / duration, end / duration]) : [];
      const extension = video === main ? prefetched : [];
      // video.buffered 确认就绪，SIDX 双轨交集确认插件覆盖。追加成功时把斜线换成实色，保留来源颜色。
      const preheatReady = intersectRanges(native, extension);
      const diskWaiting = video === main ? committed.flatMap(([start, end]) => missingRanges(native, start, end)) : [];
      const blocked = diskWaiting.length ? native.map(range => range.slice()) : native;
      for (const [start, end] of diskWaiting) addRange(blocked, start, end);
      const preheatWaiting = extension.flatMap(([start, end]) => missingRanges(blocked, start, end));
      const ordinaryReady = preheatReady.length ? native.flatMap(([start, end]) => missingRanges(preheatReady, start, end)) : native;
      const fallbackColor = bufferColorFor(root.querySelector(".bpx-player-progress-schedule-buffer"));
      let cursor = 0;
      for (let i = 0; i < schedules.length; i += 1) {
        const schedule = schedules[i];
        const start = total > 0 ? cursor / total : 0;
        cursor += widths[i];
        const end = total > 0 ? cursor / total : 0;
        const paint = Boolean(video && widths[i] > 0);
        let fill = "", mask = "", diskMask = "";
        if (paint) {
          // B 站灰条只表达一个前沿；跨段跳转或回收后，按真实 TimeRanges 保留中间的缺口。
          const ready = projectTimelineRanges(ordinaryReady, start, end);
          for (const [left, right] of projectTimelineRanges(preheatReady, start, end)) ready.push([left, right, preheatColor]);
          if (preheatReady.length) ready.sort((a, b) => a[0] - b[0]);
          const buffer = schedule.querySelector(".bpx-player-progress-schedule-buffer");
          fill = timelineGradient(ready, buffer ? bufferColorFor(buffer) : fallbackColor);
          const waiting = projectTimelineRanges(preheatWaiting, start, end);
          if (waiting.length) mask = timelineGradient(waiting, "black");
          const fromDisk = projectTimelineRanges(diskWaiting, start, end);
          if (fromDisk.length) diskMask = timelineGradient(fromDisk, "black");
        }
        if (schedule.dataset.biliBufferColors !== "true") schedule.dataset.biliBufferColors = "true";
        setTimelineProperty(schedule.style, "--bili-buffer-played-color", playedColor);
        setTimelineProperty(schedule.style, "--bili-buffer-state-fill", fill);
        setTimelineProperty(schedule.style, "--bili-buffer-preheat-mask", mask);
        setTimelineProperty(schedule.style, "--bili-buffer-preheat-color", mask ? preheatColor : "");
        setTimelineProperty(schedule.style, "--bili-buffer-committed-mask", diskMask);
        setTimelineProperty(schedule.style, "--bili-buffer-committed-color", diskMask ? preheatColor : "");
        schedule.toggleAttribute("data-bili-buffer-paint", paint);
        schedule.toggleAttribute("data-bili-buffer-preheat", Boolean(mask));
        schedule.toggleAttribute("data-bili-buffer-committed", Boolean(diskMask));
      }
    }
  }

  // ---- 生命周期 ---------------------------------------------------------------------

  function clearSession() {
    restorePlayerBufferTarget();
    cancelCommittedHover();
    cancelCommittedSeek();
    sessionGeneration += 1;
    network.reset();
    playbackCache?.clear();
    timelineMemo = { video: null, key: "", ranges: [] };
    committedTimelineMemo = { video: null, key: "", ranges: [] };
    committedClient?.setSources([]);
    refilling = false;
    retentionAhead = STEADY_SECONDS;
    usefulRates = [];
    rateBytes = 0;
    rateAt = performance.now();
    stats.lastStallAt = 0;
    stats.lastSlowAt = 0;
  }

  function resetTracksAfterNavigation() {
    const nextPageKey = currentPageKey();
    if (nextPageKey === lastPageKey) return false;
    lastPageKey = nextPageKey;
    clearSession();
    tracks.clear();
    reuse?.clearAuthorization?.();
    if (document.documentElement) {
      delete document.documentElement.dataset.biliBufferQuality;
      delete document.documentElement.dataset.biliBufferQualityUrl;
    }
    initialPlayinfo = window.__playinfo__; // SPA 导航后不重新注册旧页面留下的清单。
    renderPreheatProgress();
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "ext->page") return;
    if (message.type === "committedSources" && message.payload?.pageUrl === location.href) {
      resetTracksAfterNavigation();
      if (cfg.mode === "always" && committedClient?.setSources(message.payload.sources)) {
        renderPreheatProgress();
        queuePump();
      }
      return;
    }
    if (message.type === "config" && message.payload && typeof message.payload === "object") {
      const payload = message.payload;
      for (const key of CONFIG_KEYS) if (Object.hasOwn(payload, key)) cfg[key] = payload[key];
      cfg.mode = ["off", "observe"].includes(payload.mode) ? "off" : "always";
      cfg.preheatColor = normalizePreheatColor(cfg.preheatColor);
      if (cfg.mode === "off") {
        clearSession();
        initialPlayinfo = null;
        for (const track of tracks.values()) { track.failures = 0; track.retryAt = 0; }
      }
      renderPreheatProgress();
      queueEstimatorCleanup();
      queuePump();
    }
  });

  window.__biliBufferPlaybackAssistInternals = {
    cfg,
    network,
    capturePlayurl,
    loadPlayerRange,
    planPrefetch,
    wantedRanges,
    residentPlayerBufferEnd,
    updatePlayerBufferTarget,
    prepareSeekTrack,
    stats,
    tracks,
    percentile,
    parseRangeHeader,
    parseContentRange,
    addRange,
    missingRanges,
    trackFor,
    recordMedia,
    slowThreshold,
    dynamicEstimatorFloor,
    sanitizeEstimator,
    queueEstimatorCleanup,
    normalizedPrefetchedRanges,
    normalizedCommittedRanges,
    normalizedTrackRanges,
    chooseCurrentDashPair,
    intersectRanges,
    updateRetentionHints,
    normalizePreheatColor,
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
    loadRange: loadPlayerRange,
    enabled: () => { resetTracksAfterNavigation(); return cfg.mode === "always"; },
    // 响应交付不读取进度条布局；绘制循环按最新缓冲快照统一更新。
    onChange: queuePump,
    onHit: (url, hit) => {
      // 本地命中不是 CDN 吞吐样本，不能污染播放器的网络能力估计。
      const track = trackFor(url);
      if (track) primeTrackFromHeaders(track, { start: hit.start }, `bytes ${hit.start}-${hit.end - 1}/${hit.total}`, 206);
      queuePump();
    }
  });
  scanVideos();
  document.addEventListener("pointermove", onProgressHover, { passive: true });
  document.addEventListener("pointerdown", cancelCommittedHover, { capture: true, passive: true });
  document.addEventListener("pointerout", event => {
    const schedule = committedHover?.schedule;
    if (schedule?.contains(event.target) && !schedule.contains(event.relatedTarget)) cancelCommittedHover();
  });
  const stopPlayerPreparation = () => {
    restorePlayerBufferTarget();
    cancelCommittedHover();
    cancelCommittedSeek();
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopPlayerPreparation(); });
  document.addEventListener("bili-buffer-site-quality", stopPlayerPreparation);
  window.addEventListener("pagehide", stopPlayerPreparation);
  // 能力缺失时只是少一次自动补扫；1 秒定时器仍会周期扫描 video，不影响播放。
  if (typeof MutationObserver === "function") new MutationObserver(scanVideos).observe(document, { childList: true, subtree: true });
  setInterval(() => {
    resetTracksAfterNavigation();
    if (anyVideoPlaying()) stats.playedSec += 1;
    scanVideos();
    window.postMessage({ channel: CHANNEL, dir: "page->ext", type: "stats", payload: publicStats() }, "*");
  }, 1000);
  // 进度条跟随帧刷新（隐藏标签页不画）；规划主要由事件驱动，这个定时器只负责播放位置推进后的补位。
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
    captureInitialPlayinfo();
    planPrefetch();
    updatePlayerBufferTarget();
  }, 500);
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, track] of tracks) {
      if (track.lastSeen < cutoff && !network.inflightRanges(track.url).length) { playbackCache?.release?.(track.url); tracks.delete(key); }
    }
  }, 30000);
})();
