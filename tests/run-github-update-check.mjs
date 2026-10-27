// 源码目录与发布目录都必须点击真实按钮；只验证构建清单会漏掉源码安装的权限错误。
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {chromiumLaunchOptions} from '../scripts/lib/browser-launch.mjs';
import {extensionIdFromKey} from '../scripts/lib/release-checks.mjs';

const root=process.cwd();
const extension=path.resolve(process.argv[2]||root);
const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json')));
const {DISTRIBUTION}=await import(pathToFileURL(path.join(extension,'src/distribution.js')));
const source=DISTRIBUTION==='development';
const id=extensionIdFromKey(manifest.key);
await mkdir(path.join(root,'.tmp'),{recursive:true});
const base=await mkdtemp(path.join(root,'.tmp/update-check-'));
const profile=path.join(base,'profile');
const fixture=path.join(base,'extension');await mkdir(fixture);
for(const file of ['src','_locales','assets','rules','manifest.json','popup.html','popup.css','offscreen.html','privacy.html','update.html','update.css','update-public-key.json']) {
 await cp(path.join(extension,file),path.join(fixture,file),{recursive:true});
}
// 无头浏览器无法操作原生授权弹框；仅测试副本把已声明的可选域名预授权为必需域名。
// 不替换 permissions.request，遗漏声明仍会由 Chrome 拒绝。首次授权弹框由 --native 验收。
await writeFile(path.join(fixture,'manifest.json'),JSON.stringify({...manifest,host_permissions:[...(manifest.host_permissions||[]),...(manifest.optional_host_permissions||[])]}));
const context=await chromium.launchPersistentContext(profile,chromiumLaunchOptions({headless:true,args:[`--disable-extensions-except=${fixture}`,`--load-extension=${fixture}`]}));
context.setDefaultTimeout(10000);
async function assertOneViewport(page,label) {
 const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,contentWidth:document.documentElement.scrollWidth,contentHeight:document.documentElement.scrollHeight}));
 assert(bounds.contentWidth<=bounds.width&&bounds.contentHeight<=bounds.height+1,`${label} 应在一个视口内显示：${JSON.stringify(bounds)}`);
}
try {
 let requests=0,releases=[];
 await context.route('https://api.github.com/repos/Kihara-Ri/bilibili-buffer-extension/releases?per_page=20',route=>{
  requests++;
  return route.fulfill({contentType:'application/json',body:JSON.stringify(releases)});
 });
 const page=await context.newPage();
 await page.goto(`chrome-extension://${id}/update.html`);
 await page.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
 await assertOneViewport(page,'首次打开');
 assert.equal(await page.locator('#bind').isVisible(),!source,'源码安装不应显示目录选择入口');
 assert.equal(await page.locator('#source-install').isVisible(),source);
 if(!source)assert.equal(await page.locator('#installation-location').getAttribute('href'),`chrome://extensions/?id=${id}`);
 assert.equal(await page.getByRole('button',{name:'检查更新',exact:true}).isEnabled(),true);
 await page.screenshot({path:path.join(base,'before-check.png'),fullPage:true});
 await page.getByRole('button',{name:'检查更新',exact:true}).click();
 await page.waitForFunction(()=>{
  const status=document.querySelector('#status');
  return status.dataset.state==='error'||status.textContent==='当前已是 GitHub 最新可用版本。';
 });
 await page.screenshot({path:path.join(base,'after-check.png'),fullPage:true});
 const status=await page.locator('#status').textContent();
 console.log(JSON.stringify({extension,browser:context.browser().version(),status,requests,screenshot:path.join(base,'after-check.png')}));
 assert.equal(requests,1,status);
 assert.equal(await page.locator('#status').getAttribute('data-state'),'ready',status);
 assert.equal(await page.getByRole('button',{name:'检查更新',exact:true}).isEnabled(),true);
 assert.equal(await page.locator('#install').isEnabled(),false);
 if(source) {
  assert.equal(await page.locator('#install').isVisible(),false);
  await page.locator('#source-guide').click();
  await assertOneViewport(page,'源码安装说明展开');
  assert.equal(await page.locator('#source-instructions li').count(),3,'源码更新说明直接在本页展示');
  await page.emulateMedia({colorScheme:'dark'});
  await page.screenshot({path:path.join(base,'source-install.png'),fullPage:true});
  console.log('PASS: 源码安装自动识别，仅检查版本，不显示连接／安装入口');
  // 下一场景准备：同一安装身份切到源码后，旧更新的恢复目录仍必须可用。
  await page.evaluate(async()=>{
   const {writeUpdateState}=await import('./src/github-update-store.js');
   const root=await navigator.storage.getDirectory(),directory=await root.getDirectoryHandle('source-recovery',{create:true});
   const file=await directory.getFileHandle('manifest.json',{create:true}),writer=await file.createWritable();
   await writer.write(JSON.stringify(chrome.runtime.getManifest()));await writer.close();
   await writeUpdateState('directory',directory);await writeUpdateState('journal',{stage:'writing',backups:[]});
  });
  await page.reload();await page.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='error');
  assert.equal(await page.locator('#directory-name').textContent(),'source-recovery');
  assert.equal(await page.locator('#directory-setup').isVisible(),true);
  assert.equal(await page.locator('#recover').isEnabled(),true);
  await page.evaluate(async()=>{const {writeUpdateState}=await import('./src/github-update-store.js');await writeUpdateState('journal',null);await writeUpdateState('directory',null);});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  assert.equal(await page.locator('#bind').isVisible(),false);
 }
 if(!source) {
  const opening=context.waitForEvent('page');
  await page.getByRole('link',{name:'查看安装位置',exact:true}).click();
  const details=await opening;await details.waitForURL(`chrome://extensions/?id=${id}`);
  await details.locator('#load-path').waitFor({state:'visible'});
  assert.equal(await details.locator('#load-path').isVisible(),true,'当前扩展详情应显示可点击的安装路径');
  assert((await details.locator('#load-path').textContent()).includes('加载来源'),'引导用词应和真实 Chrome 界面一致');
  await details.close();
  const mobile=await context.newPage();await mobile.setViewportSize({width:360,height:740});
  await mobile.goto(`chrome-extension://${id}/update.html`);
  await mobile.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  await assertOneViewport(mobile,'中文 360×740');
  await mobile.screenshot({path:path.join(base,'guided-chinese-mobile.png'),fullPage:true});
  await mobile.close();
  const english=await context.newPage();
  await english.addInitScript(()=>{if(globalThis.chrome?.i18n)chrome.i18n.getUILanguage=()=> 'en';});
  await english.setViewportSize({width:390,height:844});
  await english.goto(`chrome-extension://${id}/update.html`);
  await english.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  assert.equal(await english.locator('#bind').textContent(),'Connect installation folder');
  await assertOneViewport(english,'英文 390×844');
  assert.equal(await english.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'英文窄屏无横向溢出');
  await english.screenshot({path:path.join(base,'guided-english-mobile.png'),fullPage:true});
  await english.close();
 }
 for(const [kind,expected] of source?[]:[['empty','没有找到正在使用的安装文件夹'],['repository','所选目录是源码仓库']]) {
  const selectionPage=await context.newPage();
  // 仅替换原生选择器入口，返回浏览器真实的目录句柄；目录校验与页面错误处理均走生产代码。
  await selectionPage.addInitScript(kind=>{
   const selected=(async()=>{
    const root=await navigator.storage.getDirectory();
    const directory=await root.getDirectoryHandle(kind,{create:true});
    if(kind==='repository')await directory.getDirectoryHandle('.git',{create:true});
    return directory;
   })();
   window.showDirectoryPicker=()=>selected;
  },kind);
  await selectionPage.emulateMedia({colorScheme:'dark'});
  await selectionPage.goto(`chrome-extension://${id}/update.html`);
  await selectionPage.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  await selectionPage.getByRole('button',{name:'连接安装文件夹',exact:true}).click();
  await selectionPage.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='error');
  const message=await selectionPage.locator('#status').textContent();
  assert(message.includes(expected),message);
  assert.equal(await selectionPage.locator('#directory-name').textContent(),'尚未连接');
  assert.equal(await selectionPage.getByRole('button',{name:'更新并重载',exact:true}).isEnabled(),false);
  const screenshot=path.join(base,`${kind}-directory.png`);
  await selectionPage.screenshot({path:screenshot,fullPage:true});
  console.log(JSON.stringify({directory:kind,status:message,screenshot}));
  await selectionPage.close();
 }
 if(!source) {
  const connected=await context.newPage();
  await connected.addInitScript(()=>{
   if(location.protocol!=='chrome-extension:')return;
   // 选择器与探针读资源边界用夹具；查找、真实 OPFS 写入、IndexedDB 记忆、页面交互不替换。
   const prepared=(async()=>{
    const root=await navigator.storage.getDirectory();
    const parent=await root.getDirectoryHandle('downloaded',{create:true});
    const copy=await parent.getDirectoryHandle('copy',{create:true});
    const release=await parent.getDirectoryHandle('release',{create:true});
    const actual=await release.getDirectoryHandle('installed',{create:true});
    for(const directory of [copy,actual]) {
     const file=await directory.getFileHandle('manifest.json',{create:true}),writer=await file.createWritable();
     await writer.write(JSON.stringify(chrome.runtime.getManifest()));await writer.close();
    }
    return {parent,actual};
   })();
   const original=window.fetch.bind(window);
   window.fetch=async(input,options)=>{
    const url=String(input);
    if(url.startsWith(chrome.runtime.getURL('.haineicunzhi-update-'))) {
     const {actual}=await prepared;
     try {const file=await (await actual.getFileHandle(url.split('/').at(-1))).getFile();return new Response(await file.text());}
     catch {return new Response('',{status:404});}
    }
    return original(input,options);
   };
   window.showDirectoryPicker=async options=>{
    window.pickerStartIn=options.startIn?.name||null;
    await new Promise(resolve=>setTimeout(resolve,300));
    return (await prepared).parent;
   };
  });
  await connected.emulateMedia({colorScheme:'dark'});
  await connected.goto(`chrome-extension://${id}/update.html`);
  await connected.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  await connected.screenshot({path:path.join(base,'guided-setup.png'),fullPage:true});
  const bind=connected.locator('#bind'),node=await bind.elementHandle();
  await bind.click();
  assert.equal(await bind.isDisabled(),true,'选择与扫描期间保留 pending');
  await connected.waitForFunction(()=>document.querySelector('#directory-name')?.textContent==='installed');
  assert.equal(await bind.evaluate((element,original)=>element===original,node),true,'连接按钮保持节点身份');
  assert.equal(await connected.locator('#connection-help').getAttribute('open'),null);
  assert((await connected.locator('#directory-permission').textContent()).includes('已允许访问'));
  await connected.screenshot({path:path.join(base,'connected.png'),fullPage:true});
  await connected.reload();
  await connected.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  assert.equal(await connected.locator('#directory-name').textContent(),'installed','重新打开复用 IndexedDB 中的目录句柄');
  assert.equal(await bind.textContent(),'更换文件夹');
  await bind.click();
  await connected.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('已连接并记住'));
  assert.equal(await connected.evaluate(()=>window.pickerStartIn),'installed','选择器从已记住的安装位置开始');
  releases=[{tag_name:'v99.0.0',assets:[{name:'haineicunzhi-github-99.0.0.update.json',browser_download_url:'https://github.com/Kihara-Ri/bilibili-buffer-extension/releases/download/v99.0.0/haineicunzhi-github-99.0.0.update.json'}]}];
  const access=await context.newPage();
  await access.addInitScript(()=>{
   const original=FileSystemDirectoryHandle.prototype.queryPermission;
   FileSystemDirectoryHandle.prototype.queryPermission=function(options){return this.name==='installed'?Promise.resolve('prompt'):original.call(this,options);};
   FileSystemDirectoryHandle.prototype.requestPermission=async function(){window.permissionRequests=(window.permissionRequests||0)+1;return 'denied';};
   window.showDirectoryPicker=()=>{throw new Error('不应重新选择已记住的目录');};
  });
  await access.goto(`chrome-extension://${id}/update.html`);
  await access.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  assert.equal(await access.evaluate(()=>window.permissionRequests),undefined,'启动只查询权限');
  assert((await access.locator('#directory-permission').textContent()).includes('可能再次请求'));
  await access.getByRole('button',{name:'检查更新',exact:true}).click();
  await access.waitForFunction(()=>document.querySelector('#latest-version')?.textContent==='99.0.0');
  await access.getByRole('button',{name:'更新并重载',exact:true}).click();
  await access.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='error');
  assert.equal(await access.evaluate(()=>window.permissionRequests),1);
  assert((await access.locator('#status').textContent()).includes('未获得目录写入权限'));
  assert.equal(await access.locator('#directory-name').textContent(),'installed');
  await access.close();releases=[];
  // 下一场景的准备：删除已连接目录的清单，模拟目录失效；页面加载时不得弹出选择器。
  await connected.evaluate(async()=>{
   const {readUpdateState}=await import('./src/github-update-store.js');
   const directory=await readUpdateState('directory');await directory.removeEntry('manifest.json');
  });
  const stale=await context.newPage();await stale.emulateMedia({colorScheme:'dark'});
  await stale.goto(`chrome-extension://${id}/update.html`);
  await stale.waitForFunction(()=>document.querySelector('#status')?.dataset.state==='ready');
  assert.equal(await stale.locator('#bind').textContent(),'重新连接文件夹');
  assert.equal(await stale.locator('#install').isEnabled(),false);
  assert.equal(await stale.evaluate(()=>window.pickerStartIn),undefined,'启动不自动请求目录授权');
  releases=[{tag_name:'v99.0.0',assets:[{name:'haineicunzhi-github-99.0.0.update.json',browser_download_url:'https://github.com/Kihara-Ri/bilibili-buffer-extension/releases/download/v99.0.0/haineicunzhi-github-99.0.0.update.json'}]}];
  await stale.getByRole('button',{name:'检查更新',exact:true}).click();
  await stale.waitForFunction(()=>document.querySelector('#latest-version')?.textContent==='99.0.0');
  assert((await stale.locator('#status').textContent()).includes('重新连接'),'有新版也必须保留失效目录的重连引导');
  releases=[];
  await stale.screenshot({path:path.join(base,'reconnect.png'),fullPage:true});
  await stale.close();
  console.log(JSON.stringify({guidedSetup:path.join(base,'guided-setup.png'),connected:path.join(base,'connected.png'),reconnect:path.join(base,'reconnect.png')}));
  await connected.close();
 }
} catch(error) {
 const page=context.pages().find(page=>page.url().endsWith('/update.html'));
 if(page) {
  await page.screenshot({path:path.join(base,'failure.png'),fullPage:true});
  console.error(await page.locator('#status').textContent(),await page.evaluate(()=>chrome.permissions.getAll()));
 }
 throw error;
} finally {await context.close();}
