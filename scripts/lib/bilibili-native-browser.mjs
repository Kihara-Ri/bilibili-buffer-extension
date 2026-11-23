import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MCP_BRIDGE_PROTOCOL } from "../../src/mcp-native-bridge.js";
import { BilibiliDownloadError } from "./bilibili-download-browser.mjs";
import { MCP_BRIDGE_DIRECTORY, MCP_BRIDGE_FILE } from "./bilibili-mcp-connection.mjs";
import { createBilibiliOutput, mcpExportFilename } from "./bilibili-mcp-output.mjs";

const notConnected = () => new BilibiliDownloadError("CHROME_NOT_CONNECTED", "请在平时用的 Chrome 中打开海内存知 → 设置 → 关于 → AI 下载，然后连接此 Chrome。");

/** @param {{bridgeDirectory?:string,outputDirectory:string,signal:AbortSignal}} options */
export async function createBilibiliNativeBrowser({ bridgeDirectory = MCP_BRIDGE_DIRECTORY, outputDirectory, signal }) {
  const descriptor = await readFile(join(bridgeDirectory, MCP_BRIDGE_FILE), "utf8").then(JSON.parse).catch(() => null);
  if (descriptor?.protocol !== MCP_BRIDGE_PROTOCOL || !/^[a-f\d]{64}$/i.test(descriptor.token || "") ||
      !Number.isInteger(descriptor.port) || descriptor.port <= 0 || descriptor.port > 65535) throw notConnected();
  const output = createBilibiliOutput(outputDirectory);
  const session = randomUUID();
  const endpoint = `http://127.0.0.1:${descriptor.port}/rpc`;

  async function rpc(method, args, cleanup = false) {
    const timeout = AbortSignal.timeout(cleanup ? 5_000 : 125_000);
    const requestSignal = cleanup ? timeout : AbortSignal.any([timeout, signal]);
    let response, result;
    try {
      response = await fetch(endpoint, { method: "POST", signal: requestSignal, redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
        body: JSON.stringify({ session, method, args }) });
      result = await response.json();
    } catch (error) {
      if (!cleanup) signal.throwIfAborted();
      throw notConnected();
    }
    if (!response.ok) throw notConnected();
    if (!result || result.error) throw new BilibiliDownloadError("EXTENSION_ERROR", result?.error || "Chrome 扩展没有返回结果，请重试。");
    return result.value;
  }

  async function withVideo(url, callback) {
    const { tabId } = await rpc("openVideo", { url });
    try { return await callback(tabId); }
    finally { await rpc("closeVideo", { tabId }, true).catch(() => {}); }
  }

  async function exportFiles(videoId, outputKey, { metadata, subtitle, maxBytes, beforePublish } = {}) {
    const key = randomUUID();
    const temporaryDirectories = new Set();
    let stage;
    try {
      await beforePublish?.();
      stage = await mkdtemp(join(await output.root(), ".bilibili-native-"));
      await rpc("exportStart", { videoId, key });
      let saved;
      for (;;) {
        await beforePublish?.();
        saved = await rpc("exportStatus", { key });
        if (saved.files?.length) break;
        await delay(300, undefined, { signal });
      }
      const files = [];
      for (const item of saved.files) {
        const segments = item.path.split(/[\\/]/);
        if (!isAbsolute(item.path) || segments.at(-3) !== "Haineicunzhi-MCP" || segments.at(-2) !== key) throw new Error("Chrome download is outside its staging directory");
        temporaryDirectories.add(dirname(item.path));
        const stats = await lstat(item.path);
        if (!stats.isFile() || !stats.size || (item.bytes > 0 && item.bytes !== stats.size)) throw new Error("Chrome download is incomplete");
        const name = mcpExportFilename(item.name);
        const target = join(stage, name);
        // 使用 Chrome 自己选定的下载目录。跨盘时复制到发布暂存区，整个过程无需修改浏览器偏好。
        await rename(item.path, target).catch(error => {
          if (error.code !== "EXDEV") throw error;
          return copyFile(item.path, target, constants.COPYFILE_EXCL);
        });
        files.push({ name, bytes: stats.size });
      }
      const result = await output.publish(outputKey, stage, { ...metadata, files, splitTracks: saved.splitTracks }, {
        subtitle, maxBytes, beforePublish, makeError: (code, message) => new BilibiliDownloadError(code, message)
      });
      stage = null;
      return result;
    } catch (error) {
      if (error instanceof BilibiliDownloadError || signal.aborted) throw error;
      throw new BilibiliDownloadError("EXPORT_FAILED", "缓存已就绪，但 Chrome 导出失败。请检查下载目录和剩余空间后重试。");
    } finally {
      await rpc("exportDispose", { key }, true).catch(() => {});
      await Promise.allSettled([...temporaryDirectories].map(directory => rmdir(directory)));
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    send: rpc, withVideo, exportFiles,
    accountStatus: () => rpc("account"),
    readJson: (address, kind) => rpc("readJson", { address, kind }),
    close: () => rpc("close", undefined, true).catch(() => {})
  };
}
