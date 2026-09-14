(() => {
  "use strict";
  if (window.__biliBufferCache) return;
  /** @typedef {{body: Uint8Array, start: number, end: number, total: number, contentType: string}} CacheHit */
  /** @typedef {{start: number, end: number, timeStart: number, timeEnd: number}} MediaSegment */
  /** @typedef {{segments: MediaSegment[], initEnd: number, role: 'video'|'audio'|null}} SegmentIndex */
  const resources = new Map();
  const stats = { bytes: 0, hits: 0, hitBytes: 0, misses: 0, evictions: 0 };
  let limit = 128 * 1024 * 1024, sequence = 0, installed = false, epoch = 0;
  const INDEX_LIMIT = 1024 * 1024;
  const mediaUrl = (url) => {
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) && /(^|\.)(bilivideo\.com|bilivideo\.cn|akamaized\.net)$/.test(u.hostname); }
    catch { return false; }
  };
  const safe = (value) => Number.isSafeInteger(value) && value >= 0;
  function discard(url) {
    const entry = resources.get(url);
    if (entry) stats.bytes -= entry.blocks.reduce((sum, block) => sum + block.bytes.length, 0);
    resources.delete(url);
  }
  function trim() {
    while (stats.bytes > limit) {
      let oldest = null, owner = null;
      for (const entry of resources.values()) for (const block of entry.blocks) {
        if (!oldest || block.order < oldest.order) { oldest = block; owner = entry; }
      }
      if (!oldest) break;
      owner.blocks.splice(owner.blocks.indexOf(oldest), 1);
      stats.bytes -= oldest.bytes.length;
      stats.evictions++;
    }
  }
  function pieces(entry, start, end, prefetchedOnly = false) {
    const result = [];
    let cursor = start;
    for (const block of [...entry.blocks].sort((a, b) => a.start - b.start)) {
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
      while (resources.size >= 32) discard(resources.keys().next().value);
      entry = { total, blocks: [], index: null, contentType };
      resources.set(url, entry);
    }
    if (!pieces(entry, start, start + bytes.byteLength, prefetched)) {
      const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
      entry.blocks.push({ start, bytes: copy, prefetched, order: ++sequence });
      stats.bytes += copy.length;
    }
    if (!entry.index) {
      let end = 0;
      for (const block of [...entry.blocks].sort((a, b) => a.start - b.start)) {
        if (block.start > end) break;
        end = Math.min(INDEX_LIMIT, Math.max(end, block.start + block.bytes.length));
      }
      if (end) entry.index = parseIndex(join(pieces(entry, 0, end), end), total);
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
    const entry = resources.get(url), result = [];
    if (!entry?.index || !pieces(entry, 0, entry.index.segments[0].start)) return result;
    for (const segment of entry.index.segments) {
      if (!pieces(entry, segment.start, segment.end, true)) continue;
      const previous = result.at(-1);
      if (previous && previous[1] === segment.timeStart) previous[1] = segment.timeEnd;
      else result.push([segment.timeStart, segment.timeEnd]);
    }
    return result;
  }
  // 分配失败或缓存条目异常时回退原请求，不能把优化失败变成播放失败。
  function safeMatch(url, range) { try { return match(url, range); } catch { return null; } }
  const headersFor = (hit) => new Headers({
    "Content-Type": hit.contentType, "Content-Length": String(hit.end - hit.start),
    "Content-Range": `bytes ${hit.start}-${hit.end - 1}/${hit.total}`, "Accept-Ranges": "bytes"
  });
  /** 安装 MAIN world 请求适配器；不跨 SW 消息通道传输媒体，也不依赖 SW 保活。
   * @param {{enabled?: () => boolean, onHit?: (url: string, hit: CacheHit) => void, onChange?: () => void}} options
   * @returns {void}
   */
  function install({ enabled = () => true, onHit = () => {}, onChange = () => {} } = {}) {
    if (installed) return; installed = true;
    const hitRecorded = (url, hit) => { stats.hits++; stats.hitBytes += hit.body.length; onHit(url, hit); };
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
            let response, cleanup = () => {};
            try {
              // 不预先把 Response 正文标为消费完毕：拿到响应后、读取正文前的 abort 仍须生效。
              const body = new ReadableStream({
                start(controller) {
                  const abort = () => { controller.error(request.signal.reason || new DOMException("Aborted", "AbortError")); cleanup(); };
                  cleanup = () => request.signal.removeEventListener("abort", abort);
                  request.signal.addEventListener("abort", abort, { once: true });
                },
                pull(controller) { controller.enqueue(hit.body); controller.close(); cleanup(); },
                cancel() { cleanup(); }
              }, { highWaterMark: 0 });
              response = new Response(body, { status: 206, statusText: "Partial Content", headers: headersFor(hit) });
              Object.defineProperties(response, { url: { value: request.url }, type: { value: "cors" } });
            } catch { cleanup(); return nativeFetch.call(window, input, init); }
            hitRecorded(request.url, hit); return response;
          });
        }
        stats.misses++;
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
        this.addEventListener("load", () => {
          const req = this._cacheRequest;
          if (!this._cacheReply && req && enabled() && mediaUrl(req.url) && this.status === 206 && this.responseType === "arraybuffer" && this.response) {
            inspect(req.url, this.getResponseHeader("content-range"), this.response, this.getResponseHeader("content-type"), req.epoch);
          }
        });
      }
      open(method, url, async = true, ...rest) {
        this._cacheGeneration++; this._cachePending = false; this._cacheReply = null;
        this._cacheRequest = { method: String(method).toUpperCase(), url: String(url), async: async !== false, headers: new Headers(), credentials: rest.some(value => value != null) };
        return super.open(method, url, async, ...rest);
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
        const hit = eligible ? safeMatch(req.url, req.headers.get("range")) : null;
        if (!hit) { if (eligible) stats.misses++; return super.send(body); }
        const generation = ++this._cacheGeneration;
        this._cachePending = true;
        this._cacheReply = { hit, state: 1, aborted: false };
        const alive = () => this._cacheGeneration === generation;
        const event = (type, loaded = 0) => this.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total: hit.body.length }));
        setTimeout(() => {
          if (!alive()) return;
          if (!enabled() || req.epoch !== epoch) { this._cacheReply = null; this._cachePending = false; super.send(body); return; }
          event("loadstart"); if (!alive()) return;
          for (const state of [2, 3]) {
            this._cacheReply.state = state;
            this.dispatchEvent(new Event("readystatechange")); if (!alive()) return;
          }
          event("progress", hit.body.length); if (!alive()) return;
          this._cacheReply.state = 4;
          this._cachePending = false;
          this.dispatchEvent(new Event("readystatechange")); if (!alive()) return;
          this._cachePending = false;
          hitRecorded(req.url, hit);
          event("load", hit.body.length);
          if (this._cacheGeneration === generation) event("loadend", hit.body.length);
        }, 0);
      }
      abort() {
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
      get responseType() { return super.responseType; }
      set responseType(value) {
        if (this._cacheReply?.state >= 3) throw new DOMException("Response already loading", "InvalidStateError");
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
    /** @param {string} url @returns {number[][]} 驻留字节区间（半开区间），用于调度缺口。 */
    ranges(url) {
      const result = [];
      for (const block of [...(resources.get(url)?.blocks || [])].sort((a, b) => a.start - b.start)) {
        const end = block.start + block.bytes.length, previous = result.at(-1);
        if (previous && block.start <= previous[1]) previous[1] = Math.max(previous[1], end);
        else result.push([block.start, end]);
      }
      return result;
    },
    /** @param {string} url @returns {SegmentIndex|null} 已验证的分段索引。 */
    index: (url) => resources.get(url)?.index || null,
    /** @param {number} bytes @returns {void} 设置全页缓存上限。 */
    setLimit(bytes) { if (safe(bytes)) { limit = bytes; trim(); } },
    /** @returns {void} 导航时清理，避免旧视频数据占用内存。 */
    clear() { epoch++; resources.clear(); stats.bytes = 0; }
  };
})();
