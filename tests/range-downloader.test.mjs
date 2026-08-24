import test from "node:test";
import assert from "node:assert/strict";
import {
  buildByteRanges,
  downloadByteRanges,
  rankRangeCandidates
} from "../src/range-downloader.js";

test("固定范围覆盖剩余字节且没有重叠", () => {
  assert.deepEqual(buildByteRanges(3, 14, 4), [
    { ordinal: 0, start: 3, end: 6 },
    { ordinal: 1, start: 7, end: 10 },
    { ordinal: 2, start: 11, end: 13 }
  ]);
});

test("CDN 测速会把更快且总大小一致的候选排在前面", async () => {
  const data = new Uint8Array(1024);
  const fetchImpl = async (url, init) => {
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(startText);
    const end = Math.min(Number(endText), data.length - 1);
    if (url.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 12));
    return rangeResponse(data, start, end);
  };
  const ranked = await rankRangeCandidates([
    "https://slow.example/video",
    "https://fast.example/video"
  ], { fetchImpl, probeSize: 128 });
  assert.equal(ranked.urls[0], "https://fast.example/video");
  assert.equal(ranked.totalBytes, 1024);
  assert.ok(Number.isFinite(ranked.probes[0].ttfbMs));
  assert.ok(Number.isFinite(ranked.probes[0].throughputKbps));
});

test("成功但首字节持续偏慢时，后续分块主动改用备用 CDN", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, index) => index);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Range]);
    if (url.includes("primary")) await new Promise((resolve) => setTimeout(resolve, 220));
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return rangeResponse(data, Number(startText), Number(endText));
  };
  const result = await downloadByteRanges({
    urls: ["https://primary.example/video", "https://backup.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: 4,
    concurrency: 1,
    slowTtfbMs: 200,
    fetchImpl,
    onCommit: async () => {}
  });
  assert.deepEqual(calls.map(([url]) => new URL(url).hostname), [
    "primary.example",
    "backup.example",
    "backup.example"
  ]);
  assert.equal(result.metrics.slowRequestCount, 1);
  assert.equal(result.metrics.cdnSwitchCount, 1);
  assert.equal(result.metrics.cdnHost, "backup.example");
  assert.ok(result.metrics.hosts["primary.example"].ttfbP50 >= 200);
});

test("CDN 测速的卡死候选会超时，不会拖住已成功的节点", async () => {
  const data = new Uint8Array(1024);
  const fetchImpl = async (url, init) => {
    if (url.includes("stalled")) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return rangeResponse(data, Number(startText), Math.min(Number(endText), data.length - 1));
  };
  const startedAt = performance.now();
  const ranked = await rankRangeCandidates([
    "https://stalled.example/video",
    "https://fast.example/video"
  ], { fetchImpl, probeSize: 128, timeoutMs: 12 });
  assert.equal(ranked.urls[0], "https://fast.example/video");
  assert.ok(performance.now() - startedAt < 100);
});

test("默认 fetch 保留浏览器 Window 调用上下文", async () => {
  const originalFetch = globalThis.fetch;
  const data = Uint8Array.from({ length: 8 }, (_, index) => index);
  let calls = 0;
  globalThis.fetch = function (_url, init) {
    assert.equal(this, globalThis);
    calls += 1;
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return Promise.resolve(rangeResponse(
      data,
      Number(startText),
      Math.min(Number(endText), data.length - 1)
    ));
  };
  try {
    const ranked = await rankRangeCandidates(["https://cdn.example/video"], { probeSize: 2 });
    await downloadByteRanges({
      urls: ranked.urls,
      start: 0,
      totalBytes: ranked.totalBytes,
      rangeSize: 4,
      concurrency: 2,
      onCommit: async () => {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 3);
});

test("三路并发乱序完成仍按索引顺序提交", async () => {
  const data = Uint8Array.from({ length: 20 }, (_, index) => index);
  const committed = [];
  const fetchImpl = async (_url, init) => {
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(startText);
    const end = Number(endText);
    await new Promise((resolve) => setTimeout(resolve, start === 0 ? 18 : start === 5 ? 2 : 7));
    return rangeResponse(data, start, end);
  };
  const result = await downloadByteRanges({
    urls: ["https://cdn.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: 5,
    concurrency: 3,
    fetchImpl,
    onCommit: async (batch) => committed.push(...batch.map((entry) => entry.range.ordinal))
  });
  assert.deepEqual(committed, [0, 1, 2, 3]);
  assert.equal(result.metrics.committedBytes, data.length);
  assert.equal(result.metrics.requestCount, 4);
});

test("某个 CDN 分块失败时切换备用地址并保持范围不变", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, index) => index);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.Range]);
    if (url.includes("primary") && init.headers.Range === "bytes=4-7") {
      return new Response("bad", { status: 503 });
    }
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return rangeResponse(data, Number(startText), Number(endText));
  };
  const committed = [];
  const result = await downloadByteRanges({
    urls: ["https://primary.example/video", "https://backup.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: 4,
    concurrency: 2,
    fetchImpl,
    onCommit: async (batch) => committed.push(...batch.map((entry) => entry.range.ordinal))
  });
  assert.deepEqual(committed, [0, 1, 2]);
  assert.ok(calls.some(([url, range]) => url.includes("backup") && range === "bytes=4-7"));
  assert.equal(result.metrics.retryCount, 1);
});

