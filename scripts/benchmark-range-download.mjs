import { DEFAULT_RANGE_SIZE, rankRangeCandidates } from "../src/range-downloader.js";
import { parseContentRange } from "../src/utils.js";

const input = process.argv[2] || "BV1Kg8t6NEmN";
const rangeMiB = Math.max(0.25, Math.min(4, Number(process.argv[3]) || DEFAULT_RANGE_SIZE / 1024 / 1024));
const bvid = input.match(/BV[0-9A-Za-z]+/i)?.[0];
if (!bvid) throw new Error("请提供 B 站 BV 号或视频地址");

const apiHeaders = {
  Accept: "application/json",
  Referer: "https://www.bilibili.com/",
  "User-Agent": "Mozilla/5.0 Bili-Buffer-Range-Benchmark/1.0"
};
const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
if (view.code !== 0 || !view.data?.cid) throw new Error(view.message || "无法读取视频信息");
const playurl = await getJson(
  `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${view.data.cid}&qn=127&fnval=4048&fourk=1`
);
if (playurl.code !== 0 || !playurl.data) throw new Error(playurl.message || "无法读取播放地址");

const representations = Array.isArray(playurl.data.dash?.video) ? playurl.data.dash.video : [];
const representation = [...representations]
  .filter((track) => (track.baseUrl || track.base_url) && /video\/mp4/i.test(track.mimeType || track.mime_type || ""))
  .sort((left, right) => (Number(right.id) || 0) - (Number(left.id) || 0))[0];
if (!representation) throw new Error("匿名播放清单没有可测试的 DASH MP4 视频轨");

const urls = [
  representation.baseUrl || representation.base_url,
  ...(representation.backupUrl || representation.backup_url || [])
].filter(Boolean);
const fetchImpl = (url, init = {}) => fetch(url, {
  ...init,
  headers: { ...init.headers, Referer: "https://www.bilibili.com/", "User-Agent": apiHeaders["User-Agent"] }
});
const ranking = await rankRangeCandidates(urls, { fetchImpl, probeSize: 64 * 1024 });
const sampleSize = Math.max(256 * 1024, Math.min(rangeMiB * 1024 * 1024, Math.floor(ranking.totalBytes / 3)));
const ranges = Array.from({ length: 3 }, (_, index) => ({
  start: index * sampleSize,
  end: Math.min(ranking.totalBytes - 1, (index + 1) * sampleSize - 1)
}));

const sequentialStartedAt = performance.now();
const sequentialMetrics = { requestCount: 0, retryCount: 0, hosts: new Set() };
for (const range of ranges) await fetchRangeWithFallback(range.start, range.end, sequentialMetrics);
const sequentialMs = performance.now() - sequentialStartedAt;
const parallelStartedAt = performance.now();
const parallelMetrics = { requestCount: 0, retryCount: 0, hosts: new Set() };
await Promise.all(ranges.map((range) => fetchRangeWithFallback(range.start, range.end, parallelMetrics)));
const parallelMs = performance.now() - parallelStartedAt;
const sampleBytes = ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);

console.log(JSON.stringify({
  bvid,
  quality: Number(representation.id) || 0,
  codec: representation.codecs || "",
  totalBytes: ranking.totalBytes,
  preferredHost: ranking.probes[0]?.host || "",
  candidateCount: ranking.urls.length,
  rangeSize: sampleSize,
  sampleBytes,
  sequentialMbps: toMbps(sampleBytes, sequentialMs),
  parallelMbps: toMbps(sampleBytes, parallelMs),
  speedup: Number((sequentialMs / parallelMs).toFixed(2)),
  sequentialRequests: sequentialMetrics.requestCount,
  sequentialRetries: sequentialMetrics.retryCount,
  parallelRequests: parallelMetrics.requestCount,
  parallelRetries: parallelMetrics.retryCount,
  usedHosts: [...new Set([...sequentialMetrics.hosts, ...parallelMetrics.hosts])]
}, null, 2));

async function getJson(url) {
  const response = await fetch(url, { headers: apiHeaders });
  if (!response.ok) throw new Error(`API 请求失败（HTTP ${response.status}）`);
  return response.json();
}

async function fetchRangeWithFallback(start, end, metrics) {
  let lastError;
  for (let index = 0; index < ranking.urls.length; index += 1) {
    const url = ranking.urls[index];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("测速范围超时", "TimeoutError")), 30_000);
    metrics.requestCount += 1;
    if (index > 0) metrics.retryCount += 1;
    try {
      await fetchRange(url, start, end, controller.signal);
      metrics.hosts.add(new URL(url).hostname);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("所有 CDN 候选都无法完成测速范围");
}

async function fetchRange(url, start, end, signal) {
  const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  try {
    if (response.status !== 206) throw new Error(`CDN 没有返回 HTTP 206，而是 ${response.status}`);
    const contentRange = parseContentRange(response.headers.get("content-range"));
    if (!contentRange || contentRange.start !== start || contentRange.end !== end) {
      throw new Error("CDN 没有完整返回指定的固定范围");
    }
    if (contentRange.total !== ranking.totalBytes) throw new Error("测速时媒体总大小发生变化");
    const data = await response.arrayBuffer();
    if (data.byteLength !== end - start + 1) throw new Error("测速范围字节数不完整");
  } finally {
    await response.body?.cancel?.().catch(() => {});
  }
}

function toMbps(bytes, milliseconds) {
  return Number(((bytes * 8) / Math.max(milliseconds / 1000, 0.001) / 1_000_000).toFixed(2));
}
