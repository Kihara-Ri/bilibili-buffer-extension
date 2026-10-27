import {bindInstallDirectory,inspectInstallDirectory} from './github-update-files.js';
import {t} from './i18n.js';

const MAX_DEPTH=3, MAX_ENTRIES=200;
const SKIP=new Set(['node_modules','vendor','coverage']);

/**
 * 只在用户授权范围内查找；匹配清单只是候选，仍需探针验证当前运行目录。
 * 限制层级及条目，避免用户误选整个磁盘后无界遍历；不进入源码仓库或隐藏目录。
 * @param {FileSystemDirectoryHandle} selected
 * @param {{manifest:object,readResource:Function}} options
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function connectInstallDirectory(selected, options) {
  const queue=[{directory:selected,depth:0}];
  let entries=0, truncated=false;
  for(let at=0;at<queue.length;at++) {
    const {directory,depth}=queue[at];
    try {
      await inspectInstallDirectory(directory,options);
      try { await bindInstallDirectory(directory,options);return directory; }
      catch(error) { if(error.code!=='update.directoryWrongInstallation')throw error; }
      // 完整扩展的内部文件夹不可能是另一个安装根，不继续深入副本。
      continue;
    } catch(error) {
      if(error.code==='update.directoryRepository') { if(at===0)throw error;continue; }
      if(error.code!=='update.directoryMissingManifest') {
        if(['update.directoryInvalidManifest','update.directoryWrongInstallation'].includes(error.code)) { if(at===0)throw error;continue; }
        throw error;
      }
    }
    for await(const child of directory.values()) {
      if(++entries>MAX_ENTRIES)throw new Error(t('update.directorySearchLimit'));
      if(child.kind!=='directory'||child.name.startsWith('.')||SKIP.has(child.name))continue;
      if(depth>=MAX_DEPTH) { truncated=true;continue; }
      queue.push({directory:child,depth:depth+1});
    }
  }
  throw new Error(t(truncated?'update.directorySearchLimit':'update.directoryNotFound'));
}
