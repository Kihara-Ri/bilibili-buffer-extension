import {createUpdateCoordinator} from './github-update-background.js';
import {updateJournal} from './github-update-store.js';
/** GitHub / 开发态入口；商店构建以无导入的空实现整体替换。 @param {object} deps @returns {object} */
export function createRuntimeUpdater(deps) {
  return createUpdateCoordinator({...deps, getJournal:()=>updateJournal.get(), completeJournal:()=>updateJournal.set(null)});
}
