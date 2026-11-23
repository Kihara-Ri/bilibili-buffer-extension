import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createBilibiliDownloadBrowser } from "../scripts/lib/bilibili-download-browser.mjs";
import { createBilibiliMcpServer } from "../scripts/lib/bilibili-mcp.mjs";
import { openLiveBrowser } from "../scripts/lib/live-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const video = await readFile(new URL("./fixtures/progressive-avc-aac.mp4", import.meta.url));
const audio = await readFile(new URL("./fixtures/dash-audio-2frag.mp4", import.meta.url));
const bvid = "BVfixture";
const url = `https://www.bilibili.com/video/${bvid}/?p=2`;

if (process.argv[2] === "--fixture") {
  const [, , , directory, origin, failPage] = process.argv;
  serveStdio(() => createBilibiliMcpServer(async signal => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
    const { context, close } = await openLiveBrowser(chromium, {
      extension: root, headless: true, mode: "create", profileDirectory: join(directory, "profile")
    });
    try {
      await mockBilibili(context, origin, Number(failPage));
      return await createBilibiliDownloadBrowser({ context, close }, join(directory, "output"), signal);
    } catch (error) {
      await close();
      throw error;
    }
  }, "2.16.1", {
    jobDirectory: join(directory, "jobs"), outputDirectory: join(directory, "output"),
    fetcher: async request => {
      assert.equal(request.hostname, "b23.tv");
      return Response.redirect(url, 302);
    }
  }));
} else {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "hainei-mcp-"));
  const media = { hold: 0, audioRequests: new Set() };
  const mediaServer = await listenMedia(media);
  try {
    await withClient([fileURLToPath(new URL("../scripts/bilibili-mcp.mjs", import.meta.url))], async call => {
      const invalid = await call("bilibili_video_info", { url: "https://example.com/video/BVfixture" });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent.error.code, "INVALID_URL");
    });
    const origin = `http://127.0.0.1:${mediaServer.address().port}`;
    const fixture = [fileURLToPath(import.meta.url), "--fixture", directory, origin];
    await withClient(fixture, async call => {
      const [info, wrongPart, first, repeat, audioJob, wrongQuality, cappedAudio] = (await Promise.all([
        call("bilibili_video_info", { url: "https://b23.tv/fixture?p=2" }),
        call("bilibili_video_info", { url: url.replace("p=2", "p=8") }),
        call("bilibili_download", { url }),
        call("bilibili_download", { url: `${url}&spm_id_from=test`, mode: "video" }),
        call("bilibili_download", { url, mode: "audio" }),
        call("bilibili_download", { url, quality: 127 }),
        call("bilibili_download", { url, mode: "audio", maxBytes: 100_000 })
      ])).map(result => result.structuredContent);
      assert.deepEqual([info.title, info.partTitle, info.page, info.pageCount], ["MCP 下载回归", "02", 2, 7], JSON.stringify(info));
      assert.deepEqual(info.parts.map(({ page }) => page), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(info.videoQualities, [{ quality: 120, label: "4K", bytes: video.length, estimated: false }]);
      assert.equal(info.audio.source, "track");
      assert.equal(wrongPart.error.code, "PART_UNAVAILABLE");
      assert.equal(first.jobId, repeat.jobId, "同时调用同一请求只启动一个任务");
      const [savedVideo, savedAudio, failed, capped] = await Promise.all([first, audioJob, wrongQuality, cappedAudio].map(job => until(call, job.jobId)));
      assert.equal(failed.error?.code, "QUALITY_UNAVAILABLE", JSON.stringify(failed));
      // 音轨估算 96000 字节，实际更大。只有落盘验收能真正守住上限。
      assert.equal(capped.error?.code, "BUDGET_EXCEEDED", JSON.stringify(capped));
      assert(!(await readdir(join(directory, "output"))).includes(capped.jobId));
      assert.equal(savedVideo.requestedQuality, 120);
      for (const [saved, bytes, filename] of [[savedVideo, video, "MCP 下载回归 - 02 [4K].mp4"], [savedAudio, audio, "MCP 下载回归 - P2 [AAC 192K].m4a"]]) {
        assert.equal(saved.state, "complete", JSON.stringify(saved));
        assert.equal(saved.splitTracks, false);
        assert.equal(saved.files.length, 1);
        const [file] = saved.files;
        assert.equal(basename(file.path), filename);
        assert.equal(file.bytes, bytes.length);
        assert.deepEqual(await readFile(file.path), bytes);
        assert(!JSON.stringify(saved).includes("127.0.0.1"), "工具结果不能包含源地址");
      }
    });

    media.hold = 904;
    const batchArgs = { url, pages: [3, 4, 5, 6, 7], mode: "audio", subtitles: true, maxTotalBytes: 1_000_000 };
    const initial = await withClient(fixture, async call => {
      const batch = await requestTool(call, "bilibili_download_batch", batchArgs);
      const runningP4 = status => status.items[0].state === "complete" && status.items[1].state === "downloading";
      await until(call, batch.jobId, runningP4);
      await requestTool(call, "bilibili_download_control", { jobId: batch.jobId, action: "pause" });
      const paused = await until(call, batch.jobId, status => status.state === "paused");
      assert.deepEqual(paused.items.map(part => part.state), ["complete", "paused", "paused", "paused", "paused"]);
      const p3 = paused.items[0];
      assert.equal(p3.subtitle.status, "ready", JSON.stringify(p3.subtitle));
      assert(!JSON.stringify(p3).includes("auth_key"));
      await requestTool(call, "bilibili_download_control", { jobId: batch.jobId, action: "resume" });
      await until(call, batch.jobId, runningP4);

      // 批次持有执行者时，另一个排队任务可以取消，且不会影响 P4 或已完成的 P3。
      const queued = await requestTool(call, "bilibili_download", { url: url.replace("p=2", "p=7") });
      const cancelled = await requestTool(call, "bilibili_download_control", { jobId: queued.jobId, action: "cancel" });
      assert.equal(cancelled.state, "cancelled");
      return { id: batch.jobId, p3, p3Mtime: (await stat(p3.files[0].path)).mtimeMs };
    }); // EOF 时 P4 还在执行，下一连接必须读到同一个可恢复任务。

    media.hold = 0;
    const partial = await withClient([...fixture, "6"], async call => {
      const before = await requestTool(call, "bilibili_download_status", { jobId: initial.id });
      assert.equal(before.state, "interrupted", JSON.stringify(before));
      assert.equal((await requestTool(call, "bilibili_download_list", {})).jobs.some(job => job.jobId === initial.id), true);
      await requestTool(call, "bilibili_download_control", { jobId: initial.id, action: "resume" });
      const result = await until(call, initial.id);
      assert.equal(result.state, "partial", JSON.stringify(result));
      assert.deepEqual(result.items.map(part => part.state), ["complete", "complete", "complete", "failed", "complete"]);
      assert.equal(result.items[1].subtitle.status, "no_subtitle");
      return result;
    });
    media.audioRequests.clear();
    await withClient(fixture, async call => {
      await requestTool(call, "bilibili_download_control", { jobId: initial.id, action: "retry_failed" });
      const result = await until(call, initial.id);
      assert.equal(result.state, "complete", JSON.stringify(result));
      assert.deepEqual([...media.audioRequests], [906], "重试只请求失败的 P6 媒体");
      assert.equal(result.artifactBytes <= batchArgs.maxTotalBytes, true);
      assert.equal(result.items[0].files[0].path, initial.p3.files[0].path);
      assert.equal((await stat(initial.p3.files[0].path)).mtimeMs, initial.p3Mtime);
      assert.equal(result.items[4].files[0].path, partial.items[4].files[0].path);
      for (const part of result.items) {
        assert.deepEqual(await readFile(part.files[0].path), audio);
        assert(part.files[0].path.includes(`P${part.page}`));
        const partName = part.page === 4 ? " - 城外探索" : "";
        assert.equal(basename(part.files[0].path), `MCP 下载回归 - P${part.page}${partName} [AAC 192K].m4a`);
        if (part.page !== 4) {
          const json = part.subtitle.files.find(file => file.path.endsWith(".json"));
          const srt = part.subtitle.files.find(file => file.path.endsWith(".srt"));
          assert.equal(JSON.parse(await readFile(json.path, "utf8")).cues[0].text, `P${part.page} 正文`);
          assert.match(await readFile(srt.path, "utf8"), /00:00:01,250 --> 00:00:02,500/);
        }
      }
      const repeated = await requestTool(call, "bilibili_download_batch", batchArgs);
      assert.equal(repeated.jobId, initial.id);
      const subtitle = await requestTool(call, "bilibili_subtitles", { url: url.replace("p=2", "p=3"), language: "ai-zh", format: "srt", limit: 1 });
      assert.equal(subtitle.cues[0].text, "P3 正文");
      assert.equal(subtitle.machineGenerated, true);
      assert.match(await readFile(subtitle.files[0].path, "utf8"), /P3 正文/);
    });
    const output = join(directory, "output");
    assert.deepEqual((await readdir(join(output, initial.id))).sort(), ["P3", "P4", "P5", "P6", "P7"]);
    assert.equal((await readdir(output)).every(name => !name.startsWith(".")), true, "正常完成后清理暂存目录");
    console.log("MCP stdio、短链、分 P 预算、P3–P7 音频与字幕、跨会话续传、暂停取消和仅重试 P6 通过");
  } finally {
    await new Promise(resolve => mediaServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function mockBilibili(context, origin, failPage) {
  const plays = Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
    const page = index + 1, cid = 900 + page;
    return [cid, page === failPage ? { code: 0, data: {} } : { code: 0, data: {
      quality: 120, format: "mp4", accept_quality: [120], accept_description: ["4K"],
      durl: [{ url: `${origin}/video.mp4`, size: video.length }],
      dash: { duration: 6, audio: [{ id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000, baseUrl: `${origin}/audio-${cid}.mp4` }] }
    } }];
  }));
  const view = { code: 0, data: { bvid, title: "MCP 下载回归", pages: Array.from({ length: 7 }, (_, index) => ({
    cid: 901 + index, page: 1 + index, part: index === 3 ? "城外探索" : String(1 + index).padStart(2, "0"), duration: 6
  })) } };
  await context.route("https://www.bilibili.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><video muted></video>" }));
  await context.route("https://api.bilibili.com/x/player/playurl?**", route => route.fulfill({
    json: plays[new URL(route.request().url()).searchParams.get("cid")],
    headers: { "Access-Control-Allow-Origin": "https://www.bilibili.com", "Access-Control-Allow-Credentials": "true" }
  }));
  await context.route("https://api.bilibili.com/x/web-interface/nav", route => route.fulfill({ json: { code: 0, data: { wbi_img: {
    img_url: `https://i0.hdslb.com/${"a".repeat(32)}.png`, sub_url: `https://i0.hdslb.com/${"b".repeat(32)}.png`
  } } } }));
  await context.route("https://api.bilibili.com/x/player/wbi/v2?**", route => {
    const params = new URL(route.request().url()).searchParams;
    assert.match(params.get("w_rid"), /^[a-f\d]{32}$/);
    const cid = Number(params.get("cid"));
    const tracks = cid === 904 ? [] : [{ lan: "ai-zh", lan_doc: "中文", subtitle_url: `https://aisubtitle.hdslb.com/p${cid - 900}.json?auth_key=fixture` }];
    return route.fulfill({ json: { code: 0, data: { subtitle: { subtitles: tracks } } } });
  });
  await context.route("https://aisubtitle.hdslb.com/**", route => {
    const page = new URL(route.request().url()).pathname.match(/\d+/)[0];
    return route.fulfill({ json: { body: [{ from: 1.25, to: 2.5, content: `P${page} 正文` }] } });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await worker.evaluate(({ plays, view }) => {
    const fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      const url = new URL(input.url || input);
      if (url.hostname !== "api.bilibili.com") return fetchOriginal(input, init);
      return Promise.resolve(Response.json(url.pathname.endsWith("/playurl") ? plays[url.searchParams.get("cid")] : view));
    };
  }, { plays, view });
}

