// 使用隔离的真实扩展验证协调链路；测试签名只存在临时目录，绝不替换仓库信任根。
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {chromiumLaunchOptions} from '../scripts/lib/browser-launch.mjs';
import {extensionIdFromKey} from '../scripts/lib/release-checks.mjs';
const root=process.cwd();await mkdir(path.join(root,'.tmp'),{recursive:true});
const base=await mkdtemp(path.join(root,'.tmp/updater-acceptance-'));
await mkdir(path.join(root,'.tmp/github-updater-work'),{recursive:true});
await writeFile(path.join(root,'.tmp/github-updater-work/updater-latest.json'),JSON.stringify({base}));
const fixture=path.join(base,'source');await mkdir(fixture);
for(const file of ['scripts','src','_locales','assets','rules','LICENSE','THIRD_PARTY_NOTICES.md','manifest.json','package.json','popup.html','popup.css','offscreen.html','privacy.html','update.html','update.css']) await cp(path.join(root,file),path.join(fixture,file),{recursive:true});
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
await writeFile(path.join(fixture,'update-public-key.json'),JSON.stringify({schema:1,publicKey:pair.publicKey.export({format:'jwk'})}));
const privatePath=path.join(base,'test-key.pem');await writeFile(privatePath,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
execFileSync(process.execPath,[path.join(fixture,'scripts/build-release.mjs'),'--github'],{env:{...process.env,UPDATE_SIGNING_KEY:privatePath},stdio:'pipe'});
const unpacked=path.join(fixture,'dist/github/unpacked');
const manifest=JSON.parse(await readFile(path.join(unpacked,'manifest.json'))),id=extensionIdFromKey(manifest.key);
// 目标包来自同一生产构建器，仅版本与测试标记不同。
const targetVersion='2.15.1';
const targetManifest={...manifest,version:targetVersion};
await writeFile(path.join(fixture,'manifest.json'),JSON.stringify(targetManifest));
execFileSync(process.execPath,[path.join(fixture,'scripts/build-release.mjs'),'--github','--out',path.join(base,'target')],{env:{...process.env,UPDATE_SIGNING_KEY:privatePath},stdio:'pipe'});
const envelope=await readFile(path.join(base,'target',`haineicunzhi-github-${targetVersion}.update.json`),'utf8');
const context=await chromium.launchPersistentContext(path.join(base,'profile'),chromiumLaunchOptions({headless:!process.argv.includes('--native'),args:[`--disable-extensions-except=${unpacked}`,`--load-extension=${unpacked}`]}));
try{
 await context.route('https://api.github.com/repos/Kihara-Ri/bilibili-buffer-extension/releases?per_page=20',route=>route.fulfill({contentType:'application/json',body:JSON.stringify([{tag_name:'v'+targetVersion,assets:[{name:`haineicunzhi-github-${targetVersion}.update.json`,browser_download_url:`https://github.com/Kihara-Ri/bilibili-buffer-extension/releases/download/v${targetVersion}/haineicunzhi-github-${targetVersion}.update.json`}]}])}));
 await context.route('https://github.com/Kihara-Ri/bilibili-buffer-extension/releases/download/**',route=>route.fulfill({contentType:'application/json',body:envelope}));
 const manager=await context.newPage();await manager.goto("chrome://extensions/");await manager.evaluate(()=>chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));await manager.close();
 const page=await context.newPage();await page.goto(`chrome-extension://${id}/update.html`);
 await page.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
 assert.equal(await page.locator('#current-version').textContent(),manifest.version);
 const health=await page.evaluate(async()=>chrome.runtime.sendMessage({target:'background',type:'UPDATER_STATE'}));assert.equal(health.ok,true);assert.equal(health.state,null);
 const offscreenHealth=await page.evaluate(async()=>{const c=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});if(!c.length)await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'验证更新后下载文档的构建版本'});return chrome.runtime.sendMessage({target:'offscreen',type:'GET_UPDATE_HEALTH'});});
 assert.equal(offscreenHealth.ok,true,JSON.stringify(offscreenHealth));assert.equal(offscreenHealth.version,manifest.version);
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 const rejected=await popup.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'UPDATER_PREPARE',version:'99.0.0'}));
 assert.equal(rejected.ok,false);
 await page.evaluate(()=>{window.lockHeld=false;window.lockTask=navigator.locks.request('haineicunzhi-update-files-v1',async()=>{window.lockHeld=true;await new Promise(resolve=>window.releaseTestLock=resolve);});});
 await page.waitForFunction(()=>window.lockHeld);
 const lockResult=await popup.evaluate(async()=>{try{const {withUpdateFileLock}=await import('./src/github-update-lock.js');await withUpdateFileLock(()=>true);return 'entered';}catch{return 'blocked';}});
 assert.equal(lockResult,'blocked');await page.evaluate(async()=>{window.releaseTestLock();await window.lockTask;});
 const unlocked=await popup.evaluate(async()=>{const {withUpdateFileLock}=await import('./src/github-update-lock.js');return withUpdateFileLock(()=>true);});assert.equal(unlocked,true);await popup.close();
 await page.screenshot({path:path.join(base,'update-page.png'),fullPage:true});
 console.log('PASS: 更新页、真实后台、渠道权限、发送方限制');
 if(process.argv.includes('--native')){
   await page.bringToFront();
   await page.evaluate(async()=>{
     await chrome.storage.local.set({acceptanceMarker:'preserve-me'});
     const {putVideo,openCacheDb}=await import('./src/db.js');
     await putVideo({id:'updater-proof',title:'update retention',status:'complete',mediaKind:'progressive',downloadedBytes:4,totalBytes:4});
     const db=await openCacheDb();await new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.objectStore('chunks').put({videoId:'updater-proof',track:'video',index:0,blob:new Blob([new Uint8Array([7,11,23,47])])});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
   });
   console.log(`NATIVE_READY ${unpacked}`);
   // 目录选择与原生权限弹框由真正用户手势操作；这里等待实际完成结果。
   let completed;
   const deadline=Date.now()+10*60*1000;
   while(Date.now()<deadline){
     for(const candidate of context.pages()){
       if(candidate.isClosed()||!candidate.url().includes('/update.html'))continue;
       const state=await candidate.locator('#status').getAttribute('data-state').catch(()=>null);
       if(state==='success'){completed=candidate;break;}
     }
     if(completed)break;
     await new Promise(resolve=>setTimeout(resolve,500));
   }
   assert(completed,'原生目录更新未完成');
   const proof=await completed.evaluate(async()=>{
     const {openCacheDb}=await import('./src/db.js');const db=await openCacheDb();
     const row=await new Promise((resolve,reject)=>{const tx=db.transaction('chunks');const req=tx.objectStore('chunks').get(['updater-proof','video',0]);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
     return {id:chrome.runtime.id,version:chrome.runtime.getManifest().version,marker:(await chrome.storage.local.get('acceptanceMarker')).acceptanceMarker,blob:[...new Uint8Array(await row.blob.arrayBuffer())],pending:(await chrome.storage.local.get('githubUpdatePendingV1')).githubUpdatePendingV1,journal:await (await import('./src/github-update-store.js')).updateJournal.get()};
   });
   assert.equal(proof.id,id);assert.equal(proof.version,targetVersion);assert.equal(proof.marker,'preserve-me');assert.deepEqual(proof.blob,[7,11,23,47]);assert.equal(proof.pending,null);assert.equal(proof.journal,undefined);
   assert.equal(JSON.parse(await readFile(path.join(unpacked,'manifest.json'))).version,targetVersion);
   await completed.screenshot({path:path.join(base,'update-success.png'),fullPage:true});
   await writeFile(path.join(base,'verification.json'),JSON.stringify({browser:context.browser().version(),...proof,network:'intercepted release metadata and signed asset; native directory writes and reload'},null,2));
   console.log('PASS: 实际安装目录替换、重载版本验证、ID/storage/IndexedDB Blob 保留');
 }

}finally{await context.close();}
