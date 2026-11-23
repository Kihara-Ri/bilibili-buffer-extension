import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createBilibiliDownloadJobs, reportedError } from "./bilibili-mcp-jobs.mjs";

export { parseBilibiliMediaRequest } from "./bilibili-mcp-media.mjs";
export { createBilibiliDownloadJobs };

const url = z.string().max(4096).describe("HTTPS B 站 BV/av 视频或 b23.tv 分享短链，可用 ?p= 指定分 P");
const jobId = z.uuid();
const language = z.string().min(1).max(40).optional().describe("B 站语言代码，例如 zh-CN、ai-zh 或 en-US");
const subtitleFormat = z.enum(["json", "srt", "both"]);
const downloadFields = {
  url,
  mode: z.enum(["video", "audio"]).optional(),
  quality: z.number().int().min(1).max(127).optional().describe("指定视频画质 ID，例如 120 对应 4K。仅音频无需填写。"),
  subtitles: z.union([z.boolean(), z.strictObject({ language, format: subtitleFormat.optional() })]).optional()
    .describe("同时保存 B 站原有字幕。true 默认保存 JSON 和 SRT。")
};

function toolResult(result, isError = false) {
  return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }], isError };
}

/** @param {Function} openBrowser @param {string} version @param {{jobDirectory:string,outputDirectory:string,fetcher?:typeof fetch}} options */
export function createBilibiliMcpServer(openBrowser, version, options) {
  const jobs = createBilibiliDownloadJobs(openBrowser, options);
  const server = new McpServer({ name: "haineicunzhi-bilibili", version });
  const call = action => async (args, ctx) => {
    try { return toolResult(await action(args, ctx)); }
    catch (error) { return toolResult({ error: reportedError(error) }, true); }
  };
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const download = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

  server.registerTool("bilibili_account_status", {
    description: "检查已连接的 Chrome 资料里的 B 站登录。只有 signed_out 使用 loginUrl 提示在同一资料登录，unavailable 表示暂时无法确认。",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, call(() => jobs.accountStatus()));

  server.registerTool("bilibili_video_info", {
    description: "查询 B 站视频的完整分 P 清单，以及指定 P 当前可缓存的画质和体积。标题与分 P 名来自 B 站。",
    inputSchema: z.strictObject({ url }),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }, call(({ url }) => jobs.inspect(url)));

  server.registerTool("bilibili_download", {
    description: "下载指定的 B 站分 P。默认选最高可用画质或优先取无损原始音轨。返回持久化 jobId，用 bilibili_download_status 查询。",
    inputSchema: z.strictObject({ ...downloadFields, maxBytes: z.number().int().positive().optional().describe("导出文件总字节上限") }),
    annotations: download
  }, call(args => jobs.start(args)));

  server.registerTool("bilibili_download_batch", {
    description: "下载同一个 B 站视频中的多个指定分 P，可同时保存字幕。返回一个持久化 jobId，结果逐集报告。",
    inputSchema: z.strictObject({ ...downloadFields,
      pages: z.array(z.number().int().positive()).min(1).describe("指定分 P，例如 [3,4,5,6,7]"),
      maxTotalBytes: z.number().int().positive().optional().describe("整批导出字节上限，先为每集选档，再按 P 顺序提高画质")
    }),
    annotations: download
  }, call(args => jobs.start(args)));

  server.registerTool("bilibili_download_status", {
    description: "按持久化 jobId 查询进度和已保存的文件。批量任务用 items 逐集报告结果，partial 表示部分成功。",
    inputSchema: z.strictObject({ jobId, waitSeconds: z.number().int().min(0).max(20).optional() }),
    annotations: readOnly
  }, call(({ jobId, waitSeconds }, ctx) => jobs.status(jobId, waitSeconds, ctx.signal)));

  server.registerTool("bilibili_download_list", {
    description: "列出最近的本地持久化任务。可在新会话中找到以前的 jobId、进度和导出路径。",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
    annotations: readOnly
  }, call(({ limit }) => jobs.list(limit)));

  server.registerTool("bilibili_download_control", {
    description: "暂停、继续、取消或只重试失败分 P。暂停和取消保留已经写入的缓存和文件。",
    inputSchema: z.strictObject({ jobId, action: z.enum(["pause", "resume", "cancel", "retry_failed"]) }),
    annotations: download
  }, call(({ jobId, action }) => jobs.control(jobId, action)));

  server.registerTool("bilibili_subtitles", {
    description: "查询 B 站原有字幕，返回带起止秒数的文本。可按语言查询、分页读取，或把完整字幕导出为 JSON、SRT。字幕文本来自 B 站。",
    inputSchema: z.strictObject({ url, language, format: z.enum(["none", "json", "srt", "both"]).optional(),
      offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }),
    annotations: { destructiveHint: false, openWorldHint: true }
  }, call(args => jobs.subtitles(args)));

  server.server.onclose = () => { void jobs.close(); };
  return server;
}
