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
  // 暂停在主按钮内部右侧：不得盖住速度文字，也不得超出按钮；画质卡片在进度刷新中保持节点身份。
  const inButton=await page.evaluate(async()=>{
    const button=document.querySelector('#cache-button').getBoundingClientRect(),pause=document.querySelector('#pause-button'),pr=pause.getBoundingClientRect(),speed=document.querySelector('#button-speed').getBoundingClientRect();
    const before=[...document.querySelectorAll('#quality-options .quality-option')];
    window.__popupTest.emit({type:'CACHE_PROGRESS',video:{...window.taskA,updatedAt:Date.now()+50000}});
    await new Promise(resolve=>setTimeout(resolve,80));
    const after=[...document.querySelectorAll('#quality-options .quality-option')];
    return {visible:!pause.hidden,inside:pr.left>=button.left&&pr.right<=button.right&&pr.top>=button.top&&pr.bottom<=button.bottom,clear:speed.right<=pr.left,locked:before.every(node=>node.disabled),stable:before.length>0&&before.length===after.length&&before.every((node,index)=>node===after[index])};
  }); assert(inButton.visible&&inButton.inside&&inButton.clear&&inButton.locked&&inButton.stable,JSON.stringify(inButton));
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
  const pausedStyle=await page.evaluate(async()=>{
    const at=Date.now()+500000, MiB=1024*1024;
    const paused={...window.taskA,status:'paused',runStartedAt:at,updatedAt:at,speed:0,committedBytes:8*MiB,resumeBytes:8*MiB,downloadedBytes:8*MiB,progress:.5};
    Object.assign(window.__popupTest.videos.find(video=>video.id===paused.id),paused);
    window.__popupTest.emit({type:'CACHE_PAUSED',video:paused});
    await new Promise(resolve=>setTimeout(resolve,60));
    const button=document.querySelector('#cache-button'),toggle=document.querySelector('#pause-button');
    return {state:button.dataset.state,disabled:button.disabled,label:document.querySelector('#button-label').textContent,sub:document.querySelector('#button-sub').textContent,hint:document.querySelector('#action-hint').hidden,
      progressShown:getComputedStyle(document.querySelector('.button-progress')).opacity==='1',sameWash:getComputedStyle(button).backgroundColor,toggleVisible:!toggle.hidden,toggleMode:toggle.dataset.mode,toggleLabel:toggle.getAttribute('aria-label')};
  });
  const washDownloading=await page.evaluate(()=>{const probe=document.createElement('button');probe.className='cache-button';probe.dataset.state='downloading';document.body.append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;});
  assert(pausedStyle.state==='paused'&&!pausedStyle.disabled&&pausedStyle.label==='已暂停 50%'&&/^8(\.\d+)? MB \/ /.test(pausedStyle.sub)&&pausedStyle.hint,JSON.stringify(pausedStyle));
  assert(pausedStyle.progressShown&&pausedStyle.sameWash===washDownloading,'暂停态应沿用下载中的进度底色：'+JSON.stringify(pausedStyle));
  assert(pausedStyle.toggleVisible&&pausedStyle.toggleMode==='resume'&&pausedStyle.toggleLabel==='继续缓存',JSON.stringify(pausedStyle));
  await page.locator('.app-shell').screenshot({path:path.join(shots,'paused.png')});
  await page.locator('#pause-button').click();
  await page.waitForFunction(()=>document.querySelector('#cache-button').dataset.state==='downloading');
  assert(await page.evaluate(()=>window.__popupTest.calls.includes('START_CACHE')||window.__popupTest.calls.includes('RESUME_CACHE')),'圆钮「继续」必须真正续传');
  await page.evaluate(async()=>{const video=window.__popupTest.videos.find(item=>item.id===window.taskA.id);const at=Date.now()+600000;Object.assign(video,{status:'paused',runStartedAt:at,updatedAt:at});window.__popupTest.emit({type:'CACHE_PAUSED',video:{...video}});await new Promise(resolve=>setTimeout(resolve,60));});
  await page.locator('#library-tab').click();
  await page.locator(`.video-item[data-video-id="${'popup-live-a'}"] .delete-button`).click();
  await page.locator('#current-tab').click();
  assert.equal(await page.locator('#button-label').textContent(),'缓存','撤销期内任务应从当前视频隐藏');
  await page.locator('#cache-button').click();
  await page.waitForTimeout(6600);
  const afterUndoWindow=await page.evaluate(()=>({deleted:window.__popupTest.deletedIds.includes('popup-live-a'),state:document.querySelector('#cache-button').dataset.state,toast:document.querySelector('#toast').dataset.visible,listed:!!document.querySelector('.video-item[data-video-id="popup-live-a"]')}));
  assert(!afterUndoWindow.deleted&&afterUndoWindow.state==='downloading'&&afterUndoWindow.toast!=='true'&&afterUndoWindow.listed,'撤销期内点缓存应取消删除并续传：'+JSON.stringify(afterUndoWindow));
  // 画质卡片在四档并排、带 VIP/登录 标记时最挤：商店场景就是这种数据（4K 约 312 MB + VIP）。
  // 标记不能压住体积或档位文字，也不能被卡片或相邻控件遮挡。
  await page.goto(origin + '/store/scene/popup-scene.html');
  await page.waitForFunction(()=>globalThis.__storeScene&&document.querySelectorAll('.quality-option-tag').length>0);
  const chips=await page.evaluate(()=>{
    const hit=(a,b)=>a.left<b.right-0.5&&b.left<a.right-0.5&&a.top<b.bottom-0.5&&b.top<a.bottom-0.5;
    const modeRow=document.querySelector('.mode-row').getBoundingClientRect();
    const all=[...document.querySelectorAll('.quality-option')];
    return all.map((option,index)=>{
      const box=option.getBoundingClientRect(),label=option.querySelector('.quality-option-label'),size=option.querySelector('.quality-option-size'),tag=option.querySelector('.quality-option-tag');
      const ink=(node)=>{const range=document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect();};
      // 文字的实际墨迹范围：档位/体积是块级网格项，盒子横跨整张卡片，用盒子判断会把空白处也算成重叠。
      const lr=ink(label),sr=ink(size),tr=tag?.getBoundingClientRect();
      const problems=[];
      if(size.scrollWidth>size.clientWidth||sr.right>box.right-1)problems.push('体积溢出卡片');
      if(lr.right>box.right-1)problems.push('档位溢出卡片');
      if(tr){
        if(hit(tr,sr))problems.push('标记压住体积');
        if(hit(tr,lr))problems.push('标记压住档位');
        if(tr.top<modeRow.bottom)problems.push('标记伸进上方控件');
        if(all.some((other,j)=>j!==index&&hit(tr,other.getBoundingClientRect())))problems.push('标记压住相邻卡片');
        const at=document.elementFromPoint(tr.left+tr.width/2,tr.top+tr.height/2);
        if(!tag.contains(at))problems.push('标记被遮挡');
      }
      return {text:option.textContent,problems};
    });
  });
  assert(chips.length===4&&chips.every(chip=>!chip.problems.length),JSON.stringify(chips));
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
  // 账号说明只能在「 · 」处折行：档位名（如 1080P+）不能被单独挤到下一行。
  const note=await page.evaluate(()=>{
    const node=document.querySelector('#auth-note');
    const line=parseFloat(getComputedStyle(node).lineHeight);
    return {text:node.textContent,segments:[...node.querySelectorAll('.text-segment')].map(segment=>Math.round(segment.getBoundingClientRect().height/line))};
  });
  assert(note.text.includes(' · ')&&note.segments.length>1&&note.segments.every(lines=>lines===1),JSON.stringify(note));
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
