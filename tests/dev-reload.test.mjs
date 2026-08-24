import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("../src/dev-reload.js", import.meta.url), "utf8"))
  .replaceAll("export ", "")
  .concat("\n;globalThis.__devReload = { startDevReloadBackground, startDevReloadPolling };\n");

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Offscreen 轮询仅通过 runtime 请求重载，不依赖受限的 storage API", async () => {
  const intervals = [];
  const messages = [];
  let revision = 100;
  const context = vm.createContext({
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return { ok: true };
        }
      }
    },
    fetch: async () => ({
      ok: true,
      async json() { return { ok: true, revision }; }
    }),
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    console
  });
  vm.runInContext(source, context);

  context.__devReload.startDevReloadPolling();
  await flush();
  assert.equal(intervals.length, 1);
  assert.equal(messages.length, 0);

  revision = 101;
  await intervals[0]();
  assert.equal(JSON.stringify(messages), JSON.stringify([{
    target: "dev-reload",
    type: "DEV_RELOAD_EXTENSION",
    revision: 101
  }]));
});

test("新后台读取持久标记后刷新已打开的 B 站页", async () => {
  const pendingKey = "devReloadPendingRevisionV2";
  const local = { [pendingKey]: 200 };
  const reloadedTabs = [];
  const responses = [];
  let runtimeReloads = 0;
  let messageListener;
  let offscreenStarts = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { messageListener = listener; }
        },
        reload() { runtimeReloads += 1; }
      },
      storage: {
        local: {
          async get(key) { return { [key]: local[key] }; },
          async remove(key) { delete local[key]; },
          async set(value) { Object.assign(local, value); }
        }
      },
      tabs: {
        async query() { return [{ id: 7 }, { id: null }]; },
        async reload(tabId) { reloadedTabs.push(tabId); }
      }
    },
    fetch: async () => ({ ok: false }),
    setInterval() { return 1; },
    console
  });
  vm.runInContext(source, context);

  context.__devReload.startDevReloadBackground(async () => { offscreenStarts += 1; });
  await flush();
  await flush();
  assert.equal(local[pendingKey], undefined);
  assert.deepEqual(reloadedTabs, [7]);
  assert.equal(offscreenStarts, 1);

  assert.equal(messageListener({
    target: "dev-reload",
    type: "DEV_RELOAD_EXTENSION",
    revision: 201
  }, {}, (response) => responses.push(response)), true);
  await flush();
  assert.equal(local[pendingKey], 201);
  assert.equal(runtimeReloads, 1);
  assert.equal(JSON.stringify(responses), JSON.stringify([{ ok: true }]));
});