test("CDN 分块连接卡死时按超时切换备用地址", async () => {
  const data = Uint8Array.from({ length: 8 }, (_, index) => index);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes("primary")) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return rangeResponse(data, Number(startText), Number(endText));
  };
  const result = await downloadByteRanges({
    urls: ["https://primary.example/video", "https://backup.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: data.length,
    concurrency: 1,
    timeoutMs: 12,
    fetchImpl,
    onCommit: async () => {}
  });
  assert.deepEqual(calls, ["https://primary.example/video", "https://backup.example/video"]);
  assert.equal(result.metrics.retryCount, 1);
  assert.equal(result.metrics.committedBytes, data.length);
});

test("前段失败时不会提交后面已完成的乱序分块", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, index) => index);
  const fetchImpl = async (_url, init) => {
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(startText);
    if (start === 0) {
      await new Promise((resolve) => setTimeout(resolve, 14));
      return new Response("fail", { status: 503 });
    }
    return rangeResponse(data, start, Number(endText));
  };
  const committed = [];
  await assert.rejects(downloadByteRanges({
    urls: ["https://cdn.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: 4,
    concurrency: 3,
    fetchImpl,
    onCommit: async (batch) => committed.push(...batch.map((entry) => entry.range.ordinal))
  }), /HTTP 503/);
  assert.deepEqual(committed, []);
});

test("原子提交回调失败时不会推进内部连续水位", async () => {
  const data = Uint8Array.from({ length: 8 }, (_, index) => index);
  let attempts = 0;
  await assert.rejects(downloadByteRanges({
    urls: ["https://cdn.example/video"],
    start: 0,
    totalBytes: data.length,
    rangeSize: 4,
    concurrency: 2,
    fetchImpl: async (_url, init) => {
      const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
      return rangeResponse(data, Number(startText), Number(endText));
    },
    onCommit: async () => {
      attempts += 1;
      throw new Error("IndexedDB transaction failed");
    }
  }), /IndexedDB transaction failed/);
  assert.equal(attempts, 1);
});

test("受单连接等待限制时三路并发明显快于顺序范围", async () => {
  const data = Uint8Array.from({ length: 12 }, (_, index) => index);
  const fetchImpl = async (_url, init) => {
    const [, startText, endText] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    await new Promise((resolve) => setTimeout(resolve, 28));
    return rangeResponse(data, Number(startText), Number(endText));
  };
  const run = async (concurrency) => {
    const startedAt = performance.now();
    await downloadByteRanges({
      urls: ["https://cdn.example/video"],
      start: 0,
      totalBytes: data.length,
      rangeSize: 4,
      concurrency,
      fetchImpl,
      onCommit: async () => {}
    });
    return performance.now() - startedAt;
  };
  const sequentialMs = await run(1);
  const parallelMs = await run(3);
  assert.ok(parallelMs < sequentialMs * 0.7, `顺序 ${sequentialMs}ms，并发 ${parallelMs}ms`);
});

function rangeResponse(data, start, end) {
  const body = data.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${start}-${end}/${data.length}`
    }
  });
}
