/** @param {object} video @returns {number} 已确认落盘量；完成后的体积允许因合并/提取而改变。 */
export function committedBytes(video) {
  const bytes = video.status === 'complete' ? video.downloadedBytes : video.committedBytes ?? video.resumeBytes ?? video.downloadedBytes;
  return Math.max(0, Number(bytes) || 0);
}
/** @param {object} video @returns {number} 不把在途、可能重试丢弃的字节当作已缓存进度。 */
export function taskProgress(video) {
  if (video.status === 'complete') return 1;
  if (['merging', 'extracting'].includes(video.stage) || video.mergeStage === 'merging') return Math.min(.999, Math.max(0, Number(video.progress) || 0));
  const received = Math.max(0, Number(video.downloadedBytes) || 0);
  // 保留生产端对未知轨道总量的估算比例，只将分子替换成确认落盘量。
  const progress = received > 0 && Number.isFinite(video.progress)
    ? video.progress * committedBytes(video) / received
    : committedBytes(video) / (Number(video.totalBytes) || Infinity);
  return Math.min(.999, Math.max(0, progress));
}
/** @param {object} a @param {object} b @returns {number} 创建顺序不随下载活动变化，旧记录按 ID 兜底。 */
export function compareLibraryTasks(a, b) {
  return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || String(a.id).localeCompare(String(b.id), 'en');
}
/** @param {object|undefined} previous @param {object} incoming @returns {object} 抵御轮询和推送乱序，不伪造单调进度。 */
export function newerTask(previous, incoming) {
  if (!previous) return incoming;
  for (const field of ['runStartedAt', 'updatedAt']) {
    const difference = (Number(incoming[field]) || 0) - (Number(previous[field]) || 0);
    if (difference) return difference > 0 ? incoming : previous;
  }
  if (previous.status === 'complete' && incoming.status !== 'complete') return previous;
  if (previous.status === incoming.status && previous.stage === incoming.stage && committedBytes(previous) > committedBytes(incoming)) return previous;
  return incoming;
}
/** @param {{value:number, at:number, run:number}|null} previous @param {object} video @param {number} now @returns {{value:number, at:number, run:number}} */
export function sampleSpeed(previous, video, now = Date.now()) {
  const at = Number(video.updatedAt) || now, run = Number(video.runStartedAt) || 0;
  if (video.status !== 'downloading' || video.error || ['merging','extracting'].includes(video.stage) || video.mergeStage === 'merging' || now - at > 4000) return { value: 0, at, run };
  const raw = Math.max(0, Number(video.speed) || 0);
  if (!previous || previous.run !== run) return { value: raw, at, run };
  if (at <= previous.at) return previous;
  // 约两秒时间常数的 EWMA；重复轮询同一快照不再加权，采样频率变化也不会改变手感。
  const alpha = 1 - Math.exp(-Math.min(at - previous.at, 4000) / 2000);
  return { value: previous.value + alpha * (raw - previous.value), at, run };
}
/** @param {object[]} videos @param {number} tabId @returns {{text:string,color:string,title:string}} */
export function taskBadge(videos, tabId) {
  const tasks = videos.filter(video => video.tabId === tabId);
  const active = tasks.filter(video => video.status === 'downloading');
  if (active.length > 1) return { text: active.length > 99 ? '99+' : `${active.length}↓`, color: '#fb7299', title: `${active.length} 个缓存任务进行中（含等待续传）` };
  if (active.length === 1) return { text: String(Math.min(99, Math.floor(taskProgress(active[0]) * 100))), color: '#fb7299', title: `正在缓存：${active[0].partTitle || active[0].title || '视频'}` };
  if (tasks.some(video => video.status === 'error')) return { text: '!', color: '#8b5b64', title: '有缓存任务需要处理' };
  if (tasks.some(video => video.status === 'complete')) return { text: '✓', color: '#1682a7', title: '缓存已完成' };
  return { text: '', color: '#1682a7', title: '影哨' };
}
