/** 供单元测试使用的最小 IndexedDB 假实现：支持本仓库用到的 store/index/getAll/put/delete/clear。
 * 数据立即生效，回调按微任务顺序触发，事务在最后一个请求结束后触发 oncomplete——
 * 足够复现「在 onsuccess 里继续 delete/put」这类真实事务写法。
 * @param {Map<string, Map<string, object>>} [database]
 * @returns {IDBFactory}
 */
export function createFakeIndexedDB(database = new Map()) {
  const factory = {
    open(name, version = 1) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      const existing = database.get(name);
      const stores = existing?.stores || new Map();
      const db = {
        name,
        version,
        objectStoreNames: { contains: (key) => stores.has(key) },
        createObjectStore(key) { const rows = new Map(); stores.set(key, rows); return makeStore(rows); },
        transaction(key) { return makeTransaction(stores.get(key), database, name, stores); },
        close() {}
      };
      database.set(name, { stores });
      queueMicrotask(() => {
        request.result = db;
        if (!existing) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
  return /** @type {IDBFactory} */ (factory);
}

function makeRequest(tx, run) {
  const request = { result: undefined, error: null, onsuccess: null, onerror: null, oncomplete: null };
  tx.begin();
  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.();
    } catch (error) {
      request.error = error;
      request.onerror?.();
    }
    tx.end();
  });
  return request;
}

function makeTransaction(rows, database, name, stores) {
  const tx = {
    error: null,
    oncomplete: null,
    onabort: null,
    pending: 0,
    begin() { this.pending += 1; },
    end() {
      this.pending -= 1;
      if (this.pending <= 0) queueMicrotask(() => { if (this.pending <= 0) tx.oncomplete?.(); });
    }
  };
  if (!rows) {
    queueMicrotask(() => { tx.error = new Error("缺少对象仓库"); tx.onabort?.(); });
    return tx;
  }
  tx.objectStore = () => makeStore(rows, tx);
  // 让测试能断言数据库内容的辅助入口。
  tx.__rows = () => [...rows.values()];
  void database; void name; void stores;
  return tx;
}

function makeStore(rows, tx = { begin() {}, end() {} }) {
  return {
    keyPath: "id",
    createIndex() { return makeIndex(rows, tx); },
    index() { return makeIndex(rows, tx); },
    getAll: () => makeRequest(tx, () => [...rows.values()]),
    put: (row) => makeRequest(tx, () => { rows.set(row.id, row); return row.id; }),
    delete: (id) => makeRequest(tx, () => { rows.delete(id); return undefined; }),
    clear: () => makeRequest(tx, () => { rows.clear(); return undefined; })
  };
}

function makeIndex(rows, tx) {
  return {
    getAll: (value) => makeRequest(tx, () => [...rows.values()].filter((row) => row.source === value))
  };
}
