// 可控的是异步消息和数据库快照；测试不接管 popup 的状态机或渲染。
const pageId = 'BV1Kg8t6NEmN:456';
const url = 'https://www.bilibili.com/video/BV1Kg8t6NEmN/';
const videos = [], starts = [], storage = {};
let listener, mode = 'video';
const test = window.__startupTest = {
  videos, starts, lists: 0, holdLists: false,
  publish(patch = {}, emit = true) {
    const quality = patch.quality || 80, audio = patch.cacheMode === 'audio';
    const at = Date.now();
    const video = {
      id: audio ? `${pageId}:a` : `${pageId}:q${quality}:cauto`, pageId, bvid: 'BV1Kg8t6NEmN', cid: 456,
      title: '缓存启动状态测试', url, quality, requestedQuality: quality, codec: 'avc', requestedCodec: 'auto',
      cacheMode: 'video', mediaKind: 'dash', createdAt: at, runStartedAt: at, updatedAt: at,
      status: 'downloading', totalBytes: 16 * 1024 * 1024, committedBytes: 4 * 1024 * 1024,
      downloadedBytes: 4 * 1024 * 1024, resumeBytes: 4 * 1024 * 1024, progress: .25, speed: 1024,
      ...patch
    };
    const index = videos.findIndex(item => item.id === video.id);
    if (index < 0) videos.push(video); else videos[index] = video;
    if (emit) listener({ target: 'popup', type: video.status === 'error' ? 'CACHE_ERROR' : 'CACHE_PROGRESS', video: structuredClone(video) });
    return video;
  },
  reply(index, response = { ok: true, started: true }) { starts[index].resolve(response); }
};
globalThis.chrome = {
  storage: { local: {
    async get(key) { return { [key]: structuredClone(storage[key]) }; },
    async set(values) { Object.assign(storage, structuredClone(values)); }
  } },
  tabs: { async query() { return [{ id: 7, url }]; }, async create() {} },
  runtime: {
    connect() { return { postMessage() {}, onDisconnect: { addListener() {} } }; },
    onMessage: { addListener(callback) { listener = callback; } },
    async sendMessage(message) {
      switch (message.type) {
        case 'GET_CACHE_MODE': return { ok: true, mode };
        case 'SET_CACHE_MODE': mode = message.mode; return { ok: true, mode };
        case 'SET_POPUP_SELECTION': return { ok: true, saved: true };
        case 'GET_ASSIST_STATE': return { ok: true, config: { mode: 'off' }, stats: {} };
        case 'GET_HEALTH': return { ok: true, report: { ok: true, checks: [] } };
        case 'GET_POPUP_SNAPSHOT': return { ok: true, stale: false, snapshot: {
          pageInfo: { supported: true, id: pageId, bvid: 'BV1Kg8t6NEmN', cid: 456, url, title: '缓存启动状态测试', page: 1, pageCount: 1, duration: 60 },
          qualities: [{ quality: 80, label: '1080P' }, { quality: 64, label: '720P' }],
          selectedQuality: 80, defaultQuality: 80, auth: {},
          cacheSizeInfo: { duration: 60, video: [], audio: [{ id: 30280, mimeType: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 128000, hasSource: true }] }
        } };
        case 'LIST_VIDEOS': {
          test.lists++;
          if (test.holdLists) await new Promise(() => {});
          return { ok: true, videos: structuredClone(videos) };
        }
        case 'START_CACHE': return new Promise(resolve => starts.push({ message, resolve }));
        default: throw new Error(`未实现的消息 ${message.type}`);
      }
    }
  }
};
await import('../src/popup.js');
