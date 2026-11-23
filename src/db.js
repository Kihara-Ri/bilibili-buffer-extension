import { compareLibraryTasks } from "./task-presentation.js";

const DB_NAME = "bili-buffer-cache";
const DB_VERSION = 1;
const VIDEO_STORE = "videos";
const CHUNK_STORE = "chunks";

let dbPromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("数据库事务已取消")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("数据库事务失败")), { once: true });
  });
}

export function openCacheDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        const videos = db.createObjectStore(VIDEO_STORE, { keyPath: "id" });
        videos.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = db.createObjectStore(CHUNK_STORE, {
          keyPath: ["videoId", "track", "index"]
        });
        chunks.createIndex("videoId", "videoId");
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      dbPromise = null;
      reject(request.error);
    }, { once: true });
  });

  return dbPromise;
}

export async function getVideo(id) {
  const db = await openCacheDb();
  const transaction = db.transaction(VIDEO_STORE, "readonly");
  return requestToPromise(transaction.objectStore(VIDEO_STORE).get(id));
}

export async function putVideo(video) {
  const db = await openCacheDb();
  const transaction = db.transaction(VIDEO_STORE, "readwrite");
  transaction.objectStore(VIDEO_STORE).put(video);
  await transactionDone(transaction);
  return video;
}

export async function listVideos() {
  const db = await openCacheDb();
  const transaction = db.transaction(VIDEO_STORE, "readonly");
  const values = await requestToPromise(transaction.objectStore(VIDEO_STORE).getAll());
  return values.sort(compareLibraryTasks);
}

/** BVID 是新旧任务主键的共同前缀。按主键范围查单个投稿，无需升级片库或扫描其他视频。 */
export async function listVideosForBvid(bvid) {
  const db = await openCacheDb();
  const transaction = db.transaction(VIDEO_STORE, "readonly");
  const prefix = bvid + ":";
  const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
  return requestToPromise(transaction.objectStore(VIDEO_STORE).getAll(range));
}

export async function putChunk(videoId, track, index, data) {
  const db = await openCacheDb();
  const transaction = db.transaction(CHUNK_STORE, "readwrite");
  transaction.objectStore(CHUNK_STORE).put({ videoId, track, index, data });
  await transactionDone(transaction);
}

export async function putChunksAndVideo(video, chunks) {
  const db = await openCacheDb();
  const transaction = db.transaction([VIDEO_STORE, CHUNK_STORE], "readwrite");
  const videoStore = transaction.objectStore(VIDEO_STORE);
  const chunkStore = transaction.objectStore(CHUNK_STORE);
  for (const chunk of chunks) {
    chunkStore.put({
      videoId: chunk.videoId || video.id,
      track: chunk.track,
      index: chunk.index,
      data: chunk.data
    });
  }
  videoStore.put(video);
  await transactionDone(transaction);
  return video;
}

function trackRange(videoId, track) {
  return IDBKeyRange.bound([videoId, track, 0], [videoId, track, Number.MAX_SAFE_INTEGER]);
}

/**
 * 发布写完并校验过的本地产物。终态与源分块释放同一事务提交，避免恢复时按已删除的源轨道续传。
 * @param {object} video 完成记录
 * @param {string[]} sourceTracks 被产物替代的轨道名
 * @returns {Promise<object>} 已提交的记录
 */
export async function publishVideoAsset(video, sourceTracks) {
  const db = await openCacheDb();
  const transaction = db.transaction([VIDEO_STORE, CHUNK_STORE], "readwrite");
  const chunks = transaction.objectStore(CHUNK_STORE);
  for (const track of sourceTracks) chunks.delete(trackRange(video.id, track));
  transaction.objectStore(VIDEO_STORE).put(video);
  await transactionDone(transaction);
  return video;
}

export async function getChunks(videoId, track = "media") {
  const db = await openCacheDb();
  const transaction = db.transaction(CHUNK_STORE, "readonly");
  const range = trackRange(videoId, track);
  const chunks = await requestToPromise(transaction.objectStore(CHUNK_STORE).getAll(range));
  return chunks.sort((a, b) => a.index - b.index);
}

/** 记录水位和分块从同一个读事务取得。直接用主键去读交叉的块，长视频跳转无须遍历源轨道。
 * @param {string} videoId @param {string} role @param {number} start @param {number} end
 * @param {(video: object) => object|null} select @returns {Promise<{track: object, chunks: object[]}|null>}
 */
export async function readCommittedChunks(videoId, role, start, end, select) {
  const db = await openCacheDb();
  const transaction = db.transaction([VIDEO_STORE, CHUNK_STORE], "readonly");
  const video = await requestToPromise(transaction.objectStore(VIDEO_STORE).get(videoId));
  const track = select(video);
  if (!track || end > track.end) return null;
  const first = Math.floor(start / track.chunkBytes), last = Math.floor((end - 1) / track.chunkBytes);
  const store = transaction.objectStore(CHUNK_STORE);
  const chunks = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) =>
    requestToPromise(store.get([videoId, role, first + i]))));
  return { track, chunks };
}

export async function clearChunks(videoId, track = null) {
  const db = await openCacheDb();
  const transaction = db.transaction(CHUNK_STORE, "readwrite");
  const store = transaction.objectStore(CHUNK_STORE);
  const range = track
    ? trackRange(videoId, track)
    : IDBKeyRange.bound([videoId, ""], [videoId, "\uffff"]);
  store.delete(range);
  await transactionDone(transaction);
}

export async function deleteVideoData(videoId) {
  const db = await openCacheDb();
  const transaction = db.transaction([VIDEO_STORE, CHUNK_STORE], "readwrite");
  transaction.objectStore(VIDEO_STORE).delete(videoId);
  const chunkStore = transaction.objectStore(CHUNK_STORE);
  const index = chunkStore.index("videoId");
  const cursorRequest = index.openKeyCursor(IDBKeyRange.only(videoId));
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    chunkStore.delete(cursor.primaryKey);
    cursor.continue();
  });
  await transactionDone(transaction);
}
