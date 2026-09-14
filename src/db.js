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

export async function getChunks(videoId, track = "media") {
  const db = await openCacheDb();
  const transaction = db.transaction(CHUNK_STORE, "readonly");
  const range = IDBKeyRange.bound([videoId, track, 0], [videoId, track, Number.MAX_SAFE_INTEGER]);
  const chunks = await requestToPromise(transaction.objectStore(CHUNK_STORE).getAll(range));
  return chunks.sort((a, b) => a.index - b.index);
}

export async function clearChunks(videoId, track = null) {
  const db = await openCacheDb();
  const transaction = db.transaction(CHUNK_STORE, "readwrite");
  const store = transaction.objectStore(CHUNK_STORE);
  const range = track
    ? IDBKeyRange.bound([videoId, track, 0], [videoId, track, Number.MAX_SAFE_INTEGER])
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
