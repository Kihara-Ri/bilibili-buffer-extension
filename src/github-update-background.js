import { compareVersions } from './github-update-protocol.js';
import { t } from './i18n.js';
export const UPDATE_STATE_KEY = 'githubUpdatePendingV1';
const SAVING_KEY = 'githubUpdateSavingV1';

/**
 * 更新锁是 storage.local 中的事实，不能依赖 SW 的常驻全局状态。文件另存为的在途状态
 * 放 session，以覆盖 SW 休眠；浏览器完全退出后 Blob 保存本来也无法继续。
 * @param {object} deps @returns {object}
 */
export function createUpdateCoordinator(deps) {
  const { runtime, storage, session } = deps;
  let queue = Promise.resolve();
  const serial = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  const read = async () => (await storage.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] || null;
  const write = state => storage.set({ [UPDATE_STATE_KEY]: state });
  const saves = async () => (await session.get(SAVING_KEY))[SAVING_KEY] || [];
  const ownPage = sender => sender?.url?.split(/[?#]/)[0] === runtime.getURL('update.html');
  async function assertUnlocked() { if (await read()) throw new Error(t('update.wait')); }
  async function release(state) {
    await write(null);
    return deps.thaw(state?.pausedIds || []);
  }
  return {
    assertUnlocked,
    isLocked: async () => Boolean(await read()),
    async withSave(operation) {
      const token = crypto.randomUUID();
      await serial(async () => { await assertUnlocked(); await session.set({ [SAVING_KEY]: [...await saves(), token] }); });
      try { return await operation(); }
      finally { await serial(async () => session.set({ [SAVING_KEY]: (await saves()).filter(value => value !== token) })); }
    },
    async startup() {
      const state = await read();
      if (!state) return;
      if ((state.stage === 'preparing' || state.stage === 'prepared') && !await deps.getJournal()) {
        // SW 在真正写文件前重启，取消旧准备动作；旧更新页的 owner/stage 已失效，不能继续写。
        await release(state);
        return;
      }
      const version = runtime.getManifest().version;
      if (state.shownVersion !== version) {
        await write({ ...state, shownVersion: version });
        await deps.openPage();
      }
    },
    async handle(message, sender) {
      if (!String(message?.type || '').startsWith('UPDATER_')) return null;
      if (!ownPage(sender)) throw new Error('Update command sender rejected');
      return serial(async () => {
        let state = await read();
        if (message.type === 'UPDATER_STATE') return { state };
        if (message.type === 'UPDATER_PREPARE') {
          if (state) throw new Error(t('update.wait'));
          if (compareVersions(message.version, runtime.getManifest().version) <= 0) throw new Error('Invalid target version');
          if ((await saves()).length || await deps.hasSaving?.()) throw new Error(t('update.saving'));
          state = { stage: 'preparing', targetVersion: message.version, fromVersion: runtime.getManifest().version, ownerTabId: sender.tab?.id, pausedIds: [], refreshTabs: message.refreshTabs === true, createdAt: Date.now() };
          await write(state);
          try {
            state.pausedIds = await deps.freeze(async ids => { state.pausedIds = ids; await write(state); });
            state.stage = 'prepared';
            await write(state);
          } catch (error) { await release(state); throw error; }
          return { state };
        }
        if (!state) throw new Error('No pending update');
        if (message.type === 'UPDATER_WRITING') {
          if (state.stage !== 'prepared' || sender.tab?.id !== state.ownerTabId) throw new Error('Update owner mismatch');
          await write({ ...state, stage: 'writing' });
          return { ready: true };
        }
        if (message.type === 'UPDATER_RELOAD') {
          const journal = await deps.getJournal();
          if (state.stage !== 'writing' || sender.tab?.id !== state.ownerTabId || journal?.stage !== 'awaiting-reload' || journal.toVersion !== state.targetVersion) throw new Error('Update files are not verified');
          await write({ ...state, stage: 'reloading' });
          // 先让消息回调完成，再销毁扩展页；新版本 onInstalled 会打开续接页面。
          setTimeout(() => runtime.reload(), 100);
          return { reloading: true };
        }
        if (message.type === 'UPDATER_FINISH') {
          const journal = await deps.getJournal();
          if (state.stage !== 'reloading' || runtime.getManifest().version !== state.targetVersion || journal?.toVersion !== state.targetVersion || journal.stage !== 'awaiting-reload') throw new Error('New extension version is not confirmed');
          const health = await deps.ping();
          if (health?.version !== state.targetVersion) throw new Error('New download document is not ready');
          await deps.completeJournal();
          const paused = await release(state);
          if (state.refreshTabs) await deps.refresh();
          return { updated: true, version: state.targetVersion, paused };
        }
        if (message.type === 'UPDATER_CANCEL') {
          if (sender.tab?.id !== state.ownerTabId && await deps.ownerAlive?.(state.ownerTabId) !== false) throw new Error(t('update.otherPage'));
          const journal = await deps.getJournal();
          if (journal && journal.stage !== 'complete') throw new Error('Restore update files before unlocking');
          await release(state);
          return { canceled: true };
        }
        throw new Error('Unknown update command');
      });
    }
  };
}
