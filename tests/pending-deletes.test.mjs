import test from "node:test";
import assert from "node:assert/strict";
import { connectPendingDeletes, createPendingDeleteRegistry, PENDING_DELETE_PORT } from "../src/pending-deletes.js";

/** 一对互联的假 port：一端 postMessage 送到另一端，disconnect 只通知对端（与 Chrome 语义一致）。 */
function makePortPair(name = PENDING_DELETE_PORT) {
  const make = () => {
    const messageListeners = [];
    const disconnectListeners = [];
    return {
      name,
      peer: null,
      connected: true,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
      postMessage(message) {
        if (!this.connected) throw new Error("Attempting to use a disconnected port object");
        for (const listener of this.peer.messageListeners) listener(structuredClone(message));
      },
      disconnect() {
        if (!this.connected) return;
        this.connected = false;
        this.peer.connected = false;
        for (const listener of this.peer.disconnectListeners) listener();
      },
      messageListeners,
      disconnectListeners
    };
  };
  const popup = make();
  const background = make();
  popup.peer = background;
  background.peer = popup;
  return { popup, background };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const committed = [];
  const registry = createPendingDeleteRegistry({ commit: async (videoId) => { committed.push(videoId); } });
  const pairs = [];
  const pending = new Set();
  const connect = ({ name }) => {
    const pair = makePortPair(name);
    pairs.push(pair);
    registry.attach(pair.background);
    return pair.popup;
  };
  const channel = connectPendingDeletes({ connect, getPending: () => pending });
  return { committed, pairs, pending, channel };
}

test("弹窗关闭时，后台提交仍在撤销期内的删除", async () => {
  const { committed, pairs, pending, channel } = setup();
  for (const id of ["a", "b"]) { pending.add(id); channel.schedule(id); }
  // 弹窗被销毁：断开由浏览器通知后台一侧。
  pairs[0].popup.disconnect();
  await flush();
  assert.deepEqual(committed.sort(), ["a", "b"]);
});

test("已撤销或弹窗已自行提交的删除，关闭时不再提交", async () => {
  const { committed, pairs, pending, channel } = setup();
  for (const id of ["undone", "kept", "done"]) { pending.add(id); channel.schedule(id); }
  pending.delete("undone"); channel.release("undone");
  pending.delete("done"); channel.release("done");
  pairs[0].popup.disconnect();
  await flush();
  assert.deepEqual(committed, ["kept"]);
});

test("SW 重启断开 port 时不提交，弹窗重连后重报待删，最终由新连接在关闭时提交", async () => {
  const { committed, pairs, pending, channel } = setup();
  pending.add("x"); channel.schedule("x");
  // SW 被回收：弹窗一侧收到断开（后台旧登记随 SW 一起消失，不会也不该替用户提交）。
  pairs[0].background.disconnect();
  await flush();
  assert.equal(pairs.length, 2, "弹窗应立即重连");
  assert.deepEqual(committed, [], "SW 重启不能在撤销期内替用户提交删除");
  pending.add("y"); channel.schedule("y");
  pairs[1].popup.disconnect();
  await flush();
  assert.deepEqual(committed.sort(), ["x", "y"]);
});

test("别的 port 名与畸形消息被忽略；单条提交失败不影响其余", async () => {
  const committed = [];
  const errors = [];
  const registry = createPendingDeleteRegistry({
    commit: async (videoId) => { if (videoId === "bad") throw new Error("locked"); committed.push(videoId); },
    onError: (error, videoId) => errors.push([videoId, error.message])
  });
  assert.equal(registry.attach(makePortPair("other").background), false);
  const { popup, background } = makePortPair();
  assert.equal(registry.attach(background), true);
  popup.postMessage({ type: "schedule" });
  popup.postMessage({ type: "schedule", videoId: 42 });
  popup.postMessage({ type: "schedule", videoId: "bad" });
  popup.postMessage({ type: "schedule", videoId: "good" });
  popup.disconnect();
  await flush();
  assert.deepEqual(committed, ["good"]);
  assert.deepEqual(errors, [["bad", "locked"]]);
});
