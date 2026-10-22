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
  // 前方预热窗口按 SIDX 真实秒数计算；同时按字节封顶，给 128 MiB 页面缓存留出回看与播放器请求的余量。
  const LEAD_SECONDS = 90;
  const AHEAD_BYTES_CAP = 96 * MB;
  // 索引未知时先取文件头解析 SIDX：64 KiB 覆盖绝大多数视频，超长视频的索引再扩到 1 MiB。
  const INDEX_PROBES = [64 * 1024, MB];
  // 后台分片排队深度：略多于引擎的后台槽位，分片一完成就有下一片可发，流水线不断档。
  const BACKGROUND_QUEUE = 16;
  const PIECE = window.BiliPlaybackNetwork.BACKGROUND_PIECE || 512 * 1024;
  const DEFAULTS = {
    mode: "pending",
    slowTtfbMs: 800,
    leadSeconds: LEAD_SECONDS,
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
    lastSlowAt: 0,
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
  const PLAYURL_RE = /^https:\/\/api\.bilibili\.com\/x\/(?:player\/(?:wbi\/)?playurl|player\/v2)(?:\?|$)/;
  function capturePlayurl(payload, pageKey) {
    if (currentPageKey() !== pageKey) return;
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

  function currentVideo() {
    const all = videos();
    return all.find(item => !item.paused) || all[0];
  }

  function currentBufferAhead() {
    let best = 0;
    for (const video of videos()) {
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
    return videos().some((video) => !video.paused && !video.ended && video.readyState > 2);
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);
    const beginWaiting = () => {
      if (!video.paused && !video.ended && !stats.waitingSince) {
        stats.waitingSince = performance.now();
        stats.stalls += 1;
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
    video.addEventListener("pause", endWaiting);
    // 拖动后旧窗口的后台分片立即让位，新窗口马上开始规划。
    video.addEventListener("seeking", queuePump);
  }

  function scanVideos() {
    for (const video of videos()) observeVideo(video);
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
    const known = track.size || network.total(url);
    const start = Number(parsed[1]);
    const end = parsed[2] ? Number(parsed[2]) + 1 : known;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end - start > MAX_RANGE || (known && end > known)) return null;
    // 预热窗口（无索引时）从播放器正在要的位置之后接续；向后拖动也必须允许回退。
    track.anchor = end;
    // 只有本次会话已在 playurl 里授权过的地址才尝试复用本机已下载的原始范围；
    // 未授权、无总量、超限、超时或桥不可用都返回 null，随后走网络路径。
    if (reuseClient) {
      const reuseTotal = reuse.totalHint(url) || known;
      const reused = reuseTotal > 0 ? await reuseClient.read({ url, start, end, total: reuseTotal }) : null;
      if (reused) {
        track.size = reused.total;
        // 复用的字节来自本机磁盘，单独计数，不参与 CDN 吞吐与节点健康度统计。
        stats.reuseHits += 1;
        stats.reuseBytes += reused.body.length;
        playbackCache?.put(url, start, reused.body, reused.total, { contentType: reused.contentType });
        renderPreheatProgress();
        return { body: reused.body, start, end: start + reused.body.length, total: reused.total, contentType: reused.contentType };
      }
    }
    const pageKey = currentPageKey();
    try {
      // assembleRange 同步登记急需分片后才让规划器运行，后台不会抢先把同一段切成大分片。
      const pending = assembleRange(url, start, end, signal, known);
      queuePump();
      const result = await pending;
      if (signal.aborted || cfg.mode !== "always" || currentPageKey() !== pageKey || tracks.get(track.key) !== track) throw new DOMException("旧媒体请求已取消", "AbortError");
      track.size = result.total;
      renderPreheatProgress();
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
  function wantedRanges(track, position) {
    const lead = Math.max(1, Number(cfg.leadSeconds) || LEAD_SECONDS);
    const index = playbackCache?.index(track.url);
    if (index?.segments?.length) {
      const wanted = [{ start: 0, end: index.segments[0].start, order: 0 }];
      let bytes = 0;
      for (const segment of index.segments) {
        if (segment.timeEnd <= position) continue;
        if (segment.timeStart >= position + lead || bytes >= AHEAD_BYTES_CAP) break;
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
    const bytes = Math.min(AHEAD_BYTES_CAP, rate ? rate * lead : 24 * MB);
    return [{ start: track.anchor, end: Math.min(track.size, track.anchor + bytes), order: 1 }];
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
    const position = Number(currentVideo()?.currentTime) || 0;
    const plans = prefetchTracks().map(track => ({ track, wanted: wantedRanges(track, position) }));
    const byUrl = new Map(plans.map(plan => [plan.track.url, plan.wanted]));
    network.pruneBackground((url, start, end) => byUrl.get(url)?.some(range => start < range.end && end > range.start));
    let room = BACKGROUND_QUEUE - network.backgroundPending();
    if (room <= 0) return;
    const jobs = [];
    for (const { track, wanted } of plans) {
      if (Date.now() < track.retryAt) continue;
      const busy = playbackCache ? playbackCache.ranges(track.url) : [];
      for (const range of network.inflightRanges(track.url)) addRange(busy, range[0], range[1]);
      for (const range of wanted) {
        for (const [start, end] of missingRanges(busy, range.start, range.end)) jobs.push({ track, start, end, order: range.order });
      }
    }
    jobs.sort((left, right) => left.order - right.order);
    for (const job of jobs) {
      if (room <= 0) break;
      const end = Math.min(job.end, job.start + room * PIECE);
      room -= network.prefetch(job.track.url, job.start, end, { order: job.order, total: job.track.size });
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
      blockedNodes: transfer.blocked,
      networkReceivedMB: +(transfer.receivedBytes / MB).toFixed(2),
      prefetchAheadSec: prefetchAhead(),
      coldTracks: [...tracks.values()].filter((track) => track.cold).length,
      cacheHits: (cache.hits || 0) + (cache.partialHits || 0),
      cacheHitMB: +(((cache.hitBytes || 0) + (cache.partialHitBytes || 0)) / MB).toFixed(2),
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
    const range = normalizedPrefetchedRanges().find(([start, end]) => start <= now + .001 && end > now);
    return range ? +((range[1] - now) * video.duration).toFixed(1) : 0;
  }

  // ---- 进度条着色 -------------------------------------------------------------------

  // 进度条按帧刷新；驻留、轨道和时长都没变时直接复用上次的音视频交集。
  let timelineMemo = { key: "", ranges: [] };
  function normalizedPrefetchedRanges() {
    const revision = playbackCache?.revision?.();
    const duration = Number(currentVideo()?.duration);
    const key = `${revision}|${playerSequence}|${tracks.size}|${duration}`;
    if (revision !== undefined && key === timelineMemo.key) return timelineMemo.ranges;
    const eligible = [...tracks.values()].filter(track => track.active !== false);
    const pair = chooseCurrentDashPair(eligible);
    let ranges = [];
    // 新清晰度的初始化尚未解析时，不能继续借旧清晰度画黄色。
    if (pair && !eligible.some(track => !playbackCache?.index(track.url)?.role && track.lastPlayerSeen > Math.min(pair.video.lastPlayerSeen, pair.audio.lastPlayerSeen))) {
      ranges = intersectRanges(normalizedTrackRanges(pair.video), normalizedTrackRanges(pair.audio));
    }
    timelineMemo = { key, ranges };
    return ranges;
  }

  function normalizedTrackRanges(track) {
    const normalized = [];
    const duration = Number(currentVideo()?.duration);
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

  // 只把“用户正在看哪里”交给缓存，内存管理仍由缓存自身负责；
  // 失活轨道显式释放，避免旧清晰度/旧 CDN 地址继续占用保护名额。
  function updateRetentionHints() {
    if (!playbackCache?.retain) return;
    // 渲染在关闭辅助后仍运行，不能重新保护刚被清理的旧轨道。
    if (cfg.mode !== "always") { playbackCache.clearRetention?.(); return; }
    const video = currentVideo();
    const position = Number(video?.currentTime) || 0;
    const duration = Number(video?.duration) || 0;
    const ahead = Math.max(1, Number(cfg.leadSeconds) || LEAD_SECONDS);
    for (const track of tracks.values()) {
      if (track.active === false) playbackCache.release?.(track.url);
      else playbackCache.retain(track.url, { active: true, position, ahead, rewind: RETENTION_REWIND_SECONDS, duration, protectInit: true });
    }
  }

  function renderPreheatProgress() {
    updateRetentionHints();
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

  // ---- 生命周期 ---------------------------------------------------------------------

  function clearSession() {
    network.reset();
    playbackCache?.clear();
    timelineMemo = { key: "", ranges: [] };
  }

  function resetTracksAfterNavigation() {
    const nextPageKey = currentPageKey();
    if (nextPageKey === lastPageKey) return false;
    lastPageKey = nextPageKey;
    clearSession();
    tracks.clear();
    initialPlayinfo = window.__playinfo__; // SPA 导航后不重新注册旧页面留下的清单。
    renderPreheatProgress();
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "ext->page") return;
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
    normalizedTrackRanges,
    chooseCurrentDashPair,
    intersectRanges,
    updateRetentionHints,
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
    loadRange: loadPlayerRange,
    enabled: () => { resetTracksAfterNavigation(); return cfg.mode === "always"; },
    onChange: () => { renderPreheatProgress(); queuePump(); },
    onHit: (url, hit) => {
      // 本地命中不是 CDN 吞吐样本，不能污染播放器的网络能力估计。
      const track = trackFor(url);
      if (track) primeTrackFromHeaders(track, { start: hit.start }, `bytes ${hit.start}-${hit.end - 1}/${hit.total}`, 206);
      queuePump();
    }
  });
  scanVideos();
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
    updateRetentionHints();
    planPrefetch();
  }, 500);
  setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, track] of tracks) {
      if (track.lastSeen < cutoff && !network.inflightRanges(track.url).length) { playbackCache?.release?.(track.url); tracks.delete(key); }
    }
  }, 30000);
})();
