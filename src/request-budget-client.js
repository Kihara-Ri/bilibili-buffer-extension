(() => {
  'use strict';
  const CHANNEL='bili-buffer-playback-assist-v1';
  const wait=(ms,signal)=>new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    const abort=()=>{stop();reject(signal.reason);};
    const timer=setTimeout(()=>{stop();resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  /** MAIN 只通过隔离桥访问租约；ID 相关响应有超时，不假造本地保命槽位。
   * @returns {(request:object)=>Promise<object>}
   */
  function createPageRpc() {
    const pending=new Map();
    window.addEventListener('message',event=>{
      const m=event.data;if(event.source!==window || m?.channel!==CHANNEL || m.dir!=='ext->page' || m.type!=='budgetReply')return;
      const item=pending.get(m.payload?.rpcId);if(!item)return;
      pending.delete(m.payload.rpcId);clearTimeout(item.timer);item.resolve(m.payload.result);
    });
    return request=>new Promise((resolve,reject)=>{
      if(pending.size>=128){reject(Error('请求预算通道繁忙'));return;}
      const rpcId=crypto.randomUUID();
      const timer=setTimeout(()=>{pending.delete(rpcId);reject(Error('请求预算桥超时'));},2500);
      pending.set(rpcId,{resolve,timer});
      window.postMessage({channel:CHANNEL,dir:'page->ext',type:'budgetRpc',payload:{...request,rpcId}},'*');
    });
  }
  /** 包装一次真实网络请求，直到正文结束/取消才释放租约。
   * @param {Function} fetcher @param {(request:object)=>Promise<object>} rpc
   * @returns {Function} 与 fetch 参数一致；失败不绕过预算，交由上层回退/重试。
   */
  function createBudgetFetch(fetcher,rpc) {
    return async (url,init={})=>{
      init.onBudgetWait?.(true);
      const id=crypto.randomUUID(), priority=init.priority==='high'?1:0;
      const controller=new AbortController();let reader,timer,finished=false,granted=false;
      const release=()=>{if(granted){granted=false;void rpc({op:'release',id}).catch(()=>{});}};
      const finish=()=>{if(finished)return;finished=true;clearTimeout(timer);init.signal?.removeEventListener('abort',abort);release();};
      const abort=()=>{controller.abort(init.signal?.reason);};
      init.signal?.addEventListener('abort',abort,{once:true});if(init.signal?.aborted)abort();
      const rpcCall=async request=>{
        let timedOut=false;
        const operation=Promise.resolve().then(()=>rpc(request));
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Error('请求预算服务超时'));},2000);});
        // 回包晚于截止时间时仍归还已获准槽位，不能把超时当成没有租到。
        void operation.then(r=>{if((timedOut||controller.signal.aborted)&&r?.lease)void rpc({op:'release',id}).catch(()=>{});},()=>{});
        let onAbort;
        const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();});
        try{return await Promise.race([operation,timeout,cancelled]);}finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);}
      };
      try{
        const began=Date.now();let reply;
        for(;;){
          if(controller.signal.aborted)throw controller.signal.reason;
          if(Date.now()-began>15000)throw Error('等待共享下载预算超时');
          reply=await rpcCall({op:'acquire',id,priority});
          if(!reply?.ok)throw Error('共享下载预算不可用');
          if(reply.lease){granted=true;break;}
          await wait(Math.max(50,Math.min(500,reply.retryAfterMs||150)),controller.signal);
        }
        if(controller.signal.aborted)throw controller.signal.reason;
        // 比服务端过期提前 1 秒取消。不得在过期后继续发起请求，也不依赖 SW 保活。
        const remaining=reply.lease.expiresAt-Date.now()-1000;
        if(!(remaining>0))throw Error('下载租约已过期');
        timer=setTimeout(()=>controller.abort(new DOMException('下载租约到期','TimeoutError')),remaining);
        init.onBudgetWait?.(false);
        const response=await fetcher(url,{...init,signal:controller.signal});
        if(!response.body){finish();return response;}
        reader=response.body.getReader();
        const stop=()=>{void reader.cancel(controller.signal.reason).catch(()=>{}).finally(finish);};
        controller.signal.addEventListener('abort',stop,{once:true});if(controller.signal.aborted)stop();
        const body=new ReadableStream({
          async pull(output){
            try{
              if(controller.signal.aborted)throw controller.signal.reason;
              const {done,value}=await reader.read();
              if(controller.signal.aborted)throw controller.signal.reason;
              if(done){controller.signal.removeEventListener('abort',stop);finish();output.close();}
              else output.enqueue(value);
            }catch(error){controller.signal.removeEventListener('abort',stop);finish();output.error(error);}
          },
          async cancel(reason){controller.abort(reason);try{await reader.cancel(reason);}finally{controller.signal.removeEventListener('abort',stop);finish();}}
        });
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      }catch(error){finish();throw error;}
    };
  }
  globalThis.BiliRequestBudget={createBudgetFetch,createPageRpc};
})();
