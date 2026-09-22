import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createChromeEvaluator} from '../scripts/lib/existing-chrome.mjs';
const [pid,tab]=process.argv.slice(2),evaluate=createChromeEvaluator(pid,tab);
const client=await readFile(new URL('../src/request-budget-client.js',import.meta.url),'utf8');
const broker=(await readFile(new URL('../src/request-budget.js',import.meta.url),'utf8')).replaceAll('export ','');
const code=String.raw`(()=>{
 const previous=globalThis.BiliRequestBudget;${client}
 ${broker}
 const result=window.__biliBudgetProbe={state:'running'};
 void(async()=>{const ports=[];try{
  let saved={},active=0,peak=0;
  const service=createBudgetService({get:async()=>structuredClone(saved),set:async v=>{saved=structuredClone(v);}},async()=>2);
  const make=owner=>{
   const channel=new MessageChannel(),pending=new Map();ports.push(channel.port1,channel.port2);
   channel.port1.onmessage=async e=>{try{channel.port1.postMessage({id:e.data.id,value:{ok:true,...await service(e.data.request,owner)}});}catch(error){channel.port1.postMessage({id:e.data.id,value:{ok:false}});}};
   channel.port2.onmessage=e=>{const finish=pending.get(e.data.id);pending.delete(e.data.id);finish(e.data.value);};
   const rpc=request=>new Promise(resolve=>{const id=crypto.randomUUID();pending.set(id,resolve);channel.port2.postMessage({id,request});});
   return BiliRequestBudget.createBudgetFetch(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,40));active--;return new Response(new Uint8Array([1,2,3,4]));},rpc);
  };
  const a=make('page:one'),b=make('offscreen');
  const bytes=await Promise.all([a,b,a,b,a,b].map(f=>f('https://probe.test',{priority:f===a?'high':'low'}).then(r=>r.arrayBuffer())));
  await new Promise(r=>setTimeout(r,200));
  result.peak=peak;result.leases=saved.requestBudgetV1.leases.length;result.bytes=bytes.map(b=>Array.from(new Uint8Array(b)));result.state='done';
 }catch(error){result.state='error';result.error=error.message;}finally{for(const port of ports)port.close();globalThis.BiliRequestBudget=previous;}})();
 return 'started';
})();`;
new Function(code);assert.equal(await evaluate(code),'started');let result;
for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,200));result=JSON.parse(await evaluate('JSON.stringify(window.__biliBudgetProbe)'));if(result.state!=='running')break;}
assert.equal(result.state,'done',result.error);assert(result.peak<=2);assert.equal(result.leases,0);assert(result.bytes.every(b=>JSON.stringify(b)==='[1,2,3,4]'));
console.log(JSON.stringify({ok:true,kind:'existing-chrome-message-channel-probe',peak:result.peak,leases:result.leases,requests:result.bytes.length}));
