import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const sources=await Promise.all(['playback-cache','playback-network','playback-observer'].map(name=>readFile(new URL(`../src/${name}.js`,import.meta.url),'utf8')));
const source='https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/test.m4s?sign=test';
const backup='https://backup.bilivideo.com/upgcxcode/1/2/test.m4s?sign=test';
const hw=source.replace('upos-hz-mirrorakam.akamaized.net','upos-sz-mirrorhw.bilivideo.com');
const total=2*1024*1024,prefix=65536;
const bytes=(a,b)=>Uint8Array.from({length:b-a},(_,i)=>(a+i)&255);

/** 只替换离线服务与 HTTP 边界；缓存、范围拼装、候选调度和取消均运行生产实现。 */
function setup({offlineHead=true,reuseRead}={}){
 let fail=false;const requests=[],listeners=new Map();
 class Storage{getItem(){return null;}setItem(){}removeItem(){}}
 class Xhr{addEventListener(){}getResponseHeader(){return null;}open(){}send(){}setRequestHeader(){}}
 const video={duration:100,currentTime:0,paused:false,buffered:{length:0},addEventListener(){}};
 const document={nodeType:9,documentElement:{dataset:{}},hidden:false,addEventListener(){},querySelectorAll:s=>s==='video'?[video]:[]};
 const window={Storage,XMLHttpRequest:Xhr,addEventListener(type,fn){listeners.set(type,fn);},postMessage(){},fetch:async(url,init)=>{
  const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);requests.push({url,start:+a,end:+b});
  if(fail&&[source,backup].includes(url))return new Response('no',{status:503});
  return new Response(bytes(+a,+b+1),{status:206,headers:{'content-range':`bytes ${a}-${b}/${total}`}});
 }};window.window=window;
 const location={href:'https://www.bilibili.com/video/BVtest/'};
 const context=vm.createContext({window,document,localStorage:new Storage(),location,URL,Headers,Response,Request,ReadableStream,Uint8Array,DataView,ArrayBuffer,Blob,DOMException,AbortController,performance,queueMicrotask,
  // 由用例显式触发请求，避免异步预热抢先取回待测范围；真实请求的超时照常运行。
  setTimeout:(fn,ms)=>ms===0?0:setTimeout(fn,ms),clearTimeout,setInterval(){},clearInterval(){},MutationObserver:class{observe(){}}});
 vm.runInContext(sources[0],context);vm.runInContext(sources[1],context);window.BiliPlaybackNetwork=context.BiliPlaybackNetwork;
 if(offlineHead){window.BiliPlaybackReuse={notePlayurl(){return 1;},totalHint(){return total;},createReuseClient(){return {read:reuseRead||(async r=>r.start===0&&r.end===prefix?{body:bytes(0,prefix),total,contentType:'video/mp4'}:null)};}};context.BiliPlaybackReuse=window.BiliPlaybackReuse;}
 vm.runInContext(sources[2],context);
 const i=window.__biliBufferPlaybackAssistInternals;i.cfg.mode='always';i.network.register({dash:{video:[{baseUrl:source}]}});
 return {i,requests,location,config(mode){listeners.get('message')({source:window,data:{channel:'bili-buffer-playback-assist-v1',dir:'ext->page',type:'config',payload:{mode}}});},cache:window.__biliBufferCache,fail(){fail=true;},load:(a,b,signal=new AbortController().signal)=>i.loadPlayerRange(source,`bytes=${a}-${b-1}`,signal),stop(){i.cfg.mode='off';i.network.reset();}};
}

for(const refresh of [false,true])test(`原地址文件头命中离线缓存后仍能启用镜像救援${refresh?'（清单更新备用地址）':''}`,async()=>{
 const s=setup();
 try{
  await s.load(0,prefix);assert.equal(s.requests.length,0);assert.equal(s.i.stats.reuseHits,1);
  if(refresh)s.i.network.register({dash:{video:[{baseUrl:source,backupUrl:[backup]}]}});
  s.fail();const result=await s.load(prefix+4096,prefix+5120);
  assert.deepEqual(result.body,bytes(prefix+4096,prefix+5120));
  assert(s.requests.some(r=>r.url===hw),'可复用的原始头应让健康镜像参与救援');
 }finally{s.stop();}
});

test('不足 1 KiB 的原始初始化分片与后续缓存拼成完整头后可启用镜像',async()=>{
 const s=setup({offlineHead:false});
 try{
  await s.load(0,512);await s.load(512,2048);s.fail();
  assert.deepEqual((await s.load(4096,5120)).body,bytes(4096,5120));
  assert(s.requests.some(r=>r.url===hw));
 }finally{s.stop();}
});

for(const action of ['abort','toggle','navigation'])test(`离线复用返回命中前发生 ${action}，迟到字节不能回填或启用镜像`,async()=>{
 let reply;const pending=new Promise(r=>{reply=r;}),s=setup({reuseRead:()=>pending});
 const controller=new AbortController();const result=s.load(0,prefix,controller.signal);
 try{
  if(action==='abort')controller.abort();
  if(action==='toggle'){s.config('off');s.config('always');}
  if(action==='navigation'){s.location.href='https://www.bilibili.com/video/BVnext/';s.i.resetTracksAfterNavigation();}
  reply({body:bytes(0,prefix),total,contentType:'video/mp4'});
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(s.cache.ranges(source).length,0);assert.equal(s.i.stats.reuseHits,0);assert.equal(s.requests.length,0);
 }finally{s.stop();}
});
