import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root)) throw new Error('outside root');
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel:'chromium', headless:true });
const shots = path.join(root, '.pi/verification/popup-stability');
await mkdir(shots, { recursive: true });
try {
  const page = await browser.newPage({ viewport:{width:360,height:900} });
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto(origin + '/tests/popup-instant-integration.html');
  await page.waitForFunction(()=>document.querySelector('#result').textContent !== 'running');
  const initial=JSON.parse(await page.locator('#result').textContent()); assert.equal(initial.ok,true,JSON.stringify(initial));
  // 隐藏夹具报告，避免长 JSON 撑宽页面并改变真实 Popup 的 hover 坐标和截图。
  await page.addStyleTag({ content: "body > #result, body > #step { display: none !important; }" });
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.locator('#library-tab').click();
  await page.evaluate(()=>{
    const MiB=1024*1024, at=Date.now();
    window.taskA={id:'popup-live-a',pageId:'BV1Kg8t6NEmN:456',tabId:7,title:'实时任务 A',url:'https://www.bilibili.com/video/BV1Kg8t6NEmN/',quality:80,requestedQuality:80,codec:'avc',status:'downloading',createdAt:1000,runStartedAt:at,updatedAt:at,downloadedBytes:12*MiB,resumeBytes:8*MiB,committedBytes:8*MiB,totalBytes:16*MiB,progress:.75,speed:1024};
    window.taskB={...window.taskA,id:'popup-live-b',pageId:'other',title:'实时任务 B',createdAt:2000};
    for(const video of [window.taskA,window.taskB]){window.__popupTest.videos.push(structuredClone(video)); window.__popupTest.emit({type:'CACHE_PROGRESS',video});}
    window.beforeRows=[...document.querySelectorAll('.video-item')];
    window.saveNode=document.querySelector('.save-button:not([hidden])');
    window.saveId=window.saveNode.closest('.video-item').dataset.videoId;
    window.saveAnimations=0; window.saveNode.querySelector('.download-arrow').addEventListener('animationstart',()=>window.saveAnimations++);
  });
  const save = page.locator('.save-button:visible').first();
  await save.hover();
  await page.waitForTimeout(450);
  const stable = await page.evaluate(async()=>{
    const order=window.beforeRows.map(row=>row.dataset.videoId), durations=[];
    for(let i=0;i<32;i++){
      const video={...(i%2 ? window.taskA : window.taskB),updatedAt:Date.now()+i*500,downloadedBytes:(i%2?9:12)*1024*1024,progress:(i%2?9:12)/16,speed:[100,1023,1024,999999,1024*1024,1000*1024*1024][i%6]};
      window.__popupTest.emit({type:'CACHE_PROGRESS',video});
      await new Promise(resolve=>setTimeout(resolve,55));
    }
    const after=[...document.querySelectorAll('.video-item')];
    return {sameNodes:after.every((node,i)=>node===window.beforeRows[i]),order:after.map(row=>row.dataset.videoId),beforeOrder:order,sameSave:window.saveNode===document.querySelector(`[data-video-id="${window.saveId}"] .save-button`),animations:window.saveAnimations,hover:window.saveNode.matches(':hover'),saveText:window.saveNode.textContent.trim()};
  });
  assert(stable.sameNodes&&stable.sameSave&&stable.hover); assert.deepEqual(stable.order,stable.beforeOrder); assert.equal(stable.animations,1); assert.equal(stable.saveText,'');
  await save.focus();
  await page.waitForTimeout(800);
  assert(await page.evaluate(()=>document.activeElement===window.saveNode),'轮询不能丢失键盘焦点');
  await save.click();
  await page.evaluate(()=>window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskB,updatedAt:Date.now()+30000}}));
  assert(await save.isDisabled(),'刷新不能重置进行中的保存操作');
  await page.waitForTimeout(420); assert(!(await save.isDisabled()));
  const sizes=await page.evaluate(()=>{
    const save=window.saveNode.getBoundingClientRect(),remove=window.saveNode.closest('.video-item').querySelector('.delete-button').getBoundingClientRect();
    return {save:[save.width,save.height],remove:[remove.width,remove.height]};
  }); assert.deepEqual(sizes.save,sizes.remove);
  await page.waitForFunction(()=>document.querySelector('#toast').dataset.visible !== 'true');
  await page.locator('.app-shell').screenshot({path:path.join(shots,'library.png')});
  await page.locator('#cache-tab').click();
  const layout=await page.evaluate(()=>{
    const button=document.querySelector('#cache-button').getBoundingClientRect(),label=document.querySelector('#button-label').getBoundingClientRect(),speed=document.querySelector('#button-speed').getBoundingClientRect();
    return {label:document.querySelector('#button-label').textContent,speed:document.querySelector('#button-speed').textContent,hint:document.querySelector('#action-hint').textContent,nowrap:getComputedStyle(document.querySelector('#button-speed')).whiteSpace,noOverlap:label.right+4<=speed.left,inside:speed.right<=button.right&&speed.bottom<=button.bottom,progress:document.querySelector('#cache-button').style.getPropertyValue('--progress-ratio')};
  }); assert(layout.noOverlap&&layout.inside,JSON.stringify(layout)); assert.equal(layout.nowrap,'nowrap'); assert.equal(layout.progress,'0.5'); assert(layout.hint.startsWith('已缓存 8'),JSON.stringify(layout));
  await page.locator('.app-shell').screenshot({path:path.join(shots,'cache.png')});
  const motion=await page.evaluate(async()=>{
    window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,updatedAt:Date.now()+90000,committedBytes:12*1024*1024,downloadedBytes:12*1024*1024,resumeBytes:12*1024*1024,progress:.75}});
    const values=[];
    for(let i=0;i<10;i++){await new Promise(requestAnimationFrame); values.push(new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.button-progress')).transform).a);}
    return values;
  });
  assert(motion.some(value=>value>.501&&value<.749),'进度增长应有真实中间帧而非跳到终点');
  assert(motion.every((value,index)=>!index||value>=motion[index-1]-.00001),'确认水位增长时画面不能倒退');
  const unitLabels=await page.evaluate(()=>{
    return [999,999*1024,999*1024**2,1.23*1024**3].map((speed,index)=>{
      // 各自模拟新一代任务，绕过速度滤波的延迟，检查每个单位实际渲染的最长形态。
      window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,runStartedAt:Date.now()+100000+index,updatedAt:Date.now()+100000+index,speed}});
      const button=document.querySelector('#cache-button').getBoundingClientRect(), label=document.querySelector('#button-label').getBoundingClientRect(), node=document.querySelector('#button-speed'), rect=node.getBoundingClientRect();
      if(rect.right>button.right||rect.bottom>button.bottom||label.right+4>rect.left)throw new Error('速度单位挤压布局：'+node.textContent);
      return node.textContent;
    });
  });
  assert(unitLabels[0].includes(' B/s')&&unitLabels[1].includes(' KB/s')&&unitLabels[2].includes(' MB/s')&&unitLabels[3].includes(' GB/s'));
  await page.locator('#assist-tab').click();
  await page.locator('#assist-appearance-reset').click();
  await page.waitForTimeout(50);
  const reset=await page.evaluate(()=>({config:window.__popupTest.config,disabled:document.querySelector('#assist-preheat-controls').disabled,preview:getComputedStyle(document.querySelector('.preview-preheat')).backgroundColor}));
  assert.equal(reset.config.progressColor,'#00a1d6'); assert.equal(reset.config.preheatColor,'#ff8a1f'); assert.equal(reset.disabled,false);
  await page.locator('#assist-show-highlight').click();
  assert(await page.locator('#assist-custom-color').isDisabled(), JSON.stringify(await page.evaluate(()=>({checked:document.querySelector('#assist-show-highlight').checked,disabled:document.querySelector('#assist-preheat-controls').disabled,config:window.__popupTest.config}))));
  const colors=await page.evaluate(()=>[getComputedStyle(document.querySelector('.preview-preheat')).backgroundColor,getComputedStyle(document.querySelector('.preview-native')).backgroundColor]); assert.equal(colors[0],colors[1]);
  await page.locator('#assist-show-highlight').click();
  await page.locator('[data-assist-color][aria-checked="true"]').focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(30);
  assert.equal(await page.locator('[data-assist-color][aria-checked="true"]').count(),1);
  await page.locator('.app-shell').screenshot({path:path.join(shots,'playback.png')});
  const confirmedColor=await page.evaluate(()=>{window.__popupTest.failConfig=true; window.__popupTest.holdConfigRead=true; window.__popupTest.configDelay=80; return window.__popupTest.config.preheatColor;});
  await page.evaluate(()=>{const swatches=document.querySelectorAll('[data-assist-color]'); swatches[0].click(); swatches[3].click();});
  await page.waitForTimeout(350);
  assert.equal(await page.locator('[data-assist-color][aria-checked="true"]').getAttribute('data-assist-color'),confirmedColor,'连续两次保存失败后必须回到真实已保存配置，而不是上一次失败的乐观值');
  await page.evaluate(()=>{window.__popupTest.failConfig=false; window.__popupTest.holdConfigRead=false; window.__popupTest.configDelay=0; window.__popupTest.failSave=true;});
  await page.locator('#library-tab').click(); await save.click(); await page.waitForTimeout(400);
  assert(!(await save.isDisabled())); assert((await page.locator('#toast').textContent()).includes('模拟保存失败'));
  await page.evaluate(()=>{window.__popupTest.failSave=false;});
  await page.locator('[data-video-id="popup-live-b"] .delete-button').click(); await page.waitForTimeout(250);
  await page.evaluate(()=>window.__popupTest.emit({type:'CACHE_PROGRESS',video:window.taskB}));
  await page.waitForTimeout(850);
  assert.equal(await page.locator('[data-video-id="popup-live-b"]').count(),0,'已删除任务不能被旧消息或旧查询复活');
  await page.emulateMedia({reducedMotion:'reduce'}); await page.locator('#library-tab').click(); await save.hover();
  assert.equal(await save.locator('.download-arrow').evaluate(node=>getComputedStyle(node).animationName),'none');
  for(const fixture of ['background-popup-integration','offscreen-integration','offscreen-merge-integration']){
    await page.goto(`${origin}/tests/${fixture}.html`);
    await page.waitForFunction(()=>document.querySelector('#result').textContent !== 'running',{},{timeout:45000});
    const result=JSON.parse(await page.locator('#result').textContent()); assert.equal(result.ok,true,JSON.stringify(result));
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initialPopup:true,nodeIdentity:true,hoverAnimationStarts:stable.animations,keyboardFocus:true,pendingSavePreserved:true,symmetricActions:sizes,cacheLayout:layout,progressFrames:motion,unitLabels,mergeAndAudio:true,appearanceControls:true,configurationFailureRollback:true,saveFailureRecovery:true,deletionTombstone:true,reducedMotion:true,multiTaskBadge:true,committedWatermark:true,screenshots:shots},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
