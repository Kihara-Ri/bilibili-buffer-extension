// 减少动态效果必须直接禁止画质区过渡；0.01ms 仍会创建运行中的 CSS Transition。
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromiumLaunchOptions} from '../scripts/lib/browser-launch.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const server=createServer(async(req,res)=>{
 try{const file=path.resolve(root,'.'+new URL(req.url,'http://test').pathname);if(!file.startsWith(root+path.sep))throw new Error('outside root');const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'text/javascript');res.end(bytes);}
 catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch(chromiumLaunchOptions({headless:true}));
try{
 const page=await browser.newPage({viewport:{width:360,height:650}});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto(`http://127.0.0.1:${server.address().port}/store/scene/popup-scene.html`);
 await page.waitForFunction(()=>window.__storeScene&&document.querySelector('#quality-row').dataset.empty==='false');
 const result=await page.evaluate(()=>{
  const row=document.querySelector('#quality-row'),slider=document.querySelector('#quality-slider'),samples=[];
  for(const index of [2,3,2,3]){
   slider.value=String(index);slider.dispatchEvent(new Event('input',{bubbles:true}));
   void row.offsetWidth;
   samples.push(row.getAnimations({subtree:true}).filter(a=>a.playState==='running'||a.pending).map(a=>({type:a.constructor.name,name:a.animationName,property:a.transitionProperty,duration:a.effect.getTiming().duration})));
  }
  return {samples,top:row.dataset.top,label:document.querySelector('#quality-name').textContent};
 });
 assert.equal(result.top,'true');assert.equal(result.label,'4K');
 assert(result.samples.every(sample=>sample.length===0),'减少动态效果仍创建动画/过渡：'+JSON.stringify(result.samples));
 // 默认动态模式保留正常的浪和登顶反馈，减少动态的修复不得把所有状态一并禁用。
 await page.emulateMedia({reducedMotion:'no-preference'});
 const normal=await page.evaluate(()=>{
  const slider=document.querySelector('#quality-slider'),row=document.querySelector('#quality-row');
  slider.value='2';slider.dispatchEvent(new Event('input',{bubbles:true}));void row.offsetWidth;
  slider.value='3';slider.dispatchEvent(new Event('input',{bubbles:true}));void row.offsetWidth;
  return row.getAnimations({subtree:true}).map(a=>a.animationName).filter(Boolean);
 });
 assert(normal.includes('quality-tide')&&normal.includes('surge-sweep'),JSON.stringify(normal));
 await page.emulateMedia({reducedMotion:'reduce'});
 await mkdir(path.join(root,'.tmp/repair'),{recursive:true});
 await page.locator('.quality-row').screenshot({path:path.join(root,'.tmp/repair/quality-reduced-motion.png')});
 console.log(JSON.stringify({ok:true,reducedMotion:result,normalMotion:normal}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
