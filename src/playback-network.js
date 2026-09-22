(() => {
  'use strict';
  const MiB = 1024 * 1024;
  const abortError = () => new DOMException('播放请求已取消', 'AbortError');
  /** 在线请求与预热共享的分块下载器；签名 URL 只留在内存，公开状态只有主机名。
   * @param {{fetch: Function, maxConcurrency?: number, cdnMode?: string, hedgeMs?: number, timeoutMs?: number, firstByteMs?: number, stallMs?: number}} options
   * @returns {object} register/download/tune/reset/snapshot 配合页面世代使用。
   */
  function createNetwork({ fetch: fetcher, maxConcurrency = 32, cdnMode = 'original', hedgeMs = 700, timeoutMs = 10000, firstByteMs = 3500, stallMs = 2500 } = {}) {
    const groups = new Map(), totals = new Map(), roles = new Map(), health = new Map();
    const pending = [], running = new Set(), jobs = new Set();
    let ceiling = Math.max(1, Math.min(32, Math.floor(maxConcurrency))), limit = Math.min(8, ceiling), mode = cdnMode;
    let generation = 0, receivedBytes = 0, rescues = 0, lastHost = '', lastTune = -Infinity, requestSequence = 0, sampleAt = performance.now(), sampleBytes = 0, speed = 0;
    let accelerated = 0, acceleratedBytes = 0, nativeFallbacks = 0;
    const floor = () => Math.min(8, ceiling);
    function drain() {
      while (running.size < limit) {
        // 预热最多占一半连接，急需的音频/媒体和救援不受此子限额限制。
        const background = [...running].filter(t => t.priority <= 0).length;
        const index = pending.findIndex(j => j.priority > 0 || background < Math.max(1, Math.floor(limit / 2)));
        if (index < 0) break;
        const job = pending.splice(index, 1)[0];
        job.signal.removeEventListener('abort', job.cancel);
        if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
        const token = { priority: job.priority };
        running.add(token);
        job.resolve(() => { running.delete(token); drain(); });
      }
    }
    function acquire(signal, priority) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const job = { signal, priority, sequence: requestSequence++, resolve, reject };
        job.cancel = () => { const index = pending.indexOf(job); if (index >= 0) pending.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(signal.reason); };
        signal.addEventListener('abort', job.cancel, { once: true });
        pending.push(job); pending.sort((a,b) => b.priority - a.priority || a.sequence - b.sequence); drain();
      });
    }
    function register(payload) {
      const data = payload?.data || payload?.result || payload, dash = data?.dash;
      const entries = [...(dash?.video || []).map(t => [t,'video']), ...(dash?.audio || []).map(t => [t,'audio']),
        ...(dash?.dolby?.audio || []).map(t => [t,'audio']), ...(dash?.flac?.audio ? [[dash.flac.audio,'audio']] : [])];
      for (const [track, role] of entries) {
        const backups = track.backupUrl || track.backup_url || track.backup_url_list || [];
        const urls = [...new Set([track.baseUrl || track.base_url, ...(Array.isArray(backups) ? backups : [])].map(globalThis.BiliPlaybackRoutes.mediaUrl).filter(Boolean))];
        for (const url of urls) { groups.set(url, urls); roles.set(url, role); }
      }
      while (groups.size > 256) { const key = groups.keys().next().value; groups.delete(key); roles.delete(key); totals.delete(key); }
    }
    function candidates(url, offset = 0) {
      const all = globalThis.BiliPlaybackRoutes.candidates(groups.get(url) || [url], mode);
      const now = performance.now();
      const available = all.filter(u => (health.get(u)?.until || 0) <= now);
      const pool = available.length ? available : all;
      // 首轮分块分散到不同节点，避免所有块都在同一个冷缓存节点排队。
      const rotation = pool.length ? offset % Math.min(3, pool.length) : 0;
      const rotated = [...pool.slice(rotation), ...pool.slice(0, rotation)];
      return rotated.sort((a,b) => {
        const score = u => { const h = health.get(u); return h?.bps ? h.ttfb + 262144000 / h.bps : 1500; };
        return score(a) - score(b);
      });
    }
    async function attempt(url, start, end, total, signal, priority, epoch, progress) {
      const release = await acquire(signal, priority);
      const child = new AbortController(), began = performance.now();
      const cancel = () => child.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let reader, firstTimer, bodyTimer, bytesRead = 0;
      const timeout = () => child.abort(new DOMException('媒体节点超时', 'TimeoutError'));
      const totalTimer = setTimeout(timeout, timeoutMs);
      firstTimer = setTimeout(timeout, firstByteMs);
      progress.started = true; progress.lastByte = began;
      try {
        if (child.signal.aborted) throw child.signal.reason;
        const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'omit', cache: 'no-store', signal: child.signal, priority: priority > 0 ? 'high' : 'low' });
        clearTimeout(firstTimer);
        const ttfb = performance.now() - began;
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        const size = Number(match?.[3]), actualEnd = Number(match?.[2]);
        if (response.status !== 206 || !match || !Number.isSafeInteger(size) || Number(match[1]) !== start || actualEnd !== Math.min(end, size) - 1 || size <= actualEnd || (total > 0 && size !== total)) {
          await response.body?.cancel(); throw Object.assign(new Error('媒体节点范围校验失败'), {status: response.status});
        }
        const bytes = new Uint8Array(actualEnd - start + 1);
        reader = response.body.getReader();
        const cancelReader = () => { void reader.cancel(child.signal.reason).catch(() => {}); };
        child.signal.addEventListener('abort', cancelReader, {once:true});
        const arm = () => { clearTimeout(bodyTimer); bodyTimer = setTimeout(timeout, stallMs); };
        arm();
        try {
          if (child.signal.aborted) throw child.signal.reason;
          while (true) {
            const {done, value} = await reader.read();
            if (child.signal.aborted) throw child.signal.reason;
            if (done) break;
            arm(); progress.lastByte = performance.now();
            if (epoch === generation) receivedBytes += value.byteLength;
            if (bytesRead + value.byteLength > bytes.length) throw new Error('媒体正文超出请求范围');
            bytes.set(value, bytesRead); bytesRead += value.byteLength;
          }
        } finally { child.signal.removeEventListener('abort', cancelReader); }
        if (bytesRead !== bytes.length) throw new Error('媒体正文提前结束');
        if (epoch !== generation || signal.aborted) throw abortError();
        const bps = bytesRead * 1000 / Math.max(1, performance.now() - began), old = health.get(url);
        health.set(url, {until:0, failures:0, bps:old?.bps ? old.bps*.6+bps*.4 : bps, ttfb});
        lastHost = new URL(url).hostname;
        return {bytes, total:size, contentType:response.headers.get('content-type') || 'application/octet-stream'};
      } catch (error) {
        if (!signal.aborted && epoch === generation) {
          const old = health.get(url), failures = (old?.failures || 0) + 1;
          // 403 是这个签名地址被拒绝，不能据此永久封禁整个节点或削减所有轨道并发。
          health.set(url, { ...old, failures, until:performance.now() + (error.status === 403 ? 60000 : Math.min(30000, 1000 * 2 ** Math.min(failures,4))) });
        }
        throw error;
      } finally {
        clearTimeout(firstTimer); clearTimeout(bodyTimer); clearTimeout(totalTimer);
        signal.removeEventListener('abort', cancel);
        await reader?.cancel().catch(() => {}); release();
      }
    }
    async function piece(url, start, end, total, signal, priority, epoch, offset) {
      let lastError;
      // 只重试失败子块，已完成子块不重新下载；两轮均受整个媒体请求的截止时间约束。
      for (let round = 0; round < 2; round++) {
        if (signal.aborted) throw signal.reason;
        const urls = candidates(url, offset + round).slice(0, 10);
        try {
          return await new Promise((resolve,reject) => {
            let next=0, live=0, settled=false, timer;
            const children=[];
            const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);for(const c of children)c.controller.abort();};
            const abort=()=>{if(settled)return;settled=true;stop();reject(signal.reason || abortError());};
            const launch=()=>{
              if(settled || next>=urls.length)return;
              const index=next++, controller=new AbortController(), progress={started:false,lastByte:performance.now()};
              children.push({controller,progress});live++;
              attempt(urls[index],start,end,total,controller.signal,priority+(index && priority>0?10:0),epoch,progress).then(result=>{
                if(settled)return;settled=true;
                if(index>0 && epoch===generation)rescues++;
                stop();resolve(result);
              },error=>{
                live--;lastError=error;if(settled)return;
                if(next<urls.length)launch();else if(!live){settled=true;stop();reject(error);}
              });
            };
            const rescue=()=>{
              if(settled)return;
              const slow=children.find(c=>!c.controller.signal.aborted && c.progress.started && performance.now()-c.progress.lastByte>=hedgeMs);
              if(slow && live<2 && next<urls.length){
                const saturated=running.size>=limit;launch();
                if(saturated)slow.controller.abort();
              }
              timer=setTimeout(rescue,Math.max(50,hedgeMs));
            };
            signal.addEventListener('abort',abort,{once:true});
            if(signal.aborted){abort();return;}
            if(!urls.length){abort();return;}
            launch();timer=setTimeout(rescue,Math.max(50,hedgeMs));
          });
        } catch(error) { lastError=error; if(signal.aborted)throw signal.reason; }
      }
      throw lastError;
    }
    /** 半开字节区间，单次最多 16 MiB；所有子块共享连接池与截止时间。
     * @param {string} url @param {number} start @param {number} end @param {number} total
     * @param {AbortSignal} signal @param {{priority?: number}} options @returns {Promise<object>}
     */
    async function download(url,start,end,total,signal,{priority=0}={}) {
      if (!globalThis.BiliPlaybackRoutes.mediaUrl(url) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<=start || end-start>16*MiB) throw new Error('不支持的媒体范围');
      const epoch=generation, controller=new AbortController(), cancel=()=>controller.abort(signal.reason);
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();jobs.add(controller);
      const deadline=setTimeout(()=>controller.abort(new DOMException('媒体请求超时','TimeoutError')),25000);
      try {
        if(controller.signal.aborted)throw controller.signal.reason;
        let known=total || totals.get(url) || 0;
        let head=null, cursor=start;
        if(!known && end-start>256*1024){
          head=await piece(url,start,Math.min(end,start+65536),0,controller.signal,priority+20,epoch,0);
          known=head.total;cursor=start+head.bytes.length;
        }
        const target=known ? Math.min(end,known) : end;
        const parts=[];
        if(head)parts.push({start,result:head});
        const ranges=[];
        // 保留 64 KiB 小块以便局部重试，但子块数量不等于应同时开启的连接数。
        // 后台维持 256 KiB，避免普通预热制造过多小请求。
        const chunkSize = priority > 0 ? 64*1024 : 256*1024;
        for(let from=cursor;from<target;from+=chunkSize)ranges.push([from,Math.min(target,from+chunkSize)]);
        // 每个任务最多排入少量工作者，避免长视频请求把音频/后续请求淹没在队列里。
        // 真实 Chrome 实测：2 MiB 用 8 路优于盲开 32，8 MiB 则受益于 32 路。
        // 每 256 KiB 分配一个普通工作者；救援仍共享全局预算，用户较低上限优先。
        const requestConcurrency = priority > 0 ? Math.min(ceiling, Math.max(1, Math.ceil((target-start)/(256*1024)))) : ceiling;
        let next=0;
        await Promise.all(Array.from({length:Math.min(ranges.length,requestConcurrency)},async()=>{
          while(next<ranges.length){const index=next++, [from,to]=ranges[index];
            const result=await piece(url,from,to,known,controller.signal,priority,epoch,index);
            if(!known)known=result.total;
            if(result.total!==known)throw new Error('不同节点返回的文件总长不一致');
            parts.push({start:from,result});
          }
        }));
        if(controller.signal.aborted || epoch!==generation)throw controller.signal.reason || abortError();
        parts.sort((a,b)=>a.start-b.start);
        const length=Math.min(end,known)-start, bytes=new Uint8Array(length);
        let position=start;
        for(const part of parts){if(part.start!==position)throw new Error('媒体分块存在缺口');bytes.set(part.result.bytes,position-start);position+=part.result.bytes.length;}
        if(position!==start+length)throw new Error('媒体分块长度不一致');
        totals.set(url,known);
        if(priority>0){accelerated++;acceleratedBytes+=length;}
        return {bytes,total:known,contentType:parts[0].result.contentType};
      } finally {clearTimeout(deadline);controller.abort();signal.removeEventListener('abort',cancel);jobs.delete(controller);}
    }
    function tune({ahead,demand,rate=0,requiredRate=0,now=performance.now()}) {
      // 真正可播放缓冲不足 3 秒时立即拉满，不能等低吞吐样本或下个慢周期。
      if(demand && ahead<3){limit=ceiling;lastTune=now;drain();return;}
      const starving=demand && (ahead<10 || (requiredRate>0 && rate<requiredRate*1.25));
      if(now-lastTune<(starving?500:1500))return;lastTune=now;
      if(starving)limit=Math.min(ceiling,Math.max(16,limit*2));
      else if(demand && ahead<25)limit=Math.min(ceiling,limit+8);
      else if(!demand || ahead>=45)limit=Math.max(floor(),limit-4);
      drain();
    }
    function snapshot() {
      const now=performance.now(), elapsed=now-sampleAt;
      if(elapsed>=500){const rate=(receivedBytes-sampleBytes)*1000/elapsed;speed=rate>0 || running.size ? speed*.6+rate*.4 : 0;sampleAt=now;sampleBytes=receivedBytes;}
      return {active:running.size,limit,speed:Math.round(speed),receivedBytes,rescues,host:lastHost,accelerated,acceleratedBytes,nativeFallbacks,queued:pending.length,cdnMode:mode,blocked:[...health.values()].filter(h=>h.until>now).length};
    }
    function reset() {
      generation++;for(const job of jobs)job.abort(abortError());groups.clear();roles.clear();totals.clear();health.clear();
      receivedBytes=0;sampleBytes=0;speed=0;rescues=0;lastHost='';lastTune=-Infinity;sampleAt=performance.now();limit=floor();accelerated=0;acceleratedBytes=0;nativeFallbacks=0;
    }
    return {register,download,tune,snapshot,reset,role:url=>roles.get(url),total:url=>totals.get(url)||0,
      fallback(){nativeFallbacks++;}, setMode(value){mode=['mainland','auto','original'].includes(value)?value:'original';},
      setMax(value){ceiling=Math.max(1,Math.min(32,Math.floor(value)||32));limit=Math.min(ceiling,Math.max(limit,floor()));drain();}};
  }
  globalThis.BiliPlaybackNetwork={createNetwork};
})();
