(() => {
  'use strict';
  // 在线播放的分片下载引擎（MAIN world）。
  //
  // 一个「分片」= 一次真实的 HTTP Range 请求，正文按 Content-Range 与长度完整校验后才交付。
  // 播放器的急需范围与后台预热共用同一张在途分片表：同一 URL 的在途分片互不重叠，
  // 急需请求碰到已在途的后台分片就直接等待并复用它，而不是取消后重下。
  //
  // 并发只在页面内用信号量约束，不再向 Service Worker 申请跨标签租约：
  // 租约要求每个分片都经 页面→隔离桥→SW→storage.session 串行往返两次，
  // 海外高延迟下协调链路本身就成了瓶颈；SW 休眠时 2 秒超时还会被误记成 CDN 节点故障。
  const MiB = 1024 * 1024;
  const MAX_RANGE = 16 * MiB;
  // 后台预热分片：海外节点首字节常在 0.5–2 秒，分片太小会让首字节开销占满时间；
  // 太大则单个慢分片拖住整段前方窗口。512 KiB 在两者之间取平衡。
  const BACKGROUND_PIECE = 512 * 1024;
  // 急需范围拆成约 16 片并行以缩短播放器等待，单片不小于 64 KiB、不大于后台分片。
  const URGENT_SPLIT = 16, MIN_PIECE = 64 * 1024;
  const HOSTS = /(^|\.)(bilivideo\.(com|cn)|hdslb\.com|akamaized\.net)$/i;
  const abortError = (message = '播放请求已取消') => new DOMException(message, 'AbortError');

  /** @param {string} value @returns {string|null} 仅接受现有 host 权限内、不带凭据的 HTTPS 媒体地址。 */
  function mediaUrl(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && HOSTS.test(u.hostname) && /\.(m4s|mp4)$/i.test(u.pathname) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
  }

  /** 把 [start,end) 按 size 切成连续片段。 @returns {number[][]} */
  function split(start, end, size) {
    const result = [];
    for (let from = start; from < end; from += size) result.push([from, Math.min(end, from + size)]);
    return result;
  }

  /**
   * @param {{fetch: Function, onPiece?: (url: string, start: number, bytes: Uint8Array, total: number, contentType: string) => void,
   *   onPieceError?: (url: string, urgent: boolean) => void,
   *   maxSlots?: number, backgroundSlots?: number, hedgeMs?: number, firstByteMs?: number, stallMs?: number}} options
   * @returns {object} register/get/prefetch/… 见文件末尾的返回值。
   */
  function createNetwork({ fetch: fetcher, onPiece = () => {}, onPieceError = () => {}, maxSlots = 32, backgroundSlots = 12, hedgeMs = 800, firstByteMs = 8000, stallMs = 4000 } = {}) {
    const groups = new Map(), roles = new Map(), totals = new Map(), health = new Map();
    /** @type {Map<string, object[]>} url → 在途分片（按起点有序、互不重叠） */
    const inflight = new Map();
    const waiting = [];
    let running = 0, runningBackground = 0, generation = 0, sequence = 0;
    const freshCounters = () => ({ receivedBytes: 0, hedgeWins: 0, urgentRanges: 0, urgentBytes: 0, backgroundBytes: 0, backgroundErrors: 0, fallbacks: 0, host: '' });
    let counters = freshCounters();
    let speed = 0, sampleAt = performance.now(), sampleBytes = 0;

    // ---- 槽位：急需尝试可用满 maxSlots；后台尝试另受 backgroundSlots 约束，给播放器请求留余量。
    function drain() {
      waiting.sort((a, b) => b.piece.urgent - a.piece.urgent || a.piece.order - b.piece.order || a.seq - b.seq);
      for (let i = 0; i < waiting.length && running < maxSlots;) {
        const entry = waiting[i];
        if (!entry.piece.urgent && runningBackground >= backgroundSlots) { i++; continue; }
        waiting.splice(i, 1);
        entry.signal.removeEventListener('abort', entry.cancel);
        const background = !entry.piece.urgent;
        running++; if (background) runningBackground++;
        let released = false;
        entry.resolve(() => {
          if (released) return; released = true;
          running--; if (background) runningBackground--;
          drain();
        });
      }
    }
    function acquire(piece, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const entry = { piece, signal, resolve, seq: sequence++ };
        entry.cancel = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
        signal.addEventListener('abort', entry.cancel, { once: true });
        waiting.push(entry); drain();
      });
    }

    // ---- 节点健康：成功更新首字节/吞吐的指数平均；失败按地址指数退避隔离，不影响同组其他地址。
    function candidates(url, round) {
      const all = groups.get(url) || [url], now = performance.now();
      const healthy = all.filter(u => (health.get(u)?.until || 0) <= now);
      const pool = (healthy.length ? healthy : all).slice();
      // 已测量的地址按「首字节 + 传 256 KiB 的时间」排在前；未测量的按清单顺序（主地址在前）排在后，
      // 由对冲副本与失败换节点自然探索到。
      const score = u => { const h = health.get(u); return h?.bps ? h.ttfb + 262144000 / h.bps : Infinity; };
      pool.sort((a, b) => score(a) - score(b) || all.indexOf(a) - all.indexOf(b));
      const shift = round % pool.length;
      return [...pool.slice(shift), ...pool.slice(0, shift)];
    }
    // 对冲阈值随节点常态首字节伸缩：常态 1 秒首字节的冷节点不该每片都被判慢。
    const hedgeDelay = url => Math.min(3000, Math.max(hedgeMs, 2 * (health.get(url)?.ttfb || 0)));

    /** 单个 HTTP 尝试：持有槽位直到正文读完或失败。 */
    async function attempt(piece, url, signal, progress) {
      const release = await acquire(piece, signal);
      // 槽位授予与 await 恢复之间可能已被取消；此时 abort 事件已错过，必须立即归还槽位。
      if (signal.aborted) { release(); throw signal.reason; }
      const epoch = generation;
      const child = new AbortController();
      const cancel = () => child.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      let timer, reader;
      const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => child.abort(new DOMException('媒体节点超时', 'TimeoutError')), ms); };
      const began = performance.now();
      progress.started = true; progress.at = began;
      arm(firstByteMs);
      try {
        const response = await fetcher(url, { headers: { Range: `bytes=${piece.start}-${piece.end - 1}` }, credentials: 'omit', cache: 'no-store', signal: child.signal, priority: piece.urgent ? 'high' : 'low' });
        const ttfb = performance.now() - began;
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const total = Number(match?.[3]), known = piece.total || totals.get(piece.url) || 0;
        if (response.status !== 206 || !match || Number(match[1]) !== piece.start || Number(match[2]) !== Math.min(piece.end, total) - 1 || (known && total !== known)) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error('媒体节点范围校验失败'), { status: response.status });
        }
        const bytes = new Uint8Array(Number(match[2]) - piece.start + 1);
        reader = response.body.getReader();
        // 中止时主动取消读取：挂起的 read() 不一定随 fetch 的 signal 结束，否则槽位会被永久占住。
        child.signal.addEventListener('abort', () => void reader.cancel(child.signal.reason).catch(() => {}), { once: true });
        let read = 0;
        arm(stallMs);
        for (;;) {
          const { done, value } = await reader.read();
          if (child.signal.aborted) throw child.signal.reason;
          if (done) break;
          if (read + value.byteLength > bytes.length) throw new Error('媒体正文超出请求范围');
          bytes.set(value, read); read += value.byteLength;
          progress.at = performance.now(); arm(stallMs);
          if (epoch === generation) counters.receivedBytes += value.byteLength;
        }
        if (read !== bytes.length) throw new Error('媒体正文提前结束');
        const bps = read * 1000 / Math.max(1, performance.now() - began - ttfb), old = health.get(url);
        health.set(url, { until: 0, failures: 0, ttfb: old?.ttfb ? old.ttfb * .7 + ttfb * .3 : ttfb, bps: old?.bps ? old.bps * .7 + bps * .3 : bps });
        totals.set(piece.url, total);
        counters.host = new URL(url).hostname;
        return { bytes, total, contentType: response.headers.get('content-type') || 'application/octet-stream' };
      } catch (error) {
        // 只有节点自身的失败才计入退避；被取消（副本胜出、导航、播放器放弃）不算节点故障。
        if (!child.signal.aborted || child.signal.reason?.name === 'TimeoutError') {
          if (epoch === generation) {
            const old = health.get(url), failures = (old?.failures || 0) + 1;
            // 403 是该签名地址被拒，按地址隔离更久；其余故障 1→16 秒指数退避。
            health.set(url, { ...old, failures, until: performance.now() + (error.status === 403 ? 60000 : Math.min(16000, 1000 * 2 ** (failures - 1))) });
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (reader) void reader.cancel().catch(() => {});
        release();
      }
    }

    /** 一轮对冲：先用最优地址；首字节或正文停滞超过阈值时在下一个地址并行发副本，先完成者胜。
     * 原请求不会因对冲被取消——它可能马上就要出字节了。 */
    function race(piece, round) {
      const urls = candidates(piece.url, round), signal = piece.controller.signal;
      return new Promise((resolve, reject) => {
        const tries = []; let settled = false, failed = 0, lastError, timer;
        const finish = (fn, value) => {
          if (settled) return; settled = true; clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          for (const t of tries) t.controller.abort(abortError('已有副本胜出'));
          fn(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        const launch = () => {
          const url = urls[tries.length % urls.length];
          const t = { url, controller: new AbortController(), progress: { started: false, at: 0 } };
          tries.push(t);
          // 分片取消经 onAbort → finish 统一中止全部尝试，尝试只需监听自己的控制器。
          attempt(piece, url, t.controller.signal, t.progress).then(result => {
            if (tries.indexOf(t) > 0) counters.hedgeWins++;
            finish(resolve, result);
          }, error => {
            failed++; lastError = error;
            if (settled) return;
            // 还有未试的地址就立刻换下一个；全部失败才结束本轮。
            if (tries.length < urls.length) launch();
            else if (failed === tries.length) finish(reject, lastError);
          });
        };
        const watch = () => {
          if (settled) return;
          const first = tries[0];
          // 每轮最多一个对冲副本；尝试还在排队等槽位时不对冲（此时多发一份只会更挤）。
          if (tries.length === 1 && !failed && first.progress.started && performance.now() - first.progress.at >= hedgeDelay(first.url)) launch();
          timer = setTimeout(watch, 200);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        launch(); timer = setTimeout(watch, 200);
      });
    }

    async function runPiece(piece) {
      let lastError;
      for (let round = 0; round < 3; round++) {
        try { return await race(piece, round); } catch (error) {
          lastError = error;
          if (piece.controller.signal.aborted) throw piece.controller.signal.reason;
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** round));
        }
      }
      throw lastError;
    }

    function startPiece(url, start, end, { urgent, keep, order = 0, total = 0 }) {
      const piece = { url, start, end, urgent, keep, order, total, users: 0, controller: new AbortController(), epoch: generation };
      const list = inflight.get(url) || [];
      list.push(piece); list.sort((a, b) => a.start - b.start); inflight.set(url, list);
      piece.promise = runPiece(piece).then(result => {
        if (piece.epoch !== generation) throw abortError('页面已切换');
        // 分片落地即写入页面缓存：哪怕同批其他分片失败，已下好的字节也不浪费。
        onPiece(url, start, result.bytes, result.total, result.contentType);
        if (!piece.urgent) counters.backgroundBytes += result.bytes.length;
        return result;
      }, error => {
        if (!piece.controller.signal.aborted && piece.epoch === generation) {
          if (!piece.urgent) counters.backgroundErrors++;
          onPieceError(url, piece.urgent);
        }
        throw error;
      }).finally(() => drop(piece));
      piece.promise.catch(() => {});
      return piece;
    }

    // 取消时同步移出在途表：同一轮规划里就能为这段重新排分片，也不会有新请求挂到已取消的分片上。
    function drop(piece) {
      const list = inflight.get(piece.url);
      const index = list?.indexOf(piece) ?? -1;
      if (index >= 0) list.splice(index, 1);
      if (list && !list.length) inflight.delete(piece.url);
    }
    function cancel(piece, reason) {
      drop(piece);
      piece.controller.abort(reason);
    }

    /** 按顺序遍历 [start,end)：在途分片原样返回，缺口按 size 新建分片。 */
    function cover(url, start, end, size, options) {
      const result = [];
      let cursor = start;
      for (const piece of [...(inflight.get(url) || [])]) {
        if (piece.end <= cursor) continue;
        if (piece.start >= end) break;
        for (const [a, b] of split(cursor, Math.min(piece.start, end), size)) result.push(startPiece(url, a, b, options));
        result.push(piece);
        cursor = Math.max(cursor, piece.end);
      }
      for (const [a, b] of split(cursor, end, size)) result.push(startPiece(url, a, b, options));
      return result;
    }

    /**
     * 取 [start,end) 的完整字节，播放器请求专用（急需优先级）。
     * @param {string} url @param {number} start @param {number} end
     * @param {{signal: AbortSignal, total?: number}} options
     * @returns {Promise<{bytes: Uint8Array, total: number, contentType: string}>}
     */
    async function get(url, start, end, { signal, total = 0 }) {
      if (!mediaUrl(url) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > MAX_RANGE) throw new Error('不支持的媒体范围');
      if (signal.aborted) throw signal.reason;
      const size = Math.min(BACKGROUND_PIECE, Math.max(MIN_PIECE, Math.ceil((end - start) / URGENT_SPLIT / MIN_PIECE) * MIN_PIECE));
      const pieces = cover(url, start, end, size, { urgent: true, keep: false, total });
      for (const piece of pieces) {
        piece.users++;
        // 播放器在等的后台分片升为急需：排队中的尝试立刻获得优先权。
        if (!piece.urgent) { piece.urgent = true; drain(); }
      }
      let leave;
      const left = new Promise((_, reject) => {
        leave = () => reject(signal.reason || abortError());
        signal.addEventListener('abort', leave, { once: true });
      });
      counters.urgentRanges++;
      try {
        const results = await Promise.race([Promise.all(pieces.map(p => p.promise)), left]);
        const bytes = new Uint8Array(end - start);
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i], body = results[i].bytes;
          const from = Math.max(start, piece.start), to = Math.min(end, piece.start + body.length);
          if (to - from !== Math.min(end, piece.end) - from) throw new Error('媒体分片长度不一致');
          bytes.set(body.subarray(from - piece.start, to - piece.start), from - start);
        }
        counters.urgentBytes += bytes.length;
        return { bytes, total: results[0].total, contentType: results[0].contentType };
      } finally {
        signal.removeEventListener('abort', leave);
        for (const piece of pieces) {
          // 播放器放弃后，没人等的急需分片立即取消；后台分片继续把前方窗口填满。
          if (--piece.users === 0 && !piece.keep) cancel(piece, abortError());
        }
      }
    }

    /** 为前方窗口排后台分片（不等待结果）；order 越小越先下载，通常是距播放点的秒数。
     * @param {string} url @param {number} start @param {number} end @param {{order?: number, total?: number}} [options] @returns {number} 新建分片数 */
    function prefetch(url, start, end, { order = 0, total = 0 } = {}) {
      if (!mediaUrl(url) || !(end > start)) return 0;
      const before = inflight.get(url)?.length || 0;
      cover(url, start, end, BACKGROUND_PIECE, { urgent: false, keep: true, order, total });
      return (inflight.get(url)?.length || 0) - before;
    }

    /** 拖动或换清晰度后，旧窗口的后台分片已无意义：取消没有播放器在等、且不再被需要的分片，让出槽位。
     * @param {(url: string, start: number, end: number) => boolean} isWanted */
    function pruneBackground(isWanted) {
      for (const list of inflight.values()) for (const piece of [...list]) {
        if (piece.keep && !piece.users && !isWanted(piece.url, piece.start, piece.end)) cancel(piece, abortError('播放位置已改变'));
      }
    }

    /** @returns {number} 尚未完成的后台分片数，预热规划据此控制排队深度。 */
    function backgroundPending() {
      let count = 0;
      for (const list of inflight.values()) for (const piece of list) if (!piece.urgent) count++;
      return count;
    }

    function register(payload) {
      const data = payload?.data || payload?.result || payload, dash = data?.dash;
      const entries = [...(dash?.video || []).map(t => [t, 'video']), ...(dash?.audio || []).map(t => [t, 'audio']),
        ...(dash?.dolby?.audio || []).map(t => [t, 'audio']), ...(dash?.flac?.audio ? [[dash.flac.audio, 'audio']] : [])];
      for (const [track, role] of entries) {
        const backups = track.backupUrl || track.backup_url || track.backup_url_list || [];
        const urls = [...new Set([track.baseUrl || track.base_url, ...(Array.isArray(backups) ? backups : [])].map(mediaUrl).filter(Boolean))];
        for (const url of urls) { groups.set(url, urls); roles.set(url, role); }
      }
      while (groups.size > 256) { const key = groups.keys().next().value; groups.delete(key); roles.delete(key); totals.delete(key); }
    }

    function snapshot() {
      const now = performance.now(), elapsed = now - sampleAt;
      if (elapsed >= 500) {
        const rate = (counters.receivedBytes - sampleBytes) * 1000 / elapsed;
        speed = rate > 0 || running ? speed * .5 + rate * .5 : 0;
        sampleAt = now; sampleBytes = counters.receivedBytes;
      }
      return {
        active: running, limit: maxSlots, speed: Math.round(speed), receivedBytes: counters.receivedBytes,
        rescues: counters.hedgeWins, host: counters.host, accelerated: counters.urgentRanges, acceleratedBytes: counters.urgentBytes,
        nativeFallbacks: counters.fallbacks, prefetching: backgroundPending(), prefetchBytes: counters.backgroundBytes, prefetchErrors: counters.backgroundErrors,
        queued: waiting.length, blocked: [...health.values()].filter(h => h.until > now).length
      };
    }

    function reset() {
      generation++;
      for (const list of inflight.values()) for (const piece of list) piece.controller.abort(abortError('页面已切换'));
      inflight.clear(); groups.clear(); roles.clear(); totals.clear(); health.clear();
      counters = freshCounters();
      speed = 0; sampleBytes = 0; sampleAt = performance.now();
    }

    return {
      register, get, prefetch, pruneBackground, snapshot, reset,
      role: url => roles.get(url),
      total: url => totals.get(url) || 0,
      /** @param {string} url @returns {number[][]} 在途分片区间（半开）。 */
      inflightRanges: url => (inflight.get(url) || []).map(p => [p.start, p.end]),
      backgroundPending,
      fallback() { counters.fallbacks++; }
    };
  }
  globalThis.BiliPlaybackNetwork = { createNetwork, mediaUrl, BACKGROUND_PIECE };
})();
