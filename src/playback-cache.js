(() => {
  "use strict";
  if (window.__biliBufferCache) return;
  /** @typedef {{body: Uint8Array, start: number, end: number, total: number, contentType: string}} CacheHit */
  /** @typedef {{start: number, end: number, timeStart: number, timeEnd: number}} MediaSegment */
  /** @typedef {{segments: MediaSegment[], initEnd: number, role: 'video'|'audio'|null}} SegmentIndex */
  const resources = new Map();
  const stats = { bytes: 0, hits: 0, hitBytes: 0, misses: 0, evictions: 0, partialHits: 0, partialHitBytes: 0 };
  // revision 在任何驻留变化时递增，观察器据此跳过未变化时的时间轴重算。
  let limit = 128 * 1024 * 1024, sequence = 0, installed = false, epoch = 0, revision = 0;
  const INDEX_LIMIT = 1024 * 1024;
  const mediaUrl = (url) => {
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) && /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com|akamaized\.net)$/.test(u.hostname); }
    catch { return false; }
  };
  const safe = (value) => Number.isSafeInteger(value) && value >= 0;
  // 播放位置感知的保留提示由观察器刷新；缓存只按提示决定回收顺序，不自行猜测用户在看的区间。
  const retention = new Map();
  const DEFAULT_AHEAD_SECONDS = 45;
  const DEFAULT_REWIND_SECONDS = 5;
  const RETENTION_LIMIT = 64;
  function discard(url) {
    const entry = resources.get(url);
    if (entry) stats.bytes -= entry.blocks.reduce((sum, block) => sum + block.bytes.length, 0);
    resources.delete(url);
    retention.delete(url);
    revision++;
  }
  const seconds = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
  // 合并相邻/重叠保护区间；一次回收涉及的区间数量很小，保持稳定排序。
  function addSpan(list, start, end) {
    if (!(end > start)) return;
    list.push([start, end]);
    list.sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const span of list) {
      const previous = merged.at(-1);
      if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
      else merged.push(span.slice());
    }
    list.splice(0, list.length, ...merged);
  }
  // 把「当前播放位置 ± 窗口」映射成字节保护区间：优先真实 SIDX 分段；无索引时按总大小/时长比例回退。
  // 初始化/索引区在活动轨道上始终受保护，因为它是后续解析与播放的入口。
  function protectSpans(entry, hint) {
    const spans = [];
    const initEnd = entry.index?.segments?.length ? entry.index.segments[0].start : Math.min(entry.total, INDEX_LIMIT);
    if (hint.protectInit !== false && initEnd > 0) addSpan(spans, 0, initEnd);
    const position = seconds(hint.position, 0);
    const ahead = seconds(hint.ahead, DEFAULT_AHEAD_SECONDS);
    const rewind = seconds(hint.rewind, DEFAULT_REWIND_SECONDS);
    const from = Math.max(0, position - rewind), to = position + ahead;
    if (entry.index?.segments?.length) {
      for (const segment of entry.index.segments) {
        if (segment.timeEnd > from && segment.timeStart < to) addSpan(spans, segment.start, segment.end);
      }
    } else {
      const duration = seconds(hint.duration, 0);
      if (duration > 0 && entry.total > 0) {
        const perSecond = entry.total / duration;
        addSpan(spans, Math.floor(from * perSecond), Math.min(entry.total, Math.ceil(to * perSecond)));
      }
    }
    return spans;
  }
  // 块到最近保护区的字节距离；0 表示位于保护区内。
  function spanDistance(block, spans) {
    const start = block.start, end = start + block.bytes.length;
    let distance = Infinity;
    for (const [left, right] of spans) {
      if (end <= left) distance = Math.min(distance, left - end);
      else if (start >= right) distance = Math.min(distance, start - right);
      else return 0;
    }
    return distance;
  }
  // 回收顺序：非活动资源 → 活动但远离窗口 → 保护中的初始化/邻近窗口；同级先远后近、再按插入顺序。
  function evictsBefore(left, right) {
    if (left.tier !== right.tier) return left.tier < right.tier;
    if (left.distance !== right.distance) return left.distance > right.distance;
    return left.order < right.order;
  }
  // 资源条目上限同样优先清理非活动资源；全部活动时退回最早插入条目，避免旧清晰度挤掉当前播放。
  function staleResource() {
    let victim = null;
    for (const entry of resources.values()) {
      const hint = retention.get(entry.url);
      const score = hint && hint.active !== false ? 1 : 0;
      if (!victim || score < victim.score) victim = { entry, score };
    }
    return victim?.entry || null;
  }
  function trim() {
    if (stats.bytes <= limit) return;
    const plans = new Map();
    for (const entry of resources.values()) {
      const hint = retention.get(entry.url);
      const active = Boolean(hint) && hint.active !== false;
      plans.set(entry, { active, spans: active ? protectSpans(entry, hint) : [] });
    }
    while (stats.bytes > limit) {
      let victim = null;
      for (const entry of resources.values()) {
        const plan = plans.get(entry);
        for (const block of entry.blocks) {
          const end = block.start + block.bytes.length;
          // 必须真正与保护区重叠才算受保护；紧贴边界不算，否则相邻块会被误判为窗口内数据。
          const inSpan = plan.spans.some(([left, right]) => block.start < right && end > left);
          const distance = inSpan ? 0 : plan.spans.length ? spanDistance(block, plan.spans) : Infinity;
          const key = { tier: inSpan ? 2 : plan.active ? 1 : 0, distance, order: block.order };
          if (!victim || evictsBefore(key, victim.key)) victim = { block, entry, key };
        }
      }
      // 整池都处于保护区时仍继续回收：保护只调整顺序，不能突破内存硬上限。
      if (!victim) break;
      victim.entry.blocks.splice(victim.entry.blocks.indexOf(victim.block), 1);
      victim.entry.times = null;
      stats.bytes -= victim.block.bytes.length;
      stats.evictions++;
      revision++;
    }
  }
  function pieces(entry, start, end, prefetchedOnly = false) {
    const result = [];
    let cursor = start;
    // entry.blocks 始终按起点有序（见 put），这里无需再排序。
    for (const block of entry.blocks) {
      if (prefetchedOnly && !block.prefetched) continue;
      const right = block.start + block.bytes.length;
      if (right <= cursor) continue;
      if (block.start > cursor) break;
      const stop = Math.min(right, end);
      result.push(block.bytes.subarray(cursor - block.start, stop - block.start));
      cursor = stop;
      if (cursor === end) return result;
    }
    return cursor === end ? result : null;
  }
  function join(parts, length) {
    const output = new Uint8Array(length);
    let cursor = 0;
    for (const part of parts) { output.set(part, cursor); cursor += part.length; }
    return output;
  }
  // ISO BMFF 的 first_offset 相对 sidx 盒尾，不是文件起点；v1 使用 64 位值。
  function parseIndex(bytes, total) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u64 = (p) => view.getUint32(p) * 4294967296 + view.getUint32(p + 4);
    const type = (p) => String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    let index = null, role = null;
    function walk(from, to, depth = 0) {
      if (depth > 5) return;
      for (let p = from; p + 8 <= to;) {
        let size = view.getUint32(p), header = 8;
        if (size === 1) { if (p + 16 > to) return; size = u64(p + 8); header = 16; }
        if (!safe(size) || size < header || p + size > to) return;
        const kind = type(p), base = p + header, end = p + size;
        if (["moov", "trak", "mdia"].includes(kind)) walk(base, end, depth + 1);
        if (kind === "hdlr" && base + 12 <= end) {
          const handler = String.fromCharCode(...bytes.subarray(base + 8, base + 12));
          if (handler === "vide") role = "video";
          else if (handler === "soun" && role !== "video") role = "audio";
        }
        if (kind === "sidx" && base + 24 <= end) {
          const version = bytes[base], scale = view.getUint32(base + 8);
          if (version > 1 || !scale || (version === 1 && base + 32 > end)) return;
          let q = base + 12;
          let time = version ? u64(q) : view.getUint32(q); q += version ? 8 : 4;
          const offset = version ? u64(q) : view.getUint32(q); q += version ? 8 : 4;
          const count = view.getUint16(q + 2); q += 4;
          let cursor = end + offset;
          if (!safe(time) || !safe(cursor) || q + count * 12 > end || !count) return;
          const segments = [];
          for (let i = 0; i < count; i++, q += 12) {
            const reference = view.getUint32(q), duration = view.getUint32(q + 4);
            // 层级索引需要额外下载子索引；尚不支持时宁可不画黄色。
            if (reference >>> 31 || !reference || !duration || cursor + reference > total || !safe(time + duration)) return;
            segments.push({ start: cursor, end: cursor + reference, timeStart: time / scale, timeEnd: (time + duration) / scale });
            cursor += reference; time += duration;
          }
          index = { segments, initEnd: end, role: null };
        }
        p = end;
      }
    }
    try { walk(0, bytes.length); } catch { return null; }
    if (index) index.role = role;
    return index;
  }
  /** 保存已校验的单资源字节；URL（含查询串）严格隔离，容量不足时回收最早的数据。
   * @param {string} url @param {number} start @param {Uint8Array} bytes @param {number} total
   * @param {{prefetched?: boolean, contentType?: string}} options @returns {boolean}
   */
  function put(url, start, bytes, total, { prefetched = true, contentType = "application/octet-stream" } = {}) {
    if (!mediaUrl(url) || !safe(start) || !safe(total) || !bytes?.byteLength || start + bytes.byteLength > total) return false;
    if (bytes.byteLength > limit) return false;
    let entry = resources.get(url);
    if (entry && entry.total !== total) { discard(url); entry = null; }
    if (!entry) {
      while (resources.size >= 32) {
        const stale = staleResource();
        if (!stale) break;
        discard(stale.url);
      }
      entry = { url, total, blocks: [], index: null, contentType };
      resources.set(url, entry);
    }
    if (!pieces(entry, start, start + bytes.byteLength, prefetched)) {
      // 先把借来的候选加入回收决策，再复制真正留下的块；避免复制后才腾空间的驻留峰值。
      const block = { start, bytes, prefetched, order: ++sequence };
      const at = entry.blocks.findIndex(other => other.start > start);
      entry.blocks.splice(at < 0 ? entry.blocks.length : at, 0, block);
      stats.bytes += bytes.byteLength; entry.times = null; revision++;
      trim();
      if (!entry.blocks.includes(block)) return false;
      const copy = new Uint8Array(bytes.byteLength); copy.set(bytes); block.bytes = copy;
    }
    if (!entry.index) {
      let end = 0;
      for (const block of entry.blocks) {
        if (block.start > end) break;
        end = Math.min(INDEX_LIMIT, Math.max(end, block.start + block.bytes.length));
      }
      if (end) entry.index = parseIndex(join(pieces(entry, 0, end), end), total);
      if (entry.index) { entry.times = null; revision++; }
    }
    trim();
    return Boolean(pieces(entry, start, start + bytes.byteLength));
  }
  /** 完整命中才返回 206 数据；不支持的 Range 原样交还浏览器。
   * @param {string} url @param {string} range @returns {CacheHit|null}
   */
  function match(url, range) {
    const entry = resources.get(url), parsed = /^bytes=(\d+)-(\d*)$/i.exec(String(range || "").trim());
    if (!entry || !parsed) return null;
    const start = Number(parsed[1]), end = parsed[2] ? Number(parsed[2]) + 1 : entry.total;
    if (!safe(start) || !safe(end) || end <= start || end > entry.total) return null;
    const parts = pieces(entry, start, end);
    if (!parts) return null;
    return { body: join(parts, end - start), start, end, total: entry.total, contentType: entry.contentType };
  }
  /** 返回真实秒数；只承诺初始化数据和完整预热媒体段同时驻留的区域。
   * @param {string} url @returns {number[][]}
   */
  function timeRanges(url) {
    const entry = resources.get(url);
    if (!entry?.index || !pieces(entry, 0, entry.index.segments[0].start)) return [];
    // 进度条每帧都会读取；只在该资源驻留变化后重算一次。
    if (entry.times) return entry.times;
    const result = [];
    for (const segment of entry.index.segments) {
      if (!pieces(entry, segment.start, segment.end, true)) continue;
      const previous = result.at(-1);
      if (previous && previous[1] === segment.timeStart) previous[1] = segment.timeEnd;
      else result.push([segment.timeStart, segment.timeEnd]);
    }
    return (entry.times = result);
  }
  // 分配失败或缓存条目异常时回退原请求，不能把优化失败变成播放失败。
  function safeMatch(url, range) { try { return match(url, range); } catch { return null; } }
  const headersFor = (hit) => new Headers({
    "Content-Type": hit.contentType, "Content-Length": String(hit.end - hit.start),
    "Content-Range": `bytes ${hit.start}-${hit.end - 1}/${hit.total}`, "Accept-Ranges": "bytes"
  });
  /** 安装 MAIN world 请求适配器；不跨 SW 消息通道传输媒体，也不依赖 SW 保活。
   * @param {{enabled?: () => boolean, onHit?: (url: string, hit: CacheHit) => void, onChange?: () => void, loadRange?: Function}} options
   * @returns {void}
   */
  function install({ enabled = () => true, onHit = () => {}, onChange = () => {}, loadRange = null } = {}) {
    if (installed) return; installed = true;
    const hitRecorded = (url, hit) => { stats.hits++; stats.hitBytes += hit.body.length; onHit(url, hit); };
    // 加速返回属于网络下载，不计作完整命中；其中复用的驻留字节（reused）单独计为部分命中。
    const partialRecorded = (hit) => { if (hit.reused > 0) { stats.partialHits++; stats.partialHitBytes += hit.reused; } };
    // 不预先把 Response 正文标为消费完毕：拿到响应后、读取正文前的 abort 仍须生效。
    const respond = (request, hit) => {
      let cleanup = () => {};
      const body = new ReadableStream({
        start(controller) {
          const abort = () => { controller.error(request.signal.reason || new DOMException("Aborted", "AbortError")); cleanup(); };
          cleanup = () => request.signal.removeEventListener("abort", abort);
          request.signal.addEventListener("abort", abort, { once: true });
        },
        pull(controller) { controller.enqueue(hit.body); controller.close(); cleanup(); },
        cancel() { cleanup(); }
      }, { highWaterMark: 0 });
      const response = new Response(body, { status: 206, statusText: "Partial Content", headers: headersFor(hit) });
      Object.defineProperties(response, { url: { value: request.url }, type: { value: "cors" } });
      return response;
    };
    const inspect = (url, header, body, contentType, requestEpoch) => {
      if (!enabled() || epoch !== requestEpoch) return;
      const parsed = /^bytes 0-(\d+)\/(\d+)$/.exec(header || "");
      if (parsed && body.byteLength === Number(parsed[1]) + 1 && body.byteLength <= INDEX_LIMIT) {
        put(url, 0, new Uint8Array(body), Number(parsed[2]), { prefetched: false, contentType }); onChange();
      }
    };
    const nativeFetch = window.fetch;
    if (nativeFetch) window.fetch = function (input, init) {
      let request;
      try { request = new Request(input, init); } catch { return nativeFetch.apply(this, arguments); }
      const eligible = enabled() && request.method === "GET" && mediaUrl(request.url) && request.mode !== "no-cors"
        && !request.headers.has("if-range") && !request.headers.has("authorization");
      if (eligible) {
        if (request.signal.aborted) return Promise.reject(request.signal.reason || new DOMException("Aborted", "AbortError"));
        const lookupEpoch = epoch;
        const hit = safeMatch(request.url, request.headers.get("range"));
        if (hit) {
          return Promise.resolve().then(() => {
            if (request.signal.aborted) throw request.signal.reason || new DOMException("Aborted", "AbortError");
            if (!enabled() || lookupEpoch !== epoch) return nativeFetch.call(window, input, init);
            let response;
            try { response = respond(request, hit); } catch { return nativeFetch.call(window, input, init); }
            hitRecorded(request.url, hit); return response;
          });
        }
        stats.misses++;
        const rangeHeader = request.headers.get("range");
        if (loadRange && /^bytes=\d+-\d*$/i.test(rangeHeader || "")) {
          // loadRange 自己处理「部分驻留 + 在途分片 + 缺口」，失败或返回空时交还原生请求。
          return Promise.resolve().then(() => {
            if (request.signal.aborted || lookupEpoch !== epoch) throw request.signal.reason || new DOMException("页面已切换", "AbortError");
            return loadRange(request.url, rangeHeader, request.signal);
          }).then(hit => {
            if (request.signal.aborted) throw request.signal.reason || new DOMException("已取消", "AbortError");
            if (lookupEpoch !== epoch) throw new DOMException("页面已切换", "AbortError");
            if (!hit || !enabled()) return nativeFetch.call(window, input, init);
            partialRecorded(hit);
            return respond(request, hit);
          }).catch(() => {
            if (request.signal.aborted || lookupEpoch !== epoch) throw request.signal.reason || new DOMException("页面已切换", "AbortError");
            return nativeFetch.call(window, input, init);
          });
        }
      }
      const requestEpoch = epoch;
      const result = nativeFetch.apply(this, arguments);
      // 只复制有长度上限的初始化响应，不能为了观察而 tee 整个开放式大响应。
      if (eligible) result.then((response) => {
        const header = response.headers.get("content-range"), parsed = /^bytes 0-(\d+)\/(\d+)$/.exec(header || "");
        if (response.status === 206 && parsed && Number(parsed[1]) < INDEX_LIMIT) {
          response.clone().arrayBuffer().then((body) => inspect(request.url, header, body, response.headers.get("content-type"), requestEpoch)).catch(() => {});
        }
      }).catch(() => {});
      return result;
    };
    const NativeXhr = window.XMLHttpRequest;
    if (!NativeXhr) return;
    // 原生 EventTarget/属性事件处理器保持不变，仅异步 GET arraybuffer 的完整命中使用本地状态机。
    class CachedXhr extends NativeXhr {
      constructor() {
        super(); this._cacheRequest = null; this._cacheReply = null; this._cacheGeneration = 0; this._cachePending = false;
        this.addEventListener("loadstart", event => {
          if (this._skipNativeLoadstart && event.isTrusted) { this._skipNativeLoadstart = false; event.stopImmediatePropagation(); }
        }, true);
        this.addEventListener("load", () => {
          const req = this._cacheRequest;
          if (!this._cacheReply && req && enabled() && mediaUrl(req.url) && this.status === 206 && this.responseType === "arraybuffer" && this.response) {
            inspect(req.url, this.getResponseHeader("content-range"), this.response, this.getResponseHeader("content-type"), req.epoch);
          }
        });
      }
      open(method, url, async = true, ...rest) {
        this._networkController?.abort(); clearTimeout(this._networkTimer);
        this._cacheGeneration++; this._cachePending = false; this._cacheReply = null;
        this._cacheRequest = { method: String(method).toUpperCase(), url: String(url), async: async !== false, headers: new Headers(), credentials: rest.some(value => value != null) };
        const result = super.open(method, url, async, ...rest);
        this._skipNativeLoadstart = false;
        if (this._requestedTimeout != null) super.timeout = this._requestedTimeout;
        return result;
      }
      setRequestHeader(name, value) {
        if (this._cachePending || this._cacheReply) throw new DOMException("Request already sent", "InvalidStateError");
        const result = super.setRequestHeader(name, value);
        this._cacheRequest?.headers.append(name, value); return result;
      }
      send(body = null) {
        if (this._cachePending || this._cacheReply) throw new DOMException("Request already sent", "InvalidStateError");
        const req = this._cacheRequest;
        const eligible = this.readyState === 1 && req?.async && req.method === "GET" && body == null && !req.credentials && enabled()
          && this.responseType === "arraybuffer" && mediaUrl(req.url) && !req.headers.has("if-range") && !req.headers.has("authorization");
        if (req) req.epoch = epoch;
        const rangeHeader = req?.headers.get("range");
        const hit = eligible ? safeMatch(req.url, rangeHeader) : null;
        if (!hit && eligible) stats.misses++;
        const sentAt = performance.now();
        const canLoad = !hit && eligible && loadRange && /^bytes=\d+-\d*$/i.test(rangeHeader || "");
        if (!hit && !canLoad) return super.send(body);
        const generation = ++this._cacheGeneration;
        this._cachePending = true;
        this._cacheReply = { hit, state: 1, aborted: false };
        const alive = () => this._cacheGeneration === generation;
        const event = (type, loaded = 0, total = 0) => this.dispatchEvent(new ProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
        const deliver = (result, cached) => {
          if (!alive()) return;
          clearTimeout(this._networkTimer);
          if (req.epoch !== epoch) { this.abort(); return; }
          if (!enabled() || !result) {
            this._cacheReply = null; this._cachePending = false;
            if (!cached) { this._skipNativeLoadstart = true; if (this.timeout > 0) super.timeout = Math.max(1, this.timeout - (performance.now() - sentAt)); }
            super.send(body); return;
          }
          this._cacheReply.hit = result;
          if (cached) { event("loadstart"); if (!alive()) return; }
          for (const state of [2, 3]) {
            this._cacheReply.state = state;
            this.dispatchEvent(new Event("readystatechange")); if (!alive()) return;
          }
          event("progress", result.body.length, result.body.length); if (!alive()) return;
          this._cacheReply.state = 4;
          this._cachePending = false;
          this.dispatchEvent(new Event("readystatechange")); if (!alive()) return;
          if (cached) hitRecorded(req.url, result);
          else partialRecorded(result);
          event("load", result.body.length, result.body.length);
          if (alive()) event("loadend", result.body.length, result.body.length);
        };
        if (hit) { setTimeout(() => deliver(hit, true), 0); return; }
        this._networkController = new AbortController();
        const signal = this._networkController.signal;
        // XHR 的 timeout 从 send 开始；不能等多路下载结束后再启动原生计时。
        if (this.timeout > 0) this._networkTimer = setTimeout(() => {
          if (!alive()) return;
          this._networkController.abort(); this._cacheGeneration++; this._cachePending = false;
          this._cacheReply.aborted = true; this._cacheReply.state = 4;
          this.dispatchEvent(new Event("readystatechange"));
          if (this._cacheGeneration !== generation + 1) return;
          event("timeout"); if (this._cacheGeneration === generation + 1) event("loadend");
        }, this.timeout);
        event("loadstart");
        if (!alive()) return;
        Promise.resolve().then(() => {
          if (!alive() || req.epoch !== epoch || signal.aborted) throw new DOMException("已取消", "AbortError");
          return loadRange(req.url, rangeHeader, signal);
        }).then(result => deliver(result, false), () => {
          if (!alive()) return;
          clearTimeout(this._networkTimer);
          if (req.epoch !== epoch || signal.aborted) { this.abort(); return; }
          this._cacheReply = null; this._cachePending = false; this._skipNativeLoadstart = true;
          if (this.timeout > 0) super.timeout = Math.max(1, this.timeout - (performance.now() - sentAt));
          super.send(body);
        });
      }
      abort() {
        this._networkController?.abort(); clearTimeout(this._networkTimer);
        if (!this._cacheReply) return super.abort();
        const pending = this._cachePending;
        this._cacheGeneration++; this._cachePending = false;
        const reply = this._cacheReply;
        reply.aborted = true; reply.state = pending ? 4 : 0;
        if (pending) {
          this.dispatchEvent(new Event("readystatechange"));
          if (this._cacheReply !== reply) return;
          this.dispatchEvent(new ProgressEvent("abort"));
          if (this._cacheReply !== reply) return;
          this.dispatchEvent(new ProgressEvent("loadend"));
        }
        if (this._cacheReply === reply) reply.state = 0;
      }
      get timeout() { return this._requestedTimeout ?? super.timeout; }
      set timeout(value) { super.timeout = value; this._requestedTimeout = super.timeout; }
      get responseType() { return super.responseType; }
      set responseType(value) {
        if (this._cachePending || this._cacheReply?.state >= 3) throw new DOMException("Response already loading", "InvalidStateError");
        super.responseType = value;
      }
      get readyState() { return this._cacheReply?.state ?? super.readyState; }
      get status() { const r = this._cacheReply; return r ? (!r.aborted && r.state >= 2 ? 206 : 0) : super.status; }
      get statusText() { return this._cacheReply ? (this.status ? "Partial Content" : "") : super.statusText; }
      get responseURL() { return this._cacheReply ? (this.status ? this._cacheRequest.url : "") : super.responseURL; }
      get response() { const r = this._cacheReply; return r ? (r.state === 4 && !r.aborted ? r.hit.body.buffer : null) : super.response; }
      getResponseHeader(name) { return this._cacheReply ? (this.status ? headersFor(this._cacheReply.hit).get(name) : null) : super.getResponseHeader(name); }
      getAllResponseHeaders() { return this._cacheReply ? (this.status ? [...headersFor(this._cacheReply.hit)].map(([key, value]) => `${key}: ${value}\r\n`).join("") : "") : super.getAllResponseHeaders(); }
    }
    window.XMLHttpRequest = CachedXhr;
  }
  window.__biliBufferCache = {
    put, match, timeRanges, install, stats,
    /** @returns {number} 驻留修订号：任何写入、回收、索引解析或清空都会递增。 */
    revision: () => revision,
    /** @param {string} url @returns {number[][]} 驻留字节区间（半开区间），用于调度缺口。 */
    ranges(url) {
      const result = [];
      for (const block of resources.get(url)?.blocks || []) {
        const end = block.start + block.bytes.length, previous = result.at(-1);
        if (previous && block.start <= previous[1]) previous[1] = Math.max(previous[1], end);
        else result.push([block.start, end]);
      }
      return result;
    },
    /** @param {string} url @returns {SegmentIndex|null} 已验证的分段索引。 */
    index: (url) => resources.get(url)?.index || null,
    /** 刷新某资源的播放保留提示；观察器按当前播放位置调用，轨道失活应改用 release。
     * @param {string} url @param {{active?: boolean, position?: number, ahead?: number, rewind?: number, duration?: number, protectInit?: boolean}} hint
     * @returns {void}
     */
    retain(url, hint = {}) {
      // 提示按 URL 隔离，长时间会话也不能让失活地址无限堆积。
      if (retention.size >= RETENTION_LIMIT && !retention.has(url)) retention.delete(retention.keys().next().value);
      retention.set(url, {
        active: hint.active !== false,
        position: seconds(hint.position, 0),
        ahead: seconds(hint.ahead, DEFAULT_AHEAD_SECONDS),
        rewind: seconds(hint.rewind, DEFAULT_REWIND_SECONDS),
        duration: seconds(hint.duration, 0),
        protectInit: hint.protectInit !== false
      });
    },
    /** 取消单个资源的保留提示（轨道失活/取消）。 @param {string} url @returns {void} */
    release(url) { retention.delete(url); },
    /** 清空全部保留提示（导航或关闭辅助）。 @returns {void} */
    clearRetention() { retention.clear(); },
    /** @param {number} bytes @returns {void} 设置全页缓存上限。 */
    setLimit(bytes) { if (safe(bytes)) { limit = bytes; trim(); } },
    /** @returns {void} 导航或关闭时清理旧正文与保留提示；epoch 递增挡住迟到的旧请求。 */
    clear() { epoch++; revision++; resources.clear(); retention.clear(); stats.bytes = 0; }
  };
})();
