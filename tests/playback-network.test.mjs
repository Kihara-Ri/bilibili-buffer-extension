import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-network.js';
const { createNetwork, mediaUrl, BACKGROUND_PIECE } = globalThis.BiliPlaybackNetwork;
const KiB = 1024, MiB = 1024 * KiB;
const primary = 'https://a.bilivideo.com/video.m4s?sign=secret';
const backup = 'https://b.bilivideo.com/video.m4s?sign=secret';
const manifest = { data: { dash: { video: [{ baseUrl: primary, backupUrl: [backup, 'https://evil.example/media.m4s'] }] } } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const byteAt = i => (i * 7 + 3) & 0xff;
const bodyFor = (a, b) => Uint8Array.from({ length: b - a + 1 }, (_, i) => byteAt(a + i));
const rangeOf = init => { const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range); return [+a, +b]; };
const reply = (a, b, total) => new Response(bodyFor(a, b), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${total}`, 'content-type': 'video/mp4' } });
const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
const signal = () => new AbortController().signal;
function assertBytes(bytes, start) { for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], byteAt(start + i), `第 ${start + i} 字节`); }

/** 记录每个真实请求，并发计数只算正在等待响应/正文的请求。 */
function server(total, { wait = 5, onRequest } = {}) {
  const log = { requests: [], active: 0, peak: 0 };
  const fetch = async (url, init) => {
    const [a, b] = rangeOf(init);
    log.requests.push({ url, a, b, priority: init.priority });
    log.active++; log.peak = Math.max(log.peak, log.active);
    try {
      const custom = await onRequest?.(url, init, a, b);
      if (custom) return custom;
      await delay(wait);
      if (init.signal.aborted) throw init.signal.reason;
      return reply(a, Math.min(b, total - 1), total);
    } finally { log.active--; }
  };
  return { fetch, log };
}

test('只接受权限内的 HTTPS 媒体地址；清单里的非法备用地址被丢弃，统计不泄露签名', async () => {
  assert.equal(mediaUrl('https://evil.example/media.m4s'), null);
  assert.equal(mediaUrl('http://a.bilivideo.com/v.m4s'), null);
  assert.equal(mediaUrl(primary), primary);
  const { fetch, log } = server(4, { onRequest: url => url === primary ? new Response('x', { status: 403 }) : null });
  const network = createNetwork({ fetch });
  network.register(manifest);
  const result = await network.get(primary, 0, 4, { signal: signal() });
  assertBytes(result.bytes, 0);
  assert.deepEqual(log.requests.map(r => r.url), [primary, backup]);
  assert(!JSON.stringify(network.snapshot()).includes('secret'));
});

test('播放器急需范围拆成约 16 片并行下载，按位置重组，每片落地即回调写缓存', async () => {
  const total = 4 * MiB, pieces = [];
  const { fetch, log } = server(total);
  const network = createNetwork({ fetch, onPiece: (url, start, bytes, size) => pieces.push([start, bytes.length, size]) });
  const result = await network.get(primary, 0, 2 * MiB, { signal: signal(), total });
  assert.equal(result.bytes.length, 2 * MiB); assertBytes(result.bytes, 0);
  assert.equal(log.requests.length, 16);
  assert.equal(log.peak, 16);
  assert(log.requests.every(r => r.priority === 'high'));
  assert.equal(pieces.length, 16);
  assert(pieces.every(([, length, size]) => length === 128 * KiB && size === total));
});

test('后台分片受槽位约束；播放器请求不排在后台之后', async () => {
  const total = 64 * MiB;
  const { fetch, log } = server(total, { wait: 30 });
  const network = createNetwork({ fetch, backgroundSlots: 4 });
  assert.equal(network.prefetch(primary, 0, 8 * BACKGROUND_PIECE, { total }), 8);
  await delay(5);
  assert.equal(log.active, 4, '后台最多占 4 个槽位');
  const urgent = network.get(primary, 32 * MiB, 32 * MiB + 256 * KiB, { signal: signal(), total });
  await delay(5);
  assert(log.active > 4, '急需请求不受后台槽位约束');
  assertBytes((await urgent).bytes, 32 * MiB);
  await delay(200);
  assert.equal(log.requests.filter(r => r.priority === 'low').length, 8);
  assert.equal(network.backgroundPending(), 0);
});

test('播放器请求复用在途后台分片：不重复下载，后台分片升为急需', async () => {
  const total = 4 * MiB;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, log } = server(total, { onRequest: async () => { await gate; } });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, BACKGROUND_PIECE, { total });
  await delay(5);
  const demand = network.get(primary, 1000, 3000, { signal: signal(), total });
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE]]);
  release();
  const result = await demand;
  assertBytes(result.bytes, 1000);
  assert.equal(log.requests.length, 1, '同一段只请求一次');
});

test('播放器放弃后：只为它新建的分片立即取消，后台分片继续填充前方窗口', async () => {
  const total = 4 * MiB;
  const aborted = [];
  const { fetch } = server(total, { onRequest: (url, init, a) => hang(init).catch(error => { aborted.push(a); throw error; }) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, BACKGROUND_PIECE, { total });
  const controller = new AbortController();
  const demand = network.get(primary, 0, BACKGROUND_PIECE + 64 * KiB, { signal: controller.signal, total });
  await delay(5);
  controller.abort();
  await assert.rejects(demand, { name: 'AbortError' });
  await delay(5);
  assert.deepEqual(aborted, [BACKGROUND_PIECE], '只取消急需的新分片');
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE]]);
  network.reset();
});

test('慢节点触发对冲：备用地址先完成即胜出，原请求在胜负揭晓前不被取消', async () => {
  let primaryAbortedAt = null, hedgeStartedAt = null;
  const { fetch } = server(4, { onRequest: (url, init) => {
    if (url === backup) { hedgeStartedAt = performance.now(); return null; }
    return hang(init).catch(error => { primaryAbortedAt = performance.now(); throw error; });
  } });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  network.register(manifest);
  const result = await network.get(primary, 0, 4, { signal: signal() });
  assertBytes(result.bytes, 0);
  await delay(5);
  assert(hedgeStartedAt !== null && primaryAbortedAt >= hedgeStartedAt, '对冲开始后原请求仍在途');
  assert.equal(network.snapshot().rescues, 1);
  assert.equal(network.snapshot().host, 'b.bilivideo.com');
  assert.equal(network.snapshot().active, 0);
});

test('正文停滞同样触发对冲，不必等到超时', async () => {
  const { fetch } = server(4, { onRequest: url => url === backup ? null
    : new Response(new ReadableStream({ start() {} }), { status: 206, headers: { 'content-range': 'bytes 0-3/4' } }) });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  network.register(manifest);
  assertBytes((await network.get(primary, 0, 4, { signal: signal() })).bytes, 0);
});

test('只有一个地址时对冲仍可在同一地址再发一份', async () => {
  let calls = 0;
  const { fetch } = server(4, { onRequest: (url, init) => (++calls === 1 ? hang(init) : null) });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  assertBytes((await network.get(primary, 0, 4, { signal: signal() })).bytes, 0);
  assert.equal(calls, 2);
});

test('范围或总长校验失败的响应不交付；全部节点失败后整体拒绝并计入后台错误', async () => {
  const { fetch } = server(4, { onRequest: (url, init, a, b) => reply(a, b, 5) });
  const errors = [];
  const network = createNetwork({ fetch, onPieceError: (url, urgent) => errors.push(urgent) });
  await assert.rejects(network.get(primary, 0, 4, { signal: signal(), total: 4 }), /校验/);
  network.prefetch(primary, 0, 4, { total: 4 });
  await delay(2000);
  assert.deepEqual(errors, [true, false]);
  assert.equal(network.snapshot().prefetchErrors, 1);
});

test('拖动后只取消不再需要且无人等待的后台分片', async () => {
  const total = 64 * MiB;
  const { fetch } = server(total, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, 4 * BACKGROUND_PIECE, { total });
  network.pruneBackground((url, start) => start < 2 * BACKGROUND_PIECE);
  await delay(5);
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE], [BACKGROUND_PIECE, 2 * BACKGROUND_PIECE]]);
  network.reset();
});

test('reset 取消全部在途与排队请求，旧世代结果不回调、不计统计', async () => {
  const total = 64 * MiB, pieces = [];
  const { fetch } = server(total, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch, maxSlots: 2, onPiece: () => pieces.push(1) });
  const jobs = [network.get(primary, 0, MiB, { signal: signal(), total })];
  network.prefetch(primary, 2 * MiB, 4 * MiB, { total });
  await delay(5);
  network.reset();
  assert((await Promise.allSettled(jobs)).every(r => r.status === 'rejected'));
  await delay(5);
  assert.deepEqual(pieces, []);
  assert.equal(network.snapshot().receivedBytes, 0);
  assert.equal(network.snapshot().active, 0);
  assert.equal(network.backgroundPending(), 0);
});

test('超过 16 MiB 或非法范围直接拒绝，交还原生请求', async () => {
  const network = createNetwork({ fetch: async () => { throw new Error('不应请求'); } });
  await assert.rejects(network.get(primary, 0, 17 * MiB, { signal: signal() }), /不支持/);
  await assert.rejects(network.get('https://evil.example/a.m4s', 0, 4, { signal: signal() }), /不支持/);
  assert.equal(network.prefetch('https://evil.example/a.m4s', 0, 4), 0);
});

test('分片在槽位授予后、尝试开始前被取消：立即归还槽位，不发出请求', async () => {
  const { fetch, log } = server(64 * MiB, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, 2 * BACKGROUND_PIECE, { total: 64 * MiB });
  network.pruneBackground(() => false);
  await delay(5);
  assert.equal(log.requests.length, 0);
  assert.equal(network.snapshot().active, 0);
  assert.equal(network.backgroundPending(), 0);
});

// ---- 代码审查发现的问题（先复现再修复） ----

test('对冲胜出后，输给副本的慢节点降级，后续分片改走更快的节点', async () => {
  let primaryCalls = 0;
  const { fetch, log } = server(4 * MiB, { onRequest: async (url, init) => {
    // 备用节点本身比主节点慢一些，只凭历史成绩排序时主节点永远排第一。
    if (url !== primary) { await delay(40); return null; }
    // 主节点第一次很快（建立「好成绩」），之后开始卡住不出首字节。
    return ++primaryCalls === 1 ? null : hang(init);
  } });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  network.register(manifest);
  await network.get(primary, 0, 4, { signal: signal() });
  await network.get(primary, 4, 8, { signal: signal() });
  const before = log.requests.length;
  await network.get(primary, 8, 12, { signal: signal() });
  assert.equal(log.requests[before].url, backup, '慢节点不能凭旧成绩继续排第一');
  network.reset();
});

test('急需分片全部失败时尽快交还原生请求：不在最后一轮之后再白等', async () => {
  const { fetch } = server(4, { onRequest: () => new Response('no', { status: 403 }) });
  const network = createNetwork({ fetch });
  network.register(manifest);
  const began = performance.now();
  await assert.rejects(network.get(primary, 0, 4, { signal: signal() }));
  assert(performance.now() - began < 1000, `耗时 ${Math.round(performance.now() - began)} ms`);
});

test('播放器放弃后，被它升为急需的后台分片恢复后台身份', async () => {
  const { fetch } = server(64 * MiB, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, BACKGROUND_PIECE, { total: 64 * MiB });
  const controller = new AbortController();
  const demand = network.get(primary, 0, 1000, { signal: controller.signal, total: 64 * MiB });
  assert.equal(network.backgroundPending(), 0, '播放器在等时按急需计');
  controller.abort();
  await assert.rejects(demand);
  assert.equal(network.backgroundPending(), 1, '没人等了就回到后台，计入排队深度');
  network.reset();
});

test('预热覆盖到在途的急需分片时接管它：播放器放弃后分片继续下载，不留空洞', async () => {
  const { fetch } = server(64 * MiB, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  const controller = new AbortController();
  const demand = network.get(primary, 0, 256 * KiB, { signal: controller.signal, total: 64 * MiB });
  const urgentPieces = network.inflightRanges(primary).length;
  assert.equal(network.prefetch(primary, 0, 256 * KiB, { total: 64 * MiB }), 0, '不重复下载');
  controller.abort();
  await assert.rejects(demand);
  assert.equal(network.inflightRanges(primary).length, urgentPieces, '被预热接管的分片不能随播放器一起取消');
  network.reset();
});

test('救援次数只统计对冲副本胜出，普通的失败换节点不算', async () => {
  const { fetch } = server(4, { onRequest: url => url === primary ? new Response('no', { status: 503 }) : null });
  const network = createNetwork({ fetch });
  network.register(manifest);
  await network.get(primary, 0, 4, { signal: signal() });
  assert.equal(network.snapshot().rescues, 0);
});

test('全部普通槽位等待首字节时，救援仍能启动而非等到 8 秒超时', async () => {
  const { fetch, log } = server(4096, { onRequest: (url, init) => url === primary ? hang(init) : null });
  const network = createNetwork({ fetch, maxSlots: 2, hedgeMs: 30, firstByteMs: 1500 });
  network.register(manifest);
  const jobs = [network.get(primary, 0, 4, { signal: signal() }), network.get(primary, 4, 8, { signal: signal() })];
  const completion = Promise.all(jobs);
  try {
    const result = await Promise.race([completion, delay(650).then(() => null)]);
    assert(result, '槽位被无首字节请求占满时，对冲不能饿死');
    assertBytes(result[1].bytes, 4);
    assert(log.peak <= 4, '普通 2 槽外只允许 2 个有界救援槽');
  } finally { network.reset(); await completion.catch(() => {}); }
});

const mirrorSource = 'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/02/test.m4s?deadline=9999999999&sign=secret';
const hw = mirrorSource.replace('upos-hz-mirrorakam.akamaized.net', 'upos-sz-mirrorhw.bilivideo.com');
const ali = mirrorSource.replace('upos-hz-mirrorakam.akamaized.net', 'upos-sz-mirrorali.bilivideo.com');

test('健康原线路不探测镜像；原线路失败后校验文件头再使用额外 CDN', async () => {
  let failed = false;
  const { fetch, log } = server(4096, { onRequest: url => url === mirrorSource && failed ? new Response('no', { status: 503 }) : null });
  const network = createNetwork({ fetch });
  network.register({ data: { dash: { video: [{ baseUrl: mirrorSource }] } } });
  assertBytes((await network.get(mirrorSource, 0, 1024, { signal: signal(), total: 4096 })).bytes, 0);
  assert.deepEqual(log.requests.map(r => r.url), [mirrorSource], '健康线路没有探针流量');
  failed = true;
  try {
    const result = await network.get(mirrorSource, 2048, 3072, { signal: signal(), total: 4096 });
    assertBytes(result.bytes, 2048);
    assert(log.requests.some(r => r.url === hw && r.a === 0 && r.b === 1023), '镜像需先取得相同初始化指纹');
    assert.equal(network.snapshot().host, 'upos-sz-mirrorhw.bilivideo.com');
    assert(!JSON.stringify(network.snapshot()).includes('secret'));
  } finally { network.reset(); }
});

test('同总长但文件头不一致的镜像不得交付媒体；继续下一条 CDN', async () => {
  let failed = false;
  const { fetch, log } = server(4096, { onRequest: (url, _init, a, b) => {
    if(url === mirrorSource && failed) return new Response('no', {status:503});
    if(url === hw) return new Response(new Uint8Array(b-a+1).fill(255), {status:206,headers:{'content-range':`bytes ${a}-${b}/4096`}});
    return null;
  } });
  const network = createNetwork({ fetch });
  network.register({data:{dash:{video:[{baseUrl:mirrorSource}]}}});
  await network.get(mirrorSource,0,1024,{signal:signal(),total:4096}); failed=true;
  try {
    assertBytes((await network.get(mirrorSource,2048,3072,{signal:signal(),total:4096})).bytes,2048);
    assert(!log.requests.some(r=>r.url===hw&&r.a===2048),'不一致镜像不能进入媒体下载');
    assert(log.requests.some(r=>r.url===ali));
  } finally {network.reset();}
});

test('取消正在共享镜像校验的请求立即释放自己的槽位，不等另一个请求的探针', async () => {
  let failed=false, release, observed;
  const gate=new Promise(r=>{release=r;}), began=new Promise(r=>{observed=r;});
  const {fetch}=server(4096,{onRequest:async(url,_init,a)=>{
    if(url===mirrorSource&&failed)return new Response('no',{status:503});
    if(url===hw&&a===0){observed();await gate;}
  }});
  const network=createNetwork({fetch});network.register({data:{dash:{video:[{baseUrl:mirrorSource}]}}});
  await network.get(mirrorSource,0,1024,{signal:signal(),total:4096});failed=true;
  const first=network.get(mirrorSource,2048,2304,{signal:signal(),total:4096});
  const controller=new AbortController();let second;
  try{
    await began;
    second=network.get(mirrorSource,3072,3328,{signal:controller.signal,total:4096});second.catch(()=>{});
    await delay(10);controller.abort();await assert.rejects(second,{name:'AbortError'});await delay(5);
    assert.equal(network.snapshot().active,1,'只应剩下首个请求持有的校验槽');
  }finally{release();await first.catch(()=>{});network.reset();}
});

test('所有候选无响应时急需请求有总等待上限，归还原生路径且取消自建分片', async () => {
  const {fetch}=server(4096,{onRequest:(_url,init)=>hang(init)});
  const network=createNetwork({fetch,hedgeMs:10,firstByteMs:1000,demandTimeoutMs:60});network.register(manifest);
  const outcome=network.get(primary,0,4,{signal:signal(),total:4096});outcome.catch(()=>{});
  try{
    const result=await Promise.race([outcome.then(()=> 'success',e=>e.name),delay(180).then(()=> 'still waiting')]);
    assert.equal(result,'TimeoutError','新增候选不能成倍延长播放器总等待');
    await delay(5);assert.equal(network.snapshot().active,0);assert.deepEqual(network.inflightRanges(primary),[]);
  }finally{network.reset();await outcome.catch(()=>{});}
});

test('共享镜像校验的发起者取消，其他有效请求仍可使用同一候选', async () => {
  let failed=false, observed;const began=new Promise(r=>{observed=r;});
  const {fetch}=server(4096,{onRequest:async(url,init,a)=>{
    if(!failed)return null;
    if(url===mirrorSource)return new Response('no',{status:503});
    if(url===hw&&a===0){observed();await new Promise((resolve,reject)=>{const t=setTimeout(resolve,80);init.signal.addEventListener('abort',()=>{clearTimeout(t);reject(init.signal.reason);},{once:true});});return null;}
    if(url===hw)return null;
    return hang(init);
  }});
  const network=createNetwork({fetch,demandTimeoutMs:350,firstByteMs:1000});network.register({data:{dash:{video:[{baseUrl:mirrorSource}]}}});
  await network.get(mirrorSource,0,1024,{signal:signal(),total:4096});failed=true;
  const controller=new AbortController(),first=network.get(mirrorSource,2048,2304,{signal:controller.signal,total:4096});first.catch(()=>{});
  try{
    await began;const second=network.get(mirrorSource,3072,3328,{signal:signal(),total:4096});
    await delay(10);controller.abort();await assert.rejects(first,{name:'AbortError'});
    assertBytes((await second).bytes,3072);assert.equal(network.snapshot().host,'upos-sz-mirrorhw.bilivideo.com');
  }finally{network.reset();}
});

test('主备都不出首字节时轮换停滞备用，保留原请求并让额外镜像及时接手', async () => {
  const nativeBackup=mirrorSource.replace('upos-hz-mirrorakam.akamaized.net','upos-sz-mirrorcosov.bilivideo.com');let failed=false;
  const {fetch}=server(4096,{onRequest:(url,init)=>failed&&[mirrorSource,nativeBackup].includes(url)?hang(init):null});
  const network=createNetwork({fetch,hedgeMs:20,firstByteMs:2000,demandTimeoutMs:1000});
  network.register({data:{dash:{video:[{baseUrl:mirrorSource,backupUrl:[nativeBackup]}]}}});
  await network.get(mirrorSource,0,1024,{signal:signal(),total:4096});failed=true;
  try{assertBytes((await network.get(mirrorSource,2048,3072,{signal:signal(),total:4096})).bytes,2048);assert.equal(network.snapshot().host,'upos-sz-mirrorhw.bilivideo.com');}
  finally{network.reset();}
});

test('最后一个镜像校验等待者取消时，独立探针与排队均被释放', async () => {
 let failed=false,observed;const began=new Promise(r=>{observed=r;});
 const {fetch}=server(4096,{onRequest:(url,init)=>{if(!failed)return null;if(url===mirrorSource)return new Response('no',{status:503});observed();return hang(init);}});
 const network=createNetwork({fetch});network.register({data:{dash:{video:[{baseUrl:mirrorSource}]}}});
 await network.get(mirrorSource,0,1024,{signal:signal(),total:4096});failed=true;
 const controller=new AbortController(),job=network.get(mirrorSource,2048,2304,{signal:controller.signal,total:4096});job.catch(()=>{});
 try{await began;controller.abort();await assert.rejects(job,{name:'AbortError'});await delay(5);assert.equal(network.snapshot().active,0);assert.equal(network.snapshot().queued,0);}
 finally{network.reset();}
});

test('后台镜像校验排队后被播放器复用，优先级随分片提升而立即启动', async () => {
 const blocker='https://block.bilivideo.com/block.m4s';let failed=false,scheduled=false,network;
 const {fetch}=server(4096,{onRequest:(url,init)=>{
  if(url===blocker)return hang(init);
  if(failed&&url===mirrorSource){if(!scheduled){scheduled=true;network.prefetch(blocker,0,256,{total:4096});}return new Response('no',{status:503});}
 }});
 network=createNetwork({fetch,backgroundSlots:1,demandTimeoutMs:300});network.register({data:{dash:{video:[{baseUrl:mirrorSource}]}}});
 await network.get(mirrorSource,0,1024,{signal:signal(),total:4096});failed=true;
 network.prefetch(mirrorSource,2048,2304,{total:4096});
 try{await delay(25);assert.equal(network.snapshot().queued,1);assertBytes((await network.get(mirrorSource,2048,2304,{signal:signal(),total:4096})).bytes,2048);}
 finally{network.reset();}
});

test('首次并发探测总长未知时，异总长分片不能混入缓存或拼装响应', async () => {
  const writes=[];
  const {fetch}=server(4*MiB,{onRequest:(_url,_init,a,b)=>reply(a,b,a===0?4*MiB:8*MiB)});
  const network=createNetwork({fetch,onPiece:(_url,start,_bytes,total)=>writes.push({start,total})});
  try{
    await assert.rejects(network.get(primary,0,128*KiB,{signal:signal()}),/总长|范围校验/);
    assert(writes.every(w=>w.total===4*MiB),'错误长度的分片不能先进入驻留缓存');
  }finally{network.reset();}
});

test('超出安全整数范围的 Content-Range 总长必须拒绝，不能交付错误元数据', async () => {
  let writes=0;
  const fetch=async()=>new Response(new Uint8Array([1,2,3,4]),{status:206,headers:{'content-range':'bytes 0-3/9007199254740993'}});
  const network=createNetwork({fetch,onPiece:()=>writes++});
  try{await assert.rejects(network.get(primary,0,4,{signal:signal()}),/范围校验/);assert.equal(writes,0);}
  finally{network.reset();}
});

for(const updateAt of ['primary','backup'])test(`清单在 ${updateAt} 请求中更新时，不得让旧候选跳过校验或写缓存`,async()=>{
 const origin=mirrorSource.replace('sign=secret','sign=primary');
 const oldBackup=mirrorSource.replace('upos-hz-mirrorakam.akamaized.net','upos-sz-mirrorcosov.bilivideo.com').replace('sign=secret','sign=backup');
 const staleMirror=oldBackup.replace('upos-sz-mirrorcosov.bilivideo.com','upos-sz-mirrorhw.bilivideo.com');
 const writes=[],requests=[];let updated=false,network;
 network=createNetwork({onPiece:(_u,_a,body)=>writes.push(body[0]),fetch:async(url,init)=>{
  const [a,b]=rangeOf(init);requests.push({url,a});
  if(!updated&&url===(updateAt==='primary'?origin:oldBackup)){
   updated=true;network.register({dash:{video:[{baseUrl:origin}]}});network.seedReference(origin,new Uint8Array(1024).fill(7),4096);
   if(updateAt==='backup')return new Response(new Uint8Array(b-a+1).fill(255),{status:206,headers:{'content-range':`bytes ${a}-${b}/4096`}});
  }
  if(url===staleMirror)return new Response(new Uint8Array(b-a+1).fill(255),{status:206,headers:{'content-range':`bytes ${a}-${b}/4096`}});
  return new Response('no',{status:503});
 }});
 network.register({dash:{video:[{baseUrl:origin,backupUrl:[oldBackup]}]}});network.seedReference(origin,new Uint8Array(1024).fill(7),4096);
 try{await assert.rejects(network.get(origin,2048,2304,{signal:signal(),total:4096}));assert.deepEqual(writes,[]);assert(!requests.some(r=>r.url===staleMirror&&r.a===2048));}
 finally{network.reset();}
});

test('清单修订后能重新选择健康候选，旧轮次作废不应隔离正常节点',async()=>{
 let network,changed=false;const writes=[];
 network=createNetwork({onPiece:(_u,_a,body)=>writes.push(body[0]),fetch:async(url,init)=>{
  const [a,b]=rangeOf(init);
  if(!changed){changed=true;network.register({dash:{video:[{baseUrl:mirrorSource,backupUrl:[backup]}]}});return new Response(new Uint8Array(b-a+1).fill(255),{status:206,headers:{'content-range':`bytes ${a}-${b}/4096`}});}
  return reply(a,b,4096);
 }});
 network.register({dash:{video:[{baseUrl:mirrorSource}]}});
 try{assertBytes((await network.get(mirrorSource,2048,2304,{signal:signal(),total:4096})).bytes,2048);assert.deepEqual(writes,[byteAt(2048)]);assert.equal(network.snapshot().blocked,0);assert.equal(network.snapshot().active,0);}
 finally{network.reset();}
});