async function listenMedia(media) {
  const server = createServer((request, response) => {
    const cid = Number(/^\/audio-(\d+)\.mp4/.exec(request.url)?.[1]);
    const bytes = cid ? audio : video;
    if (cid) media.audioRequests.add(cid);
    response.setHeader("Content-Type", cid ? "audio/mp4" : "video/mp4");
    response.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    if (!range) return response.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
    if (start > end) return response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }).end();
    response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
    if (cid && cid === media.hold) {
      response.flushHeaders();
      return;
    }
    response.end(bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function requestTool(call, name, args) {
  const result = await call(name, args);
  assert(!result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

async function until(call, jobId, matches = status => ["complete", "failed", "partial"].includes(status.state)) {
  let status;
  for (let tries = 0; tries < 45; tries++) {
    status = await requestTool(call, "bilibili_download_status", { jobId, waitSeconds: 2 });
    if (matches(status)) return status;
    if (["failed", "cancelled", "partial", "paused", "interrupted"].includes(status.state)) break;
  }
  assert.fail(`任务没有进入预期状态：${JSON.stringify(status)}`);
}

async function withClient(args, exercise) {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "inherit"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const requests = new Map();
  let nextId = 0;
  lines.on("line", line => {
    const response = JSON.parse(line);
    requests.get(response.id)?.(response);
    requests.delete(response.id);
  });
  const send = (method, params, id) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const request = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`${params?.name || method} timed out`));
      }, 90_000);
      requests.set(id, response => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      });
      send(method, params, id);
    });
  };
  let testError;
  try {
    await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bilibili-fixture", version: "1.0.0" } });
    send("notifications/initialized");
    const { tools } = await request("tools/list");
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["bilibili_account_status", "bilibili_download", "bilibili_download_batch", "bilibili_download_control",
      "bilibili_download_list", "bilibili_download_status", "bilibili_subtitles", "bilibili_video_info"]);
    return await exercise((name, args) => request("tools/call", { name, arguments: args }));
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    child.stdin.end();
    const finish = await Promise.race([exited, delay(15_000, null, { ref: false })]);
    if (!finish) {
      child.kill("SIGKILL");
      await exited;
    }
    lines.close();
    if (!testError) assert.equal(finish?.[0], 0, "客户端断开后 MCP 进程未正常退出");
  }
}
