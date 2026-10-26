import {withUpdateFileLock} from './github-update-lock.js';
import {localizeDocument,t} from './i18n.js';
import {DISTRIBUTION} from './distribution.js';
import {findLatestUpdate,GITHUB_ORIGINS,readLimitedJson} from './github-update-network.js';
import {verifyUpdateEnvelope,prepareUpdateFiles} from './github-update-protocol.js';
import {directoryIO,bindInstallDirectory,applyUpdate,rollbackUpdate} from './github-update-files.js';
import {readUpdateState,writeUpdateState,updateJournal} from './github-update-store.js';
import {UPDATE_STATE_KEY} from './github-update-background.js';
const $=id=>document.getElementById(id);
localizeDocument(document);
let directory, latest, publicKey, busy=false;
const manifest=chrome.runtime.getManifest();
$('current-version').textContent=manifest.version;
function status(key,params={},state='ready') { $('status').textContent=t(key,params);$('status').dataset.state=state; }
function setBusy(value) {
  busy=value;
  for(const id of ['bind','check','recover','cancel']) $(id).disabled=value;
  $('check').disabled=value||!publicKey;
  $('install').disabled=value||!latest||!directory||!publicKey;
}
async function command(type,extra={}) {
  const result=await chrome.runtime.sendMessage({target:'background',type,...extra});
  if(!result?.ok) throw new Error(result?.error||t('update.noBackground'));
  return result;
}
async function resource(path) { const response=await fetch(chrome.runtime.getURL(path),{cache:'no-store'});if(!response.ok) throw new Error(t('update.directoryMismatch'));return response.text(); }
async function permission() {
  if(!directory) throw new Error(t('update.unbound'));
  // 必须由按钮的用户手势直接进入；网络下载、暂停任务等 await 放在权限确认之后。
  if(await directory.queryPermission({mode:'readwrite'})!=='granted' && await directory.requestPermission({mode:'readwrite'})!=='granted') throw new Error(t('update.permissionDenied'));
}
async function showRecovery() {
  const journal=await updateJournal.get();
  const pending=(await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY];
  $('recover').hidden=!journal;
  $('cancel').hidden=Boolean(journal)||!pending;
  if(journal||pending) { latest=null;setBusy(false);status('update.recoveryRequired',{},'error'); }
  return Boolean(journal||pending);
}
function failure(error) { status('update.failed',{error:error.message||String(error)},'error'); }
$('bind').addEventListener('click',async()=>{
  if(busy)return;
  try {
    const selected=await showDirectoryPicker({mode:'readwrite',id:'haineicunzhi-install'});
    setBusy(true);
    await bindInstallDirectory(selected,{manifest,readResource:resource});
    await writeUpdateState('directory',selected);directory=selected;
    $('directory-name').textContent=directory.name;status('update.bound');
  } catch(error) { if(error.name!=='AbortError')failure(error); }
  finally {setBusy(false);}
});
$('check').addEventListener('click',async()=>{
  if(busy)return;
  try {
    // 可选域名权限只在主动检查时申请；商店包没有此页及这些权限。
    const granted=await chrome.permissions.request({origins:[...GITHUB_ORIGINS]});
    if(!granted)throw new Error(t('update.networkDenied'));
    setBusy(true);status('update.checking');
    if(await showRecovery())return;
    latest=await findLatestUpdate(manifest.version);
    $('latest-version').textContent=latest?.version||'—';
    status(latest?'update.available':'update.none',latest||{});
  } catch(error){latest=null;failure(error);}
  finally{setBusy(false);}
});
$('install').addEventListener('click',async()=>{
  if(busy||!latest)return;
  let ownsPreparation=false;
  try {
    const allowing=permission();setBusy(true);await allowing;
    await withUpdateFileLock(async()=>{
    await bindInstallDirectory(directory,{manifest,readResource:resource});
    status('update.verifying');
    const envelope=await readLimitedJson(await fetch(latest.url,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(60000)}));
    const verified=await verifyUpdateEnvelope(envelope,publicKey,{currentVersion:manifest.version,chromeVersion:navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1]});
    if(verified.version!==latest.version)throw new Error(t('update.versionMismatch'));
    // 固定信任根不允许普通热更新悄悄轮换。轮换需重新下载并明确安装。
    const keyFile=verified.files.get('update-public-key.json');
    const nextKey=keyFile&&JSON.parse(new TextDecoder().decode(keyFile)).publicKey;
    if(!nextKey||nextKey.x!==publicKey.x||nextKey.y!==publicKey.y||nextKey.crv!==publicKey.crv)throw new Error(t('update.keyChanged'));
    const files=prepareUpdateFiles(verified,manifest,chrome.runtime.id);
    status('update.pausing');
    await command('UPDATER_PREPARE',{version:verified.version,refreshTabs:$('refresh-tabs').checked});
    ownsPreparation=true;
    await command('UPDATER_WRITING');
    await applyUpdate(files,directoryIO(directory),updateJournal,{fromVersion:manifest.version,toVersion:verified.version,packageHash:verified.packageHash,onProgress:(done,total)=>status('update.writing',{done,total})});
    status('update.reloading');await command('UPDATER_RELOAD');busy=false;
    // 持有文件锁直至旧上下文被重载销毁；若 Chrome 拒绝重载，超时后才允许恢复。
    await new Promise((_,reject)=>setTimeout(()=>reject(new Error(t('update.reloadFailed'))),15000));
    });
    // reload 会关闭此页；新后台读持久状态打开续接页，不能在旧页提前显示成功。
  } catch(error){
    const journal=await updateJournal.get().catch(()=>true);
    if(ownsPreparation&&!journal)await command('UPDATER_CANCEL').catch(()=>{});
    await showRecovery();failure(error);setBusy(false);
  }
});
$('recover').addEventListener('click',async()=>{
  if(busy)return;
  try {
    const allowing=permission();setBusy(true);await allowing;status('update.restoring');
    await withUpdateFileLock(async()=>{
    await rollbackUpdate(directoryIO(directory),updateJournal);
    // 新后台损坏时仍可由本地扩展页恢复文件；下次旧后台启动负责解锁及续传。
    const state=(await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY];
    if(state)await chrome.storage.local.set({[UPDATE_STATE_KEY]:{...state,stage:'prepared',shownVersion:null}});
    busy=false;chrome.runtime.reload();
    });
  } catch(error){failure(error);setBusy(false);}
});
$('cancel').addEventListener('click',async()=>{
  try{setBusy(true);await withUpdateFileLock(()=>command('UPDATER_CANCEL'));$('cancel').hidden=true;status('update.canceled');}
  catch(error){failure(error);}finally{setBusy(false);}
});
// 文件提交期间禁止误关页面；Chrome 仍可能被强制关闭，恢复日志因此必须持久化。
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
async function initialize() {
  try {
    if(DISTRIBUTION==='store')throw new Error(t('update.wrongChannel'));
    directory=await readUpdateState('directory');if(directory)$('directory-name').textContent=directory.name;
    const config=await (await fetch(chrome.runtime.getURL('update-public-key.json'))).json();publicKey=config.publicKey;
    const state=(await chrome.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY];
    if(state?.stage==='reloading'&&state.targetVersion===manifest.version){
      setBusy(true);const result=await withUpdateFileLock(()=>command('UPDATER_FINISH'));
      status(result.paused?.some(item=>!item.resumed)?'update.successPaused':'update.success',{version:result.version},'success');
    } else if(!await showRecovery())status(publicKey?'update.ready':'update.noKey');
    if(!publicKey)$('check').disabled=true;
  } catch(error){await showRecovery().catch(()=>{});failure(error);}
  finally{setBusy(false);if(!publicKey)$('check').disabled=true;}
}
void initialize();
