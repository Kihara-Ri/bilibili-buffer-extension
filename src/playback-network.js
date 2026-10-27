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

  // 只复用已确认兼容的 UPOS 媒体路径；不向任意 CDN、P2P、直播或第三方地址拼主机。
  const MIRROR_SOURCES = new Set(['upos-sz-mirrorcosov.bilivideo.com', 'upos-hz-mirrorakam.akamaized.net']);
  function mirrorUrls(url) {
    const source = new URL(url);
    if (!MIRROR_SOURCES.has(source.hostname) || !source.pathname.startsWith('/upgcxcode/') || !source.pathname.endsWith('.m4s')) return [];
    return ['mirrorhw', 'mirrorali', 'mirroralib', 'mirrorhwb'].map(id => {
      const target = new URL(source); target.hostname = `upos-sz-${id}.bilivideo.com`; return target.href;
    });
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
   *   maxSlots?: number, backgroundSlots?: number, hedgeMs?: number, firstByteMs?: number, stallMs?: number, demandTimeoutMs?: number}} options
   * @returns {object} register/get/prefetch/… 见文件末尾的返回值。
   */
  function createNetwork({ fetch: fetcher, onPiece = () => {}, onPieceError = () => {}, maxSlots = 32, backgroundSlots = 12, hedgeMs = 800, firstByteMs = 8000, stallMs = 4000, demandTimeoutMs = 12000 } = {}) {
    const groups = new Map(), totals = new Map(), health = new Map();
    /** @type {Map<string, object[]>} url → 在途分片（按起点有序、互不重叠） */
    const inflight = new Map();
    const waiting = [];
    // 普通并发不变；全部普通槽位卡首字节时，额外两条急需救援通道避免“救援也在排队”。
    // 仅备用/对冲且播放器正在等待时可用，绝不用于扩大后台预热。
    const rescueSlots = 2;
    const makeGroup = urls => ({ urls, mirrors: [...new Set(urls.flatMap(mirrorUrls))].filter(u => !urls.includes(u)), reference: null, verified: new Set(), verifying: new Map() });
    function groupFor(url) {
      if (!groups.has(url)) {
        groups.set(url, makeGroup([url]));
        while (groups.size > 256) { const oldest = groups.keys().next().value; groups.delete(oldest); totals.delete(oldest); }
      }
      return groups.get(url);
    }
    /** 是否缺少镜像校验身份。仅清单/实际观察到的原地址可从其驻留缓存补齐身份。
     * @param {string} url @returns {boolean} */
    function needsReference(url) {
      if (!mediaUrl(url)) return false;
      const group = groupFor(url);
      return group.urls.includes(url) && group.mirrors.length > 0 && !group.reference;
    }
    /** 复用原地址已校验的连续文件头，不重新下载已缓存的数据，也不信任生成镜像。
     * @param {string} url @param {Uint8Array} bytes @param {number} total @returns {boolean} */
    function seedReference(url, bytes, total) {
      if (!needsReference(url) || !Number.isSafeInteger(total) || total <= 0 || !ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) return false;
      const size = Math.min(1024, total), established = totals.get(url);
      if (bytes.byteLength < size || (established && total !== established)) return false;
      groupFor(url).reference = { bytes: new Uint8Array(bytes.subarray(0, size)), total };
      totals.set(url, total);
      return true;
    }
    let running = 0, runningBackground = 0, generation = 0, sequence = 0;
    const freshCounters = () => ({ receivedBytes: 0, hedgeWins: 0, urgentRanges: 0, urgentBytes: 0, backgroundBytes: 0, backgroundErrors: 0, fallbacks: 0, host: '' });
    let counters = freshCounters();
    let speed = 0, sampleAt = performance.now(), sampleBytes = 0;

    // ---- 槽位：急需尝试可用满 maxSlots；后台尝试另受 backgroundSlots 约束，给播放器请求留余量。
    function drain() {
      waiting.sort((a, b) => b.piece.urgent - a.piece.urgent || Number(b.rescue) - Number(a.rescue) || a.piece.order - b.piece.order || a.seq - b.seq);
      for (let i = 0; i < waiting.length;) {
        const entry = waiting[i];
        if (running >= maxSlots + (entry.rescue && entry.piece.urgent ? rescueSlots : 0)) { i++; continue; }
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
    function acquire(piece, signal, rescue) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const entry = { piece, signal, rescue, resolve, seq: sequence++ };
        entry.cancel = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
        signal.addEventListener('abort', entry.cancel, { once: true });
        waiting.push(entry); drain();
      });
    }

    // ---- 节点健康：成功更新首字节/吞吐的指数平均；失败按地址指数退避隔离，不影响同组其他地址。
    function candidates(url, round) {
      const group = groupFor(url), now = performance.now();
      // 先用清单主备。只有拿到原清单的文件头身份后，慢/失败路径才有资格探索镜像。
      const all = [...group.urls, ...(group.reference ? group.mirrors : [])];
      const healthy = all.filter(u => (health.get(u)?.until || 0) <= now);
      const pool = (healthy.length ? healthy : all).slice();
      // 已测量的地址按「首字节 + 传 256 KiB 的时间」排在前；未测量的按清单顺序（主地址在前）排在后，
      // 由对冲副本与失败换节点自然探索到。
      const score = u => { const h = health.get(u); return h?.bps ? h.ttfb + 262144000 / h.bps : Infinity; };
      pool.sort((a, b) => score(a) - score(b) || all.indexOf(a) - all.indexOf(b));
      const shift = round % pool.length;
      return [...pool.slice(shift), ...pool.slice(0, shift)];
    }
    /** 输给对冲副本的节点：在阈值内没出任何字节，说明它此刻卡住了。
     * 像失败一样短暂隔离（1→16 秒），并把卡住的时长计入首字节均值；否则它会凭旧成绩一直排第一，
     * 每个分片都要先白等一个对冲阈值。 */
    function demote(url, stalledMs) {
      const old = health.get(url), slow = (old?.slow || 0) + 1;
      health.set(url, { ...old, slow, ttfb: old?.ttfb ? old.ttfb * .7 + stalledMs * .3 : stalledMs,
        until: performance.now() + Math.min(16000, 1000 * 2 ** (slow - 1)) });
    }
    // 对冲阈值随节点常态首字节伸缩：常态 1 秒首字节的冷节点不该每片都被判慢。
    const hedgeDelay = url => Math.min(3000, Math.max(hedgeMs, 2 * (health.get(url)?.ttfb || 0)));

    /** 一次 Range 读取。校验探针与媒体分片共用相同的超时、范围与长度校验。 */
    async function readRange(url, start, end, known, signal, progress, urgent) {
      const epoch = generation, child = new AbortController();
      const cancel = () => child.abort(signal.reason);
      if (signal.aborted) throw signal.reason;
      signal.addEventListener('abort', cancel, { once: true });
      let timer, reader, stopReader;
      const arm = ms => { clearTimeout(timer); timer = setTimeout(() => child.abort(new DOMException('媒体节点超时', 'TimeoutError')), ms); };
      const began = performance.now();
      progress.started = true; progress.at = began;
      arm(firstByteMs);
      try {
        const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'omit', cache: 'no-store', signal: child.signal, priority: urgent ? 'high' : 'low' });
        const ttfb = performance.now() - began;
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const total = Number(match?.[3]);
        if (response.status !== 206 || !match || !Number.isSafeInteger(total) || total <= 0 || Number(match[2]) < start || Number(match[2]) >= total || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, total) - 1 || (known && total !== known)) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error('媒体节点范围校验失败'), { status: response.status });
        }
        const bytes = new Uint8Array(Number(match[2]) - start + 1);
        reader = response.body.getReader();
        // 挂起的 read() 不一定随 fetch 结束，必须主动取消读取，归还信号量槽位。
        stopReader = () => void reader.cancel(child.signal.reason).catch(() => {});
        child.signal.addEventListener('abort', stopReader, { once: true });
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
        return { bytes, total, contentType: response.headers.get('content-type') || 'application/octet-stream', ttfb,
          bps: read * 1000 / Math.max(1, performance.now() - began - ttfb) };
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (stopReader) child.signal.removeEventListener('abort', stopReader);
        if (reader) void reader.cancel().catch(() => {});
      }
    }

    /** 校验任务自己持有槽位与控制器；最后一个等待者离开才取消，不能绑到首个播放器请求。 */
    async function verifyMirror(group, piece, url, signal, progress, rescue) {
      if (!group.mirrors.includes(url) || group.verified.has(url)) return;
      const reference = group.reference;
      if (!reference) throw new Error('尚无原始媒体身份');
      let probe = group.verifying.get(url);
      if (!probe || probe.controller.signal.aborted) {
        // 同一批分片共享失败结果；不要让后来的分片再次探测刚被隔离的镜像。
        if ((health.get(url)?.until || 0) > performance.now()) throw Object.assign(new Error('镜像暂时隔离'), { mirrorProbe: true });
        const epoch = generation;
        probe = { controller: new AbortController(), users: new Set(), done: false, progress: { started: false, at: 0 } };
        const task = probe, probePiece = {
          // 等待中的后台分片会被播放器提升，不能保存创建探针时的优先级快照。
          get urgent() { return task.users.size ? [...task.users].some(user => user.piece.urgent) : piece.urgent; },
          get order() { return task.users.size ? Math.min(...[...task.users].map(user => user.piece.order)) : piece.order; }
        };
        task.promise = (async () => {
          const release = await acquire(probePiece, task.controller.signal, true);
          try {
            if (task.controller.signal.aborted) throw task.controller.signal.reason;
            const result = await readRange(url, 0, reference.bytes.length, reference.total, task.controller.signal, task.progress, probePiece.urgent);
            if (task.controller.signal.aborted || epoch !== generation) throw task.controller.signal.reason || abortError();
            if (result.bytes.length !== reference.bytes.length || !result.bytes.every((byte, index) => byte === reference.bytes[index]))
              throw new Error('镜像媒体身份不一致');
            group.verified.add(url);
          } catch (error) {
            if (!task.controller.signal.aborted && epoch === generation) recordFailure(url, error);
            throw Object.assign(error, { mirrorProbe: true });
          } finally { release(); }
        })().finally(() => {
          task.done = true;
          if (group.verifying.get(url) === task) group.verifying.delete(url);
        });
        task.promise.catch(() => {});
        group.verifying.set(url, task);
      }
      progress.shared = probe.progress;
      await new Promise((resolve, reject) => {
        const user = { piece }; probe.users.add(user); drain();
        const leave = () => {
          signal.removeEventListener('abort', cancel); probe.users.delete(user);
          if (!probe.users.size && !probe.done) probe.controller.abort(abortError('没有校验等待者'));
        };
        const cancel = () => { leave(); reject(signal.reason); };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        probe.promise.then(() => { leave(); resolve(); }, error => { leave(); reject(error); });
      });
      progress.shared = null;
    }

    function recordFailure(url, error) {
      const old = health.get(url), failures = (old?.failures || 0) + 1;
      health.set(url, { ...old, failures, until: performance.now() + (error.status === 403 || /身份不一致/.test(error.message) ? 60000 : Math.min(16000, 1000 * 2 ** (failures - 1))) });
    }

    const changedManifest = () => Object.assign(abortError('播放清单已更新，重新选择候选'), { replan: true });

    /** 单个候选尝试。镜像只能在文件头指纹与原清单一致之后交付其他范围。 */
    async function attempt(piece, url, signal, progress, rescue, group) {
      const epoch = generation;
      let release;
      try {
        // 候选列表与身份校验必须属于同一份清单；不能把已移除的旧镜像当作普通原地址。
        if (groups.get(piece.url) !== group || (!group.urls.includes(url) && !group.mirrors.includes(url))) throw changedManifest();
        await verifyMirror(group, piece, url, signal, progress, rescue);
        if (groups.get(piece.url) !== group) throw changedManifest();
        release = await acquire(piece, signal, rescue);
        if (signal.aborted) throw signal.reason;
        if (groups.get(piece.url) !== group) throw changedManifest();
        const result = await readRange(url, piece.start, piece.end, piece.total || totals.get(piece.url) || 0, signal, progress, piece.urgent);
        if (signal.aborted || epoch !== generation) throw signal.reason || abortError();
        // 并发尝试启动时可能都还不知道总长；交付前重查首个成功结果确立的身份，
        // 否则不同 CDN 的不一致对象会各自通过旧快照校验，再混入同一份驻留缓存。
        if (groups.get(piece.url) !== group) throw changedManifest();
        const establishedTotal = totals.get(piece.url);
        if (establishedTotal && result.total !== establishedTotal) throw new Error('媒体文件总长不一致');
        const old = health.get(url);
        health.set(url, { until: 0, failures: 0, ttfb: old?.ttfb ? old.ttfb * .7 + result.ttfb * .3 : result.ttfb,
          bps: old?.bps ? old.bps * .7 + result.bps * .3 : result.bps });
        if (group.urls.includes(url) && piece.start === 0) seedReference(piece.url, result.bytes, result.total);
        totals.set(piece.url, result.total);
        counters.host = new URL(url).hostname;
        result.group = group;
        return result;
      } catch (error) {
        if (!signal.aborted && epoch === generation && groups.get(piece.url) !== group) throw changedManifest();
        if (!signal.aborted && epoch === generation && !error.mirrorProbe && !error.replan) recordFailure(url, error);
        throw error;
      } finally { release?.(); }
    }

    /** 一轮对冲：先用最优地址；首字节或正文停滞超过阈值时在下一个地址并行发副本，先完成者胜。
     * 原请求不会因对冲被取消——它可能马上就要出字节了。 */
    function race(piece, round) {
      const group = groupFor(piece.url), urls = candidates(piece.url, round), signal = piece.controller.signal;
      return new Promise((resolve, reject) => {
        const tries = []; let settled = false, failed = 0, lastError, timer;
        const finish = (fn, value) => {
          if (settled) return; settled = true; clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          for (const t of tries) t.controller.abort(abortError('已有副本胜出'));
          fn(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        const launch = (hedge = false) => {
          const url = urls[tries.length % urls.length];
          const t = { url, hedge, controller: new AbortController(), progress: { started: false, at: 0 } };
          tries.push(t);
          // 分片取消经 onAbort → finish 统一中止全部尝试，尝试只需监听自己的控制器。
          attempt(piece, url, t.controller.signal, t.progress, hedge || tries.length > 1, group).then(result => {
            // 只有对冲副本胜出才算「救援」；先前尝试已失败后的换节点不算。
            if (t.hedge) {
              counters.hedgeWins++;
              const loser = tries[0];
              if (loser !== t && loser.progress.started) demote(loser.url, performance.now() - loser.progress.at);
            }
            finish(resolve, result);
          }, error => {
            failed++; lastError = error;
            if (settled) return;
            if (error.replan) { finish(reject, error); return; }
            // 还有未试的地址就立刻换下一个；全部失败才结束本轮。
            if (tries.length < urls.length) launch(Boolean(t.rotated));
            else if (failed === tries.length) finish(reject, lastError);
          });
        };
        const watch = () => {
          if (settled) return;
          const first = tries[0], progress = first.progress.shared || first.progress;
          // 每轮最多一个对冲副本；尝试还在排队等槽位时不对冲（此时多发一份只会更挤）。
          if (tries.length === 1 && !failed && progress.started && performance.now() - progress.at >= hedgeDelay(first.url)) launch(true);
          // 原清单主备同时卡住时，只再排一个副本仍会白等到 8 秒。
          // 保留首个原请求，轮换长期无进展的备用请求；有正文持续流入时不轮换。
          const last = tries[tries.length - 1], recent = last.progress.shared || last.progress;
          if (piece.urgent && tries.length > 1 && tries.length < urls.length && !last.controller.signal.aborted && recent.started &&
              performance.now() - recent.at >= 2 * hedgeDelay(last.url)) {
            last.rotated = true;
            demote(last.url, performance.now() - recent.at);
            last.controller.abort(abortError('备用请求停滞，尝试下一候选'));
          }
          timer = setTimeout(watch, 200);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        launch(); timer = setTimeout(watch, 200);
      });
    }

    /** 后台分片最多 3 轮；急需分片只给 2 轮——播放器在等，再失败就该尽快交还原生请求。
     * 最后一轮失败后立即抛出，轮间退避可被取消打断。 */
    async function runPiece(piece) {
      const signal = piece.controller.signal;
      for (let round = 0; ; round++) {
        try { return await race(piece, round); } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (round + 1 >= (piece.urgent ? 2 : 3)) throw error;
          if (error.replan) continue;
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 250 * 2 ** round);
            signal.addEventListener('abort', done, { once: true });
          });
        }
      }
    }

    function startPiece(url, start, end, { urgent, keep, order = 0, total = 0 }) {
      const piece = { url, start, end, urgent, keep, order, total, users: 0, controller: new AbortController(), epoch: generation };
      const list = inflight.get(url) || [];
      list.push(piece); list.sort((a, b) => a.start - b.start); inflight.set(url, list);
      piece.promise = runPiece(piece).then(result => {
        if (piece.epoch !== generation) throw abortError('页面已切换');
        if (groups.get(url) !== result.group) throw changedManifest();
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
     * into/at：调用方预先分配的目标缓冲与偏移，分片字节直接写进去，返回的 bytes 是它的视图；
     * 拼装播放器响应时省掉一整份中间拷贝。
     * @param {{signal: AbortSignal, total?: number, into?: Uint8Array, at?: number}} options
     * @returns {Promise<{bytes: Uint8Array, total: number, contentType: string}>}
     */
    async function get(url, start, end, { signal, total = 0, into = null, at = 0 }) {
      if (!mediaUrl(url) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > MAX_RANGE) throw new Error('不支持的媒体范围');
      if (signal.aborted) throw signal.reason;
      const size = Math.min(BACKGROUND_PIECE, Math.max(MIN_PIECE, Math.ceil((end - start) / URGENT_SPLIT / MIN_PIECE) * MIN_PIECE));
      const pieces = cover(url, start, end, size, { urgent: true, keep: false, total });
      for (const piece of pieces) {
        piece.users++;
        // 播放器在等的后台分片升为急需：排队中的尝试立刻获得优先权。
        if (!piece.urgent) { piece.urgent = true; drain(); }
      }
      let leave, deadline;
      const left = new Promise((_, reject) => {
        leave = () => reject(signal.reason || abortError());
        // 等待槽位、校验镜像、多个候选重试共用总预算，不能因扩充线路让播放器无限等待。
        deadline = setTimeout(() => reject(new DOMException('媒体请求总等待超时', 'TimeoutError')), demandTimeoutMs);
        signal.addEventListener('abort', leave, { once: true });
      });
      counters.urgentRanges++;
      try {
        const results = await Promise.race([Promise.all(pieces.map(p => p.promise)), left]);
        if (results.some(result => result.group !== groups.get(url))) throw changedManifest();
        if (results.some(result => result.total !== results[0].total)) throw new Error('媒体分片总长不一致');
        const bytes = into ? into.subarray(at, at + end - start) : new Uint8Array(end - start);
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i], body = results[i].bytes;
          const from = Math.max(start, piece.start), to = Math.min(end, piece.start + body.length);
          if (to - from !== Math.min(end, piece.end) - from) throw new Error('媒体分片长度不一致');
          bytes.set(body.subarray(from - piece.start, to - piece.start), from - start);
        }
        counters.urgentBytes += bytes.length;
        return { bytes, total: results[0].total, contentType: results[0].contentType };
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', leave);
        for (const piece of pieces) {
          // 播放器放弃后：没人等的急需分片立即取消；后台分片（含被预热接管的）恢复后台身份继续填窗口。
          if (--piece.users === 0) {
            if (piece.keep) piece.urgent = false;
            else cancel(piece, abortError());
          }
        }
      }
    }

    /** 为前方窗口排后台分片（不等待结果）；order 越小越先下载，通常是距播放点的秒数。
     * @param {string} url @param {number} start @param {number} end @param {{order?: number, total?: number}} [options] @returns {number} 新建分片数 */
    function prefetch(url, start, end, { order = 0, total = 0 } = {}) {
      if (!mediaUrl(url) || !(end > start)) return 0;
      const before = inflight.get(url)?.length || 0;
      for (const piece of cover(url, start, end, BACKGROUND_PIECE, { urgent: false, keep: true, order, total })) {
        // 窗口里已有播放器的急需分片：预热接管它（keep），否则播放器一放弃它就被取消，窗口留下空洞。
        if (!piece.keep) { piece.keep = true; piece.order = Math.min(piece.order, order); }
      }
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
      const entries = [...(dash?.video || []), ...(dash?.audio || []), ...(dash?.dolby?.audio || []), ...(dash?.flac?.audio ? [dash.flac.audio] : [])];
      for (const track of entries) {
        const backups = track.backupUrl || track.backup_url || track.backup_url_list || [];
        const urls = [...new Set([track.baseUrl || track.base_url, ...(Array.isArray(backups) ? backups : [])].map(mediaUrl).filter(Boolean))];
        if (!urls.length) continue;
        const old = groups.get(urls[0]);
        const group = old && old.urls.join('\n') === urls.join('\n') ? old : makeGroup(urls);
        for (const url of urls) groups.set(url, group);
      }
      while (groups.size > 256) { const key = groups.keys().next().value; groups.delete(key); totals.delete(key); }
    }

    function snapshot() {
      const now = performance.now(), elapsed = now - sampleAt;
      if (elapsed >= 500) {
        const rate = (counters.receivedBytes - sampleBytes) * 1000 / elapsed;
        speed = rate > 0 || running ? speed * .5 + rate * .5 : 0;
        sampleAt = now; sampleBytes = counters.receivedBytes;
      }
      return {
        active: running, limit: maxSlots + rescueSlots, speed: Math.round(speed), receivedBytes: counters.receivedBytes,
        rescues: counters.hedgeWins, host: counters.host, accelerated: counters.urgentRanges, acceleratedBytes: counters.urgentBytes,
        nativeFallbacks: counters.fallbacks, prefetching: backgroundPending(), prefetchBytes: counters.backgroundBytes, prefetchErrors: counters.backgroundErrors,
        queued: waiting.length, blocked: [...health.values()].filter(h => h.until > now).length
      };
    }

    function reset() {
      generation++;
      for (const list of inflight.values()) for (const piece of list) piece.controller.abort(abortError('页面已切换'));
      inflight.clear(); groups.clear(); totals.clear(); health.clear();
      counters = freshCounters();
      speed = 0; sampleBytes = 0; sampleAt = performance.now();
    }

    return {
      register, get, prefetch, pruneBackground, snapshot, reset, needsReference, seedReference,
      total: url => totals.get(url) || 0,
      /** @param {string} url @returns {number[][]} 在途分片区间（半开）。 */
      inflightRanges: url => (inflight.get(url) || []).map(p => [p.start, p.end]),
      backgroundPending,
      fallback() { counters.fallbacks++; }
    };
  }
  globalThis.BiliPlaybackNetwork = { createNetwork, mediaUrl, BACKGROUND_PIECE };
})();
