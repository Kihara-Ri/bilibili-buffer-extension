import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { chromiumLaunchOptions } from '../scripts/lib/browser-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root)) throw new Error('outside root');
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/javascript'); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
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
  await page.locator('#current-tab').click();
  const layout=await page.evaluate(()=>{
    const button=document.querySelector('#cache-button').getBoundingClientRect(),label=document.querySelector('#button-label').getBoundingClientRect(),speed=document.querySelector('#button-speed').getBoundingClientRect();
    return {label:document.querySelector('#button-label').textContent,speed:document.querySelector('#button-speed').textContent,hint:document.querySelector('#action-hint').textContent,sub:document.querySelector('#button-sub').textContent,nowrap:getComputedStyle(document.querySelector('#button-speed')).whiteSpace,noOverlap:label.right+4<=speed.left,inside:speed.right<=button.right&&speed.bottom<=button.bottom,progress:document.querySelector('#cache-button').style.getPropertyValue('--progress-ratio')};
  }); assert(layout.noOverlap&&layout.inside,JSON.stringify(layout)); assert.equal(layout.nowrap,'nowrap'); assert.equal(layout.progress,'0.5'); assert(/^8(\.\d+)? MB \/ /.test(layout.sub)&&layout.hint==='',JSON.stringify(layout));
  // 暂停在主按钮内部右侧：不得盖住速度文字，也不得超出按钮；画质滑杆在进度刷新中保持节点身份，下载中不能换档。
  const inButton=await page.evaluate(async()=>{
    const button=document.querySelector('#cache-button').getBoundingClientRect(),pause=document.querySelector('#pause-button'),pr=pause.getBoundingClientRect(),speed=document.querySelector('#button-speed').getBoundingClientRect();
    const before=[document.querySelector('#quality-slider'),...document.querySelectorAll('#quality-stops .quality-stop')];
    window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,updatedAt:Date.now()+50000}});
    await new Promise(resolve=>setTimeout(resolve,80));
    const after=[document.querySelector('#quality-slider'),...document.querySelectorAll('#quality-stops .quality-stop')];
    return {visible:!pause.hidden,inside:pr.left>=button.left&&pr.right<=button.right&&pr.top>=button.top&&pr.bottom<=button.bottom,clear:speed.right<=pr.left,locked:before[0].disabled,stable:before.length>1&&before.length===after.length&&before.every((node,index)=>node===after[index])};
  }); assert(inButton.visible&&inButton.inside&&inButton.clear&&inButton.locked&&inButton.stable,JSON.stringify(inButton));
  await page.locator('.app-shell').screenshot({path:path.join(shots,'cache.png')});
  const motion=await page.evaluate(async()=>{
    window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,updatedAt:Date.now()+90000,committedBytes:12*1024*1024,downloadedBytes:12*1024*1024,resumeBytes:12*1024*1024,progress:.75}});
    const values=[];
    // 填充用 translateX 平移（右缘水波不能被缩放压扁）：可见比例 = 1 + 平移量 / 实色宽度（元素宽度减去水波宽度）。
    const fill=document.querySelector('.button-progress'), solid=fill.offsetWidth-parseFloat(getComputedStyle(fill).getPropertyValue('--wave'));
    for(let i=0;i<10;i++){await new Promise(requestAnimationFrame); values.push(1+new DOMMatrixReadOnly(getComputedStyle(fill).transform).e/solid);}
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
  // 详细数据默认折叠、设置默认关闭；外观控件在设置里。
  assert(await page.evaluate(() => document.querySelector('#assist-details-toggle').getAttribute('aria-expanded') === 'false' && document.querySelector('#assist-metrics-panel').hidden && document.querySelector('#settings-view').hidden), '详细数据默认折叠，设置默认关闭');
  await page.locator('#settings-button').click();
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
  // 统计检查必须在主视图可见时做，否则隐藏节点的尺寸为 0，溢出检查会被空过。
  await page.locator('#settings-back').click();
  await page.locator('#assist-details-toggle').click();
  const statsStable = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('.assist-metrics dd')];
    const focused = document.activeElement;
    window.__popupTest.assistStats = { networkSpeed: 1234567890, cacheHitMB: 99999999, networkHost: 'very-long-cdn-node-for-layout-test.bilivideo.com' };
    await new Promise(resolve => setTimeout(resolve, 1400));
    if (!document.querySelector('#assist-node').textContent.includes('very-long')) throw new Error('统计未刷新');
    if (!nodes.every(node => getComputedStyle(node).whiteSpace === 'nowrap' && node.getBoundingClientRect().right <= document.querySelector('.app-shell').getBoundingClientRect().right)) throw new Error('统计数值溢出布局');
    // 详细数据展开后整页仍须放进 Chrome 弹窗的 600px 上限，否则会出现滚动条。
    if (document.querySelector('.app-shell').scrollHeight > 600) throw new Error('展开详细数据后弹窗超过 600px：' + document.querySelector('.app-shell').scrollHeight);
    return nodes.every((node, index) => node === document.querySelectorAll('.assist-metrics dd')[index]) && document.activeElement === focused;
  });
  assert(statsStable, '统计持续更新必须保持节点与焦点');
  const oldResponseBlocked = await page.evaluate(async () => {
    const node = document.querySelector('#assist-node');
    const seen = [];
    const observer = new MutationObserver(() => seen.push(node.textContent));
    observer.observe(node, {childList: true, subtree: true, characterData: true});
    window.__popupTest.assistReadQueue = [{host:'old-node.bilivideo.com',delay:1800},{host:'new-node.bilivideo.com',delay:0}];
    await new Promise(resolve => setTimeout(resolve, 3200));
    observer.disconnect();
    return seen.includes('new-node.bilivideo.com') && !seen.includes('old-node.bilivideo.com');
  });
  assert(oldResponseBlocked, '旧统计响应不得覆盖较新的统计');
  await page.evaluate(() => { window.__popupTest.assistStats = { at:0 }; });
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#assist-speed').textContent(), '—', '过期统计不能继续显示网速');
  await page.evaluate(() => { window.__popupTest.assistStats = {cacheHitMB:1}; });
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#assist-hit').textContent(), '1.00 MB', '统计归零或回滚不得被单调钳制');
  await page.locator('#assist-details-toggle').click();
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
  // 浏览器自检：主视图只在能力缺失时出现提示条与齿轮红点；重复检测不重建节点，恢复后收起。
  const health = await page.evaluate(async()=>{
    const panel=document.querySelector('#health-banner'), dot=document.querySelector('#settings-alert');
    if(!panel.hidden||!dot.hidden) throw new Error('健康状态下不应显示自检提示');
    window.__popupTest.healthFailure='offscreen 不可用';
    document.querySelector('#browser-health-refresh').click();
    await new Promise(resolve=>setTimeout(resolve,120));
    const first=document.querySelector('#browser-health-list li');
    const firstSignature=first?.dataset.healthCheck;
    const status=document.querySelector('#browser-health-status').textContent;
    document.querySelector('#browser-health-refresh').click();
    await new Promise(resolve=>setTimeout(resolve,120));
    const sameNode=first===document.querySelector('#browser-health-list li');
    const alertShown=!panel.hidden&&!dot.hidden;
    const items=document.querySelectorAll('#browser-health-list li').length;
    window.__popupTest.healthFailure='';
    document.querySelector('#browser-health-refresh').click();
    await new Promise(resolve=>setTimeout(resolve,120));
    return {hidden:panel.hidden&&dot.hidden,alertShown,firstSignature,status,sameNode,items,focus:document.activeElement?.id};
  });
  assert.equal(health.firstSignature,'offscreen',JSON.stringify(health));
  assert(health.status.includes('浏览器自检未通过')&&health.status.includes('153.0.8010.12'),JSON.stringify(health));
  assert.equal(health.items,1);
  assert(health.sameNode,'自检结论未变化时不能重建列表节点');
  assert(health.alertShown,'能力缺失时主视图必须出现提示条与齿轮红点');
  assert(health.hidden,'能力恢复后自检提示必须收起');
  // 暂停态沿用下载中的进度样式，右侧圆钮改为「继续」；撤销期内对同一画质点「缓存」等同于撤销删除，
  // 不能先续传、再被到点的删除把刚恢复的任务删掉（按钮表现为转一圈又变回「缓存」）。
  await page.locator('#current-tab').click();
  // 上面已模拟「减少动态效果」：无限循环的水波必须彻底停掉（全局 0.01ms 时长会让它高频闪烁）。
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#button-progress'),'::after').animationName),'none','减少动态效果时水波应静止');
  await page.emulateMedia({reducedMotion:'no-preference'});
  // 主按钮右缘的水波是无限循环动画：进度高频刷新时必须是同一个动画对象且时间持续前进（不能每个 tick 重启），
  // 下载中不显示漂流瓶字形。
  const tide=await page.evaluate(async()=>{
    const MiB=1024*1024, tideOf=()=>document.querySelector('#button-progress').getAnimations({subtree:true}).find(item=>item.animationName==='progress-tide');
    for(let i=0;i<12;i++){
      const at=Date.now()+400000+i;
      window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,status:'downloading',runStartedAt:at,updatedAt:at,committedBytes:(4+i/2)*MiB,resumeBytes:(4+i/2)*MiB,downloadedBytes:(4+i/2)*MiB,progress:(4+i/2)/16,speed:2*MiB}});
      if(i===1) window.tideFirst={animation:tideOf(),time:tideOf()?.currentTime};
      await new Promise(resolve=>setTimeout(resolve,55));
    }
    const last=tideOf(), button=document.querySelector('#cache-button');
    return {state:button.dataset.state,running:last?.playState,same:!!last&&last===window.tideFirst.animation,advanced:last?.currentTime>window.tideFirst.time,glyph:getComputedStyle(document.querySelector('.button-glyph')).display};
  });
  assert(tide.state==='downloading'&&tide.running==='running'&&tide.same&&tide.advanced,'进度刷新不能重启水波动画：'+JSON.stringify(tide));
  assert.equal(tide.glyph,'none','下载中不显示漂流瓶字形');
  const pausedStyle=await page.evaluate(async()=>{
    const at=Date.now()+500000, MiB=1024*1024;
    const paused={...window.taskA,status:'paused',runStartedAt:at,updatedAt:at,speed:0,committedBytes:8*MiB,resumeBytes:8*MiB,downloadedBytes:8*MiB,progress:.5};
    Object.assign(window.__popupTest.videos.find(video=>video.id===paused.id),paused);
    window.__popupTest.emit({type:'CACHE_PAUSED',video:paused});
    await new Promise(resolve=>setTimeout(resolve,60));
    const button=document.querySelector('#cache-button'),toggle=document.querySelector('#pause-button');
    return {state:button.dataset.state,disabled:button.disabled,label:document.querySelector('#button-label').textContent,sub:document.querySelector('#button-sub').textContent,hint:document.querySelector('#action-hint').hidden,
      progressShown:parseFloat(getComputedStyle(document.querySelector('.button-progress')).opacity)>0,sameWash:getComputedStyle(button).backgroundColor,toggleVisible:!toggle.hidden,toggleMode:toggle.dataset.mode,toggleLabel:toggle.getAttribute('aria-label')};
  });
  const washDownloading=await page.evaluate(()=>{const probe=document.createElement('button');probe.className='cache-button';probe.dataset.state='downloading';document.body.append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;});
  assert(pausedStyle.state==='paused'&&!pausedStyle.disabled&&pausedStyle.label==='已暂停 50%'&&/^8(\.\d+)? MB \/ /.test(pausedStyle.sub)&&pausedStyle.hint,JSON.stringify(pausedStyle));
  assert(pausedStyle.progressShown&&pausedStyle.sameWash===washDownloading,'暂停态应沿用下载中的进度底色：'+JSON.stringify(pausedStyle));
  assert(pausedStyle.toggleVisible&&pausedStyle.toggleMode==='resume'&&pausedStyle.toggleLabel==='继续缓存',JSON.stringify(pausedStyle));
  assert.equal(await page.evaluate(()=>document.querySelector('#button-progress').getAnimations({subtree:true}).find(item=>item.animationName==='progress-tide')?.playState),'paused','暂停时水面应停住');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('.app-shell').screenshot({path:path.join(shots,'paused.png')});
  await page.locator('#pause-button').click();
  await page.waitForFunction(()=>document.querySelector('#cache-button').dataset.state==='downloading');
  assert(await page.evaluate(()=>window.__popupTest.calls.includes('START_CACHE')||window.__popupTest.calls.includes('RESUME_CACHE')),'圆钮「继续」必须真正续传');
  await page.evaluate(async()=>{const video=window.__popupTest.videos.find(item=>item.id===window.taskA.id);const at=Date.now()+600000;Object.assign(video,{status:'paused',runStartedAt:at,updatedAt:at});window.__popupTest.emit({type:'CACHE_PAUSED',video:{...video}});await new Promise(resolve=>setTimeout(resolve,60));});
  await page.locator('#library-tab').click();
  await page.locator(`.video-item[data-video-id="${'popup-live-a'}"] .delete-button`).click();
  await page.locator('#current-tab').click();
  assert.equal(await page.locator('#button-label').textContent(),'缓存','撤销期内任务应从当前视频隐藏');
  const idleGlyph=await page.evaluate(()=>{const glyph=document.querySelector('.button-glyph'),label=document.querySelector('#button-label');const g=glyph.getBoundingClientRect(),l=label.getBoundingClientRect(),b=document.querySelector('#cache-button').getBoundingClientRect();
    return {display:getComputedStyle(glyph).display,letter:getComputedStyle(glyph.querySelector('.glyph-letter')).display,before:g.right<=l.left,centered:Math.abs((g.left+l.right)/2-(b.left+b.right)/2)<3};});
  assert(idleGlyph.display==='block'&&idleGlyph.letter==='none'&&idleGlyph.before&&idleGlyph.centered,'空闲时瓶子在「缓存」左侧且整体居中：'+JSON.stringify(idleGlyph));
  await page.locator('#cache-button').click();
  await page.waitForTimeout(6600);
  const afterUndoWindow=await page.evaluate(()=>({deleted:window.__popupTest.deletedIds.includes('popup-live-a'),state:document.querySelector('#cache-button').dataset.state,toast:document.querySelector('#toast').dataset.visible,listed:!!document.querySelector('.video-item[data-video-id="popup-live-a"]')}));
  assert(!afterUndoWindow.deleted&&afterUndoWindow.state==='downloading'&&afterUndoWindow.toast!=='true'&&afterUndoWindow.listed,'撤销期内点缓存应取消删除并续传：'+JSON.stringify(afterUndoWindow));
  // 完成态：封好瓶塞、装着信的瓶子，文字刷新（setText）不能抹掉字形节点。
  const sealed=await page.evaluate(async()=>{
    const MiB=1024*1024, at=Date.now()+700000, glyph=document.querySelector('.button-glyph');
    const done={...window.__popupTest.videos.find(item=>item.id===window.taskA.id),status:'complete',runStartedAt:at,updatedAt:at,completedAt:at,committedBytes:16*MiB,resumeBytes:16*MiB,downloadedBytes:16*MiB,progress:1,speed:0};
    Object.assign(window.__popupTest.videos.find(item=>item.id===done.id),done);
    window.__popupTest.emit({type:'CACHE_COMPLETE',video:done});
    await new Promise(resolve=>setTimeout(resolve,80));
    return {state:document.querySelector('#cache-button').dataset.state,sameGlyph:glyph===document.querySelector('.button-glyph'),display:getComputedStyle(glyph).display,letter:getComputedStyle(glyph.querySelector('.glyph-letter')).display,sea:getComputedStyle(glyph.querySelector('.glyph-sea')).display,cork:getComputedStyle(glyph.querySelector('.glyph-cork')).fill};
  });
  assert(sealed.state==='complete'&&sealed.sameGlyph&&sealed.display==='block'&&sealed.letter!=='none'&&sealed.sea==='none'&&sealed.cork!=='none','完成态应显示封好的漂流瓶：'+JSON.stringify(sealed));
  await page.locator('.app-shell').screenshot({path:path.join(shots,'complete.png')});
  // 画质滑杆（商店场景：大会员，720P / 1080P / 1080P60 / 4K）。默认在最右的 4K：杆身是有浪和气泡的海，
  // 弹窗每 700ms 轮询刷新，浪的动画必须是同一个对象且时间持续前进（不能每次刷新从头开始）。
  await page.goto(origin + '/store/scene/popup-scene.html');
  await page.waitForFunction(()=>globalThis.__storeScene&&document.querySelector('#quality-row').dataset.empty==='false');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const flowOf=()=>page.evaluate(()=>{const fill=document.querySelector('.quality-fill');window.flow=fill.getAnimations({subtree:true}).find(item=>item.animationName==='quality-tide');window.flowNodes=[document.querySelector('#quality-slider'),...document.querySelectorAll('.quality-stop')];return {time:window.flow?.currentTime,state:window.flow?.playState};});
  const flowStart=await flowOf();
  await page.waitForTimeout(2200);
  const flowLater=await page.evaluate(()=>{const fill=document.querySelector('.quality-fill');const flow=fill.getAnimations({subtree:true}).find(item=>item.animationName==='quality-tide');const nodes=[document.querySelector('#quality-slider'),...document.querySelectorAll('.quality-stop')];
    return {same:flow===window.flow,time:flow?.currentTime,nodes:nodes.length===window.flowNodes.length&&nodes.every((node,index)=>node===window.flowNodes[index]),
      top:document.querySelector('#quality-row').dataset.top,name:document.querySelector('#quality-name').textContent,value:document.querySelector('#quality-slider').value,max:document.querySelector('#quality-slider').max,
      chip:!document.querySelector('#account-chip').hidden,note:document.querySelector('#auth-note').hidden,ends:[document.querySelector('#quality-low').textContent,document.querySelector('#quality-high').textContent]};});
  assert(flowStart.state==='running'&&flowLater.same&&flowLater.time>flowStart.time+1500&&flowLater.nodes,'顶档的浪不能被轮询刷新重启：'+JSON.stringify({flowStart,flowLater}));
  assert(flowLater.top==='true'&&flowLater.name==='4K'&&flowLater.value==='3'&&flowLater.max==='3'&&flowLater.chip&&flowLater.note&&flowLater.ends.join()==='720P,4K',JSON.stringify(flowLater));
  // 拇指与装饰档位点必须重合：range 的几何（只铺可选段）与 CSS 的档位坐标一致。
  const thumbAligned=await page.evaluate(()=>{const slider=document.querySelector('#quality-slider'),stops=[...document.querySelectorAll('.quality-stop')],r=slider.getBoundingClientRect(),max=Number(slider.max);
    return stops.map((stop,index)=>{const s=stop.getBoundingClientRect();const thumb=r.left+11+(r.width-22)*index/max;return Math.abs(s.left+s.width/2-thumb);});});
  assert(thumbAligned.every(delta=>delta<1),'拇指位置与档位点错位：'+JSON.stringify(thumbAligned));
  await page.locator('.quality-row').screenshot({path:path.join(shots,'quality-top.png')});
  // 键盘：方向键逐档移动，离开顶档后海与漂流瓶消失；End 回到最高档，效果恢复。
  await page.locator('#quality-slider').focus();
  await page.keyboard.press('ArrowLeft');
  const stepped=await page.evaluate(()=>({name:document.querySelector('#quality-name').textContent,top:document.querySelector('#quality-row').dataset.top,flow:getComputedStyle(document.querySelector('.quality-fill'),'::before').animationName,text:document.querySelector('#quality-slider').getAttribute('aria-valuetext')}));
  assert(stepped.name==='1080P60'&&stepped.top==='false'&&stepped.flow==='none'&&stepped.text.startsWith('1080P60'),JSON.stringify(stepped));
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(()=>document.querySelector('#quality-row').dataset.top),'true','End 应回到最高档');
  // 减少动态效果：顶档仍是海的配色，但浪与气泡都静止。
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.deepEqual(await page.evaluate(()=>[getComputedStyle(document.querySelector('.quality-fill'),'::before').animationName,getComputedStyle(document.querySelector('.quality-fill'),'::after').animationName]),['none','none'],'减少动态效果时浪与气泡应静止');
  // 未登录：B 站只返回 720P / 1080P，1080P+ / 1080P60 / 4K 是杆尾的锁定段；拖不进去，也不算顶档。
  await page.goto(origin + '/store/scene/popup-scene.html?auth=signedout');
  await page.waitForFunction(()=>globalThis.__storeScene&&document.querySelector('#quality-row').dataset.empty==='false');
  await page.locator('#quality-slider').focus();
  await page.keyboard.press('End');
  const signedOut=await page.evaluate(()=>{const locked=document.querySelector('#quality-locked'),slider=document.querySelector('#quality-slider'),l=locked.getBoundingClientRect(),r=slider.getBoundingClientRect();
    return {name:document.querySelector('#quality-name').textContent,value:slider.value,max:slider.max,top:document.querySelector('#quality-row').dataset.top,stops:document.querySelectorAll('.quality-stop').length,
      lockedShown:!locked.hidden,separate:l.left>=r.right-0.5,highLocked:document.querySelector('#quality-high').dataset.locked,
      note:document.querySelector('#auth-note-text').textContent,action:!document.querySelector('#auth-action').hidden,chip:document.querySelector('#account-chip').hidden};});
  assert(signedOut.name==='1080P'&&signedOut.value==='1'&&signedOut.max==='1'&&signedOut.top==='false'&&signedOut.stops===5&&signedOut.lockedShown&&signedOut.separate&&signedOut.highLocked==='true',JSON.stringify(signedOut));
  assert(signedOut.note==='登录后可选 1080P60'&&signedOut.action&&signedOut.chip,JSON.stringify(signedOut));
  await page.locator('.app-shell').screenshot({path:path.join(shots,'quality-signed-out.png')});
  await page.goto(origin + '/store/scene/popup-scene.html');
  await page.waitForFunction(()=>globalThis.__storeScene&&document.querySelector('#quality-row').dataset.empty==='false');
  // 页眉图标引用的是打包内的矢量母版：路径写错或资源缺失时 <img> 只会静默显示破图。
  assert(await page.evaluate(()=>{const icon=document.querySelector('.brand-icon'); return icon.complete&&icon.naturalWidth>0;}),'页眉图标没有加载出来');
  // 页眉诗句：「海内存知」与「己，天涯若比邻」同字号、同一行、紧贴（「知己」不能被拆开），
  // 只靠字重与颜色区分；整句不折行、不压住设置按钮。
  const verse=await page.evaluate(()=>{
    const name=document.querySelector('.brand-name'),rest=document.querySelector('.brand-verse'),gear=document.querySelector('#settings-button');
    const ink=(node)=>{const range=document.createRange(); range.selectNodeContents(node); return range.getClientRects();};
    const n=ink(name),r=ink(rest),ns=getComputedStyle(name),rs=getComputedStyle(rest),g=gear.getBoundingClientRect();
    return {lines:[n.length,r.length],gap:r[0].left-n[0].right,baseline:Math.abs(r[0].bottom-n[0].bottom),
      size:[ns.fontSize,rs.fontSize],weight:[+ns.fontWeight,+rs.fontWeight],color:[ns.color,rs.color],clear:r[r.length-1].right<g.left-4};
  });
  assert(verse.lines.join()==='1,1'&&verse.gap>=-0.5&&verse.gap<3&&verse.baseline<1&&verse.size[0]===verse.size[1]&&verse.weight[0]>verse.weight[1]&&verse.color[0]!==verse.color[1]&&verse.clear,JSON.stringify(verse));
  // 左右边距必须对称：一整句不含「 · 」的长警告曾被当成一个不换行的段，把整列撑出右侧 16px 边距。
  await page.goto(origin + '/store/scene/popup-scene.html?auth=limited');
  await page.waitForFunction(()=>globalThis.__storeScene&&document.querySelector('#auth-note').textContent.includes('登录状态受限'));
  const gutters=await page.evaluate(()=>{
    const shell=document.querySelector('.app-shell').getBoundingClientRect(),tabs=document.querySelector('#panel-tabs').getBoundingClientRect();
    const wide=[...document.querySelectorAll('#current-view *')].filter(node=>node.getClientRects().length).map(node=>({node:node.id||node.className,right:node.getBoundingClientRect().right})).filter(item=>item.right>tabs.right+0.5);
    return {left:tabs.left-shell.left,right:shell.right-tabs.right,scroll:document.documentElement.scrollWidth,wide:wide.slice(0,5)};
  });
  assert(Math.abs(gutters.left-gutters.right)<0.5&&gutters.scroll<=360&&!gutters.wide.length,JSON.stringify(gutters));
  // Windows 上 Chrome 弹窗高度封顶 600px：展开「提前加载 · 详情」、画质折行时内容会超高，
  // 经典滚动条（15px）一出现就把内容向左挤。视口压到 600 并强制溢出，仍然不允许有滚动条占宽或让内容位移。
  await page.setViewportSize({width:360,height:600});
  const beforeTabs=await page.evaluate(()=>document.querySelector('#panel-tabs').getBoundingClientRect().left);
  if(await page.locator('#assist-details-toggle').getAttribute('aria-expanded')!=='true') await page.locator('#assist-details-toggle').click();
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.id='overflow-spacer';spacer.style.height='400px';document.querySelector('.app-shell').append(spacer);});
  await page.waitForTimeout(350);
  const bar=await page.evaluate(()=>({overflow:document.documentElement.scrollHeight>document.documentElement.clientHeight,gutter:window.innerWidth-document.documentElement.clientWidth,left:document.querySelector('#panel-tabs').getBoundingClientRect().left}));
  assert(bar.overflow,'测试前提：内容必须超过 600px');
  assert.equal(bar.gutter,0,'弹窗超高时也不能出现占宽的滚动条');
  // Playwright 无头模式默认隐藏滚动条（上面的 gutter 恒为 0），所以另外校验样式本身：Windows 的经典滚动条只能靠它禁掉。
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollbarWidth),'none','html 必须隐藏滚动条');
  assert.equal(bar.left,beforeTabs,'内容不能因滚动条被挤向左侧');
  await page.evaluate(()=>document.querySelector('#overflow-spacer').remove());
  await page.setViewportSize({width:360,height:900});
  for(const fixture of ['background-popup-integration','offscreen-integration','offscreen-merge-integration']){
    await page.goto(`${origin}/tests/${fixture}.html`);
    await page.waitForFunction(()=>document.querySelector('#result').textContent !== 'running',{},{timeout:45000});
    const result=JSON.parse(await page.locator('#result').textContent()); assert.equal(result.ok,true,JSON.stringify(result));
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,initialPopup:true,nodeIdentity:true,hoverAnimationStarts:stable.animations,keyboardFocus:true,pendingSavePreserved:true,symmetricActions:sizes,cacheLayout:layout,progressFrames:motion,unitLabels,mergeAndAudio:true,appearanceControls:true,configurationFailureRollback:true,saveFailureRecovery:true,deletionTombstone:true,reducedMotion:true,multiTaskBadge:true,committedWatermark:true,screenshots:shots},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
