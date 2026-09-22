(() => {
  "use strict";
  if (window.__biliBufferCache) return;
  /** @typedef {{body: Uint8Array, start: number, end: number, total: number, contentType: string}} CacheHit */
  /** @typedef {{start: number, end: number, timeStart: number, timeEnd: number}} MediaSegment */
  /** @typedef {{segments: MediaSegment[], initEnd: number, role: 'video'|'audio'|null}} SegmentIndex */
  const resources = new Map();
  const stats = { bytes: 0, hits: 0, hitBytes: 0, misses: 0, evictions: 0, partialHits: 0, partialHitBytes: 0 };
  let limit = 128 * 1024 * 1024, sequence = 0, installed = false, epoch = 0;
  const INDEX_LIMIT = 1024 * 1024;
  // 单次请求最多重组 16 MiB。规划期会复制驻留快照、下载期会持有缺口正文、交付期还有一份输出，
  // 三者之和约为该上限的两倍，避免开放结尾请求把整部视频留在页面内存里。
  const MAX_REASSEMBLY = 16 * 1024 * 1024;
  // 缺口过多说明驻留极其碎片化，补齐的收益低于排一长串子请求；宁可整条交还原请求。
  const MAX_GAPS = 32;
  const partialControllers = new Set();
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
      stats.bytes -= victim.block.bytes.length;
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
  /** 在 [start,end) 内把“已驻留字节”与“缺口”拆开；驻留部分立即复制快照。
   * 快照必须同步完成：缺口下载是异步的，期间可能发生容量回收或条目替换，
   * 若只持有 subarray 视图，后续交付的字节就不再可控。
   * @param {{blocks: {start: number, bytes: Uint8Array}[]}} entry @param {number} start @param {number} end
   * @returns {{parts: {start: number, bytes: Uint8Array}[], gaps: number[][]}}
   */
  function coverage(entry, start, end) {
    const blocks = [...entry.blocks].sort((left, right) => left.start - right.start);
    const parts = [], gaps = [];
    let cursor = start;
    for (const block of blocks) {
      const right = block.start + block.bytes.length;
      if (right <= cursor) continue;
      // 块按起点排序：第一个起点大于 cursor 的块之前，不可能再被后面的块覆盖。
      if (block.start > cursor) {
        const gapEnd = Math.min(block.start, end);
        if (gapEnd > cursor) gaps.push([cursor, gapEnd]);
        cursor = gapEnd;
        if (cursor >= end) break;
      }
      const stop = Math.min(right, end);
      if (stop > cursor) {
        parts.push({ start: cursor, bytes: block.bytes.slice(cursor - block.start, stop - block.start) });
        cursor = stop;
      }
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push([cursor, end]);
    return { parts, gaps };
  }
  /** 部分命中规划：完整命中、越界、超过重组上限或缺口过多时返回 null（走原路径）。
   * @param {string} url @param {string} range @returns {object|null}
   */
  function partialPlan(url, range) {
    const entry = resources.get(url), parsed = /^bytes=(\d+)-(\d*)$/i.exec(String(range || "").trim());
    if (!entry || !parsed) return null;
    const start = Number(parsed[1]), end = parsed[2] ? Number(parsed[2]) + 1 : entry.total;
    if (!safe(start) || !safe(end) || end <= start || end > entry.total || end - start > MAX_REASSEMBLY) return null;
    const { parts, gaps } = coverage(entry, start, end);
    // parts 为空说明请求范围内没有任何可复用字节，交回旧路径而非伪装成部分命中。
    if (!parts.length || !gaps.length || gaps.length > MAX_GAPS) return null;
    return { url, start, end, total: entry.total, contentType: entry.contentType, length: end - start, parts, gaps };
  }
  /** 校验每个缺口结果后拼接；任何边界、长度或总长不一致都返回 null，绝不交付半成品。
   * @param {object} plan @param {object[]} results @returns {CacheHit & {reused: number}|null}
   */
  function assemble(plan, results) {
    if (!Array.isArray(results) || results.length !== plan.gaps.length) return null;
    const current = resources.get(plan.url);
    if (current && current.total !== plan.total) return null;
    const body = new Uint8Array(plan.length);
    let contentType = plan.contentType, reused = 0;
    for (const part of plan.parts) { body.set(part.bytes, part.start - plan.start); reused += part.bytes.length; }
    for (let index = 0; index < plan.gaps.length; index += 1) {
      const [gapStart, gapEnd] = plan.gaps[index], result = results[index];
      const bytes = result?.body ? (result.body instanceof Uint8Array ? result.body : new Uint8Array(result.body)) : null;
      if (!bytes || result.start !== gapStart || bytes.length !== gapEnd - gapStart) return null;
      if (!Number.isSafeInteger(result.total) || result.total !== plan.total) return null;
      body.set(bytes, gapStart - plan.start);
      if (result.contentType) contentType = result.contentType;
    }
    return { body, start: plan.start, end: plan.end, total: plan.total, contentType, reused };
  }
  /** 失败时取消其余缺口，避免已经原生回退后后台仍下载同一范围。
   * @param {object} plan @param {Function} loadRange @param {AbortSignal} signal @returns {Promise<object|null>}
   */
  async function fillPlan(plan, loadRange, signal) {
    const controller=new AbortController(), cancel=()=>controller.abort(signal.reason);
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    partialControllers.add(controller);
    let abort;
    const cancelled=new Promise((_,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();});
    try {
      const requests=plan.gaps.map(async ([from,to])=>{
        if(controller.signal.aborted)throw controller.signal.reason;
        const value=await loadRange(plan.url,`bytes=${from}-${to-1}`,controller.signal,{start:plan.start,end:plan.end});
        if(!value || value.start!==from || value.end!==to || value.total!==plan.total || (value.body?.byteLength??-1)!==to-from)throw Error('缓存缺口结果不一致');
        return value;
      });
      const results=await Promise.race([Promise.all(requests),cancelled]);
      return assemble(plan,results);
    } finally {
      controller.signal.removeEventListener('abort',abort);controller.abort();
      signal.removeEventListener('abort',cancel);partialControllers.delete(controller);
    }
  }

  // 规划本身出错时退回“无部分命中”的原有整段路径，不影响播放器请求。
  const safePartial = (url, range) => { try { return partialPlan(url, range); } catch { return null; } };
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
   * @param {{enabled?: () => boolean, onHit?: (url: string, hit: CacheHit) => void, onChange?: () => void, loadRange?: Function}} options
   * @returns {void}
   */
  function install({ enabled = () => true, onHit = () => {}, onChange = () => {}, loadRange = null } = {}) {
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
        const rangeHeader = request.headers.get("range");
        if (loadRange && /^bytes=\d+-\d*$/i.test(rangeHeader || "")) {
          const requestEpoch = epoch;
          // 规划必须同步完成：驻留字节在此刻复制成快照，缺口下载期间的回收不会改动待交付内容。
          const plan = safePartial(request.url, rangeHeader);
          return Promise.resolve().then(() => {
            if (request.signal.aborted || requestEpoch !== epoch) throw request.signal.reason || new DOMException("页面已切换", "AbortError");
            if (!plan) return loadRange(request.url, rangeHeader, request.signal);
            // 只对缺口发起下载；各缺口仍走 loadPlayerRange 的同一去重与取消语义。
            return fillPlan(plan, loadRange, request.signal);
          }).then(hit => {
            if (request.signal.aborted) throw request.signal.reason || new DOMException("已取消", "AbortError");
            if (requestEpoch !== epoch) throw new DOMException("页面已切换", "AbortError");
            if (!hit || !enabled()) return nativeFetch.call(window, input, init);
            // 部分命中的驻留字节来自本地缓存；缺口仍属网络下载，分开计数以免污染命中统计。
            if (plan && hit.reused !== undefined) { stats.partialHits++; stats.partialHitBytes += hit.reused; }
            // 加速返回属于网络下载，不计作缓存命中；保留 fetch 正文消费前取消语义。
            let cleanup = () => {};
            const body = new ReadableStream({
              start(controller) {
                const abort = () => { controller.error(request.signal.reason); cleanup(); };
                cleanup = () => request.signal.removeEventListener("abort", abort);
                request.signal.addEventListener("abort", abort, {once:true});
              },
              pull(controller) { controller.enqueue(hit.body); controller.close(); cleanup(); }, cancel() { cleanup(); }
            }, {highWaterMark:0});
            const response = new Response(body, {status:206, statusText:"Partial Content", headers:headersFor(hit)});
            Object.defineProperties(response, {url:{value:request.url}, type:{value:"cors"}});
            return response;
          }).catch(error => {
            if (request.signal.aborted || requestEpoch !== epoch) throw request.signal.reason || new DOMException("页面已切换", "AbortError");
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
        // 与 fetch 同策略：同步快照驻留字节，只把缺口交给 loadRange。
        const plan = canLoad ? safePartial(req.url, rangeHeader) : null;
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
          else if (plan && result.reused !== undefined) { stats.partialHits++; stats.partialHitBytes += result.reused; }
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
          if (!plan) return loadRange(req.url, rangeHeader, signal);
          return fillPlan(plan, loadRange, signal);
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
    /** 单次部分命中允许重组的最大字节数；超过则交还整段原请求。 */
    maxReassembly: MAX_REASSEMBLY,
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
    /** @returns {void} 导航时取消缺口、清理旧正文与保留提示。 */
    clear() { epoch++; for(const controller of partialControllers)controller.abort(new DOMException("缓存已清理", "AbortError")); resources.clear(); retention.clear(); stats.bytes = 0; }
  };
})();
