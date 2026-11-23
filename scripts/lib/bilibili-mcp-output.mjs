import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { DOWNLOAD_FILENAME_BYTE_LIMIT, truncateUtf8 } from "../../src/utils.js";

const MANIFEST = ".haineicunzhi-export.json";

/** @param {string} filename 扩展已有导出计划的文件名 */
export function mcpExportFilename(filename) {
  const suffix = extname(filename);
  if (!suffix || basename(filename) !== filename) throw new Error("Invalid extension export filename");
  const stem = filename.slice(0, -suffix.length);
  return truncateUtf8(stem, DOWNLOAD_FILENAME_BYTE_LIMIT - Buffer.byteLength(suffix)) + suffix;
}

function outputPath(root, key) {
  if (!/^[a-f\d-]{36}(?:\/P[1-9]\d*)?$/i.test(key)) throw new Error("Invalid export key");
  return join(root, key);
}

/** @param {Array<{startSeconds:number,endSeconds:number,text:string}>} cues */
export function subtitlesToSrt(cues) {
  const time = seconds => {
    const ms = Math.round(seconds * 1000);
    const fields = [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60];
    return fields.map(number => String(number).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0");
  };
  return cues.map((cue, index) => `${index + 1}\n${time(cue.startSeconds)} --> ${time(cue.endSeconds)}\n${cue.text.trim().replace(/(?:\r?\n)+/g, "\n")}\n`).join("\n");
}

function resultFor(directory, artifact) {
  const paths = files => files.map(({ name, bytes }) => ({ path: join(directory, name), bytes }));
  const { files, subtitle, ...metadata } = artifact;
  return {
    ...metadata, files: paths(files), artifactBytes: [...files, ...(subtitle?.files || [])].reduce((total, file) => total + file.bytes, 0),
    ...(subtitle ? { subtitle: { ...subtitle, files: paths(subtitle.files) } } : {})
  };
}

/** @param {string} directory 本地 MCP 配置的产物目录。 */
export function createBilibiliOutput(directory) {
  async function root() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return realpath(directory);
  }

  async function read(key) {
    const destination = outputPath(directory, key);
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory()) return null;
      const { version, artifact } = JSON.parse(await readFile(join(destination, MANIFEST), "utf8"));
      if (version !== 1 || !Array.isArray(artifact?.files)) return null;
      const files = [...artifact.files, ...(artifact.subtitle?.files || [])];
      if (!files.length) return null;
      for (const file of files) {
        if (basename(file.name) !== file.name || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return null;
        const actual = await lstat(join(destination, file.name));
        if (!actual.isFile() || actual.size !== file.bytes) return null;
      }
      return resultFor(await realpath(destination), artifact);
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function publish(key, stage, artifact, { subtitle, maxBytes, beforePublish, makeError = (_code, message) => new Error(message) } = {}) {
    const { cues, available, format, ...details } = subtitle || {};
    if (subtitle) {
      artifact.subtitle = { ...details, files: [] };
      if (details.status === "ready") {
        const add = async (name, content) => {
          await writeFile(join(stage, name), content, { flag: "wx", mode: 0o600, flush: true });
          artifact.subtitle.files.push({ name, bytes: Buffer.byteLength(content) });
        };
        if (format === "json" || format === "both") await add("subtitles.json", JSON.stringify({ ...details, cues }));
        if (format === "srt" || format === "both") await add("subtitles.srt", subtitlesToSrt(cues));
      }
    }

    const destination = outputPath(await root(), key);
    const result = resultFor(destination, artifact);
    if (maxBytes !== undefined && result.artifactBytes > maxBytes) {
      throw makeError("BUDGET_EXCEEDED", `实际产物 ${result.artifactBytes} 字节，超过本次剩余预算 ${maxBytes} 字节。片库缓存可供重试。`);
    }
    // 清单和素材一起发布。即使进程在 rename 后、更新任务前退出，重连也可以核实并认领产物。
    await writeFile(join(stage, MANIFEST), JSON.stringify({ version: 1, artifact }), { flag: "wx", mode: 0o600, flush: true });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (await lstat(destination).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error))) {
      throw makeError("OUTPUT_EXISTS", "目标目录已有内容。请保留原文件，发起新的下载任务后再导出。");
    }
    await beforePublish?.();
    await rename(stage, destination);
    return result;
  }

  return { root, read, publish, async saveSubtitle(key, subtitle) {
    const stage = await mkdtemp(join(await root(), ".bilibili-subtitles-"));
    try {
      return (await publish(key, stage, { files: [] }, { subtitle })).subtitle;
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  } };
}
