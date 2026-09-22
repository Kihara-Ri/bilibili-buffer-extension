import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

/**
 * 连接指定的现有 macOS Chrome；不启动浏览器、不复制 profile、不导出凭据。
 * 必须由用户在 Chrome 开启「允许 Apple 事件中的 JavaScript」。
 * @param {string} pid Chrome 主进程 ID（同名进程可能属于不同 profile）。
 * @param {string} tabId 已打开的目标标签 ID。
 * @returns {(code: string) => Promise<string>} 仅返回页面表达式的结果。
 */
export function createChromeEvaluator(pid, tabId) {
  if (!/^\d+$/.test(pid || '') || !/^\d+$/.test(tabId || '')) throw Error('需要现有 Chrome 的进程 ID 和标签 ID');
  return async code => {
    // 被 Chrome 丢弃/冻结的后台标签可能不响应 Apple Events，先激活指定标签。
    const script = `const c=Application(${pid});const w=c.windows().find(w=>w.tabs().some(t=>t.id()===${JSON.stringify(tabId)}));if(!w)throw Error('Target tab missing');const tabs=w.tabs();const index=tabs.findIndex(t=>t.id()===${JSON.stringify(tabId)});w.activeTabIndex=index+1;tabs[index].execute({javascript:${JSON.stringify(code)}});`;
    return (await exec('osascript', ['-l', 'JavaScript', '-e', script], {timeout:30000,maxBuffer:2*1024*1024})).stdout.trim();
  };
}
