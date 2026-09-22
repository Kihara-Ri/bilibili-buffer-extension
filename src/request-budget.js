export const REQUEST_LEASE_MS = 45000;
const MAX_WAITERS = 64;
/** 消息发送者决定所有权，防止页面自称其他标签或 Offscreen。
 * @param {object} sender @param {string} extensionId @returns {string|null}
 */
export function budgetOwner(sender,extensionId) {
  if(sender?.id!==extensionId)return null;
  if(sender.url===`chrome-extension://${extensionId}/offscreen.html` && !sender.tab)return 'offscreen';
  if(!Number.isInteger(sender.tab?.id) || (sender.frameId||0)!==0)return null;
  try{const u=new URL(sender.url);if(u.origin!=='https://www.bilibili.com'||!/^\/(video|list)\//.test(u.pathname))return null;}catch{return null;}
  return `page:${sender.tab.id}:${sender.documentId||0}`;
}

/** 纯状态机：会话租约只记随机请求 ID，不记录媒体 URL、cookie 或账号。
 * @param {object|undefined} saved @param {{op:string,id:string,priority?:number}} request
 * @param {string} owner @param {number} capacity @param {number} now
 * @returns {{state:object,reply:object}}
 */
export function transitionBudget(saved, request, owner, capacity=32, now=Date.now()) {
  if (saved && (saved.version!==1 || !Array.isArray(saved.leases) || !Array.isArray(saved.waiters))) throw Error('请求预算状态损坏');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(request.id||'') || !owner) throw Error('请求预算身份无效');
  const cap=Math.max(1,Math.min(32,Math.floor(capacity)||32));
  const leases=(saved?.leases||[]).filter(l=>l.expiresAt>now);
  const waiters=(saved?.waiters||[]).filter(w=>now-w.at<5000 && w.owner!==owner);
  const state={version:1,leases,waiters};
  const existing=leases.find(l=>l.owner===owner && l.id===request.id);
  if(request.op==='release'){
    state.leases=leases.filter(l=>l!==existing);return {state,reply:{released:true}};
  }
  if(request.op!=='acquire')throw Error('未知请求预算操作');
  if(existing)return {state,reply:{lease:existing}};
  const priority=request.priority>0?1:0;
  state.waiters.push({owner,priority,at:now});
  if(state.waiters.length>MAX_WAITERS)state.waiters.splice(0,state.waiters.length-MAX_WAITERS);
  const own=leases.filter(l=>l.owner===owner).length;
  const contenders=new Set([...leases.map(l=>l.owner),...state.waiters.map(w=>w.owner)]).size;
  const share=Math.max(1,Math.ceil(cap/Math.max(1,contenders)));
  // 后台最多占四分之一，急需播放保留余量。已授予请求不抢占，防止丢字节与超发。
  const backgroundCap=Math.max(1,Math.floor(cap/4));
  const urgentWaiting=state.waiters.some(w=>w.owner!==owner && w.priority>0);
  const blocked=leases.length>=cap || own>=share || (!priority && (leases.filter(l=>!l.priority).length>=backgroundCap || urgentWaiting));
  if(blocked)return {state,reply:{lease:null,retryAfterMs:150}};
  const lease={owner,id:request.id,priority,expiresAt:now+REQUEST_LEASE_MS};
  state.leases.push(lease);return {state,reply:{lease}};
}

/** 单写者串行持久化：必须成功写入 session 后才能授予，SW 唤醒重新读账本。
 * @param {{get:Function,set:Function}} storage @param {()=>Promise<number>} capacity
 * @returns {(request:object,owner:string)=>Promise<object>}
 */
export function createBudgetService(storage,capacity) {
  let queue=Promise.resolve();
  return (request,owner)=>{
    const operation=queue.then(async()=>{
      const saved=await storage.get('requestBudgetV1');
      const {state,reply}=transitionBudget(saved?.requestBudgetV1,request,owner,await capacity());
      await storage.set({requestBudgetV1:state});
      return reply;
    });
    queue=operation.catch(()=>{});return operation;
  };
}
