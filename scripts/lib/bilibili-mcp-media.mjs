import { createHash } from "node:crypto";
import { getAudioCacheSize, getCacheSize } from "../../src/cache-size.js";
import { parseBiliVideoUrl } from "../../src/utils.js";
import { BilibiliDownloadError } from "./bilibili-download-browser.mjs";

const API = "https://api.bilibili.com";
const WBI_MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function httpsUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
}

/** @param {string} input @returns {{url: string, page: number}} */
export function parseBilibiliMediaRequest(input) {
  const invalid = () => new BilibiliDownloadError("INVALID_URL", "请提供 B 站 HTTPS 视频或分享短链，可用 ?p= 指定分 P。");
  const url = httpsUrl(input);
  if (!url) throw invalid();
  const parsed = parseBiliVideoUrl(url.href);
  if (!parsed.supported || (!parsed.bvid && (!Number.isSafeInteger(parsed.aid) || parsed.aid < 1))) throw invalid();
  const part = url.searchParams.get("p");
  if (part !== null && (!/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) < 1)) throw invalid();
  const video = parsed.bvid ? `BV${parsed.bvid.slice(2)}` : `av${parsed.aid}`;
  const search = parsed.page > 1 ? `?p=${parsed.page}` : "";
  return { url: `https://www.bilibili.com/video/${video}/${search}`, page: parsed.page };
}

/** @param {string} input @param {typeof fetch} fetcher */
export async function resolveBilibiliMediaRequest(input, fetcher = fetch) {
  let url = httpsUrl(input);
  if (url?.hostname !== "b23.tv") return parseBilibiliMediaRequest(input);
  const part = url.searchParams.get("p");
  const signal = AbortSignal.timeout(10_000);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetcher(url, { redirect: "manual", credentials: "omit", signal }).catch(() => null);
    const location = response?.headers.get("location");
    await response?.body?.cancel().catch(() => {});
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) break;
    let destination;
    try { destination = httpsUrl(new URL(location, url)); } catch { break; }
    if (!destination) break;
    url = destination;
    if (url.hostname !== "b23.tv") {
      // 只请求短链域，跳到视频地址就停止。短链本身指定的 P 优先于跳转提供的默认 P。
      if (part !== null) url.searchParams.set("p", part);
      try { return parseBilibiliMediaRequest(url.href); } catch { break; }
    }
  }
  throw new BilibiliDownloadError("SHORT_LINK_UNAVAILABLE", "B 站短链暂时无法解析到视频页，请重试或提供 BV／av 地址。");
}

/** @param {object} browser @param {{url: string, page: number}} request */
export async function readBilibiliParts(browser, request) {
  const { pageInfo } = await browser.send("GET_PAGE_INFO", { url: request.url, includeParts: true });
  if (!pageInfo?.supported || !Array.isArray(pageInfo.parts)) {
    throw new BilibiliDownloadError("PAGE_UNAVAILABLE", "该 B 站视频的分 P 暂时无法读取。");
  }
  return pageInfo;
}

export function requireBilibiliPart(page, requested) {
  if (!page?.supported) throw new BilibiliDownloadError("PAGE_UNAVAILABLE", "该 B 站视频暂时无法读取。");
  if (page.page !== requested) {
    throw new BilibiliDownloadError("PART_UNAVAILABLE", `这个视频只有 ${page.pageCount} P，无法选择 P${requested}。`);
  }
  return page;
}

/** @param {object} browser @param {{url:string,page:number}} request @param {number} tabId */
export async function readBilibiliMediaInfo(browser, request, tabId) {
  const { snapshot } = await browser.send("REFRESH_POPUP_DATA", { url: request.url, tabId });
  const page = requireBilibiliPart(snapshot?.pageInfo, request.page);
  const audio = getAudioCacheSize(snapshot.cacheSizeInfo);
  return {
    url: page.url, bvid: page.bvid, cid: page.cid, title: page.title,
    partTitle: page.partTitle || "", page: page.page, pageCount: page.pageCount, durationSeconds: page.duration,
    videoQualities: snapshot.qualities.map(({ quality, label }) => {
      const size = getCacheSize(snapshot.cacheSizeInfo, quality);
      return { quality, label, bytes: size?.bytes ?? null, estimated: size?.estimated ?? null };
    }),
    audio: audio ? { label: audio.label, source: audio.mode, bytes: audio.bytes, estimated: audio.estimated } : null,
    account: snapshot.auth?.vipActive ? "vip" : snapshot.auth?.hasSessionCookie ? "session" : "anonymous"
  };
}

/** @param {string} bvid @param {number} cid @param {object} keys @param {number} [timestamp] */
export function signedSubtitleQuery(bvid, cid, keys, timestamp = Math.floor(Date.now() / 1000)) {
  const key = url => httpsUrl(url)?.pathname.split("/").at(-1)?.split(".")[0] || "";
  const image = key(keys?.img_url), sub = key(keys?.sub_url);
  if (![image, sub].every(value => /^[a-z0-9]{32}$/i.test(value))) {
    throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "B 站暂时没有提供有效的字幕查询签名信息。");
  }
  // 与独立内容服务使用同一个 WBI 规则。只用公开的签名图片名，Chromium 自己携带站点会话。
  const query = new URLSearchParams({ bvid, cid, wts: timestamp });
  const raw = image + sub;
  const mixin = WBI_MIXIN.map(index => raw[index]).join("");
  query.set("w_rid", createHash("md5").update(query.toString() + mixin).digest("hex"));
  return query.toString();
}

/** @param {object} browser @param {{bvid:string,cid:number}} part @param {string} [language] */
export async function readBilibiliSubtitles(browser, part, language) {
  if (!/^BV[a-z\d]+$/i.test(part.bvid) || !Number.isSafeInteger(part.cid) || part.cid <= 0) {
    throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "分 P 缺少有效的字幕查询标识。");
  }
  const nav = await browser.readJson(`${API}/x/web-interface/nav`, "nav");
  const query = signedSubtitleQuery(part.bvid, part.cid, nav.keys);
  const response = await browser.readJson(`${API}/x/player/wbi/v2?${query}`, "tracks");
  if ([-101, -403].includes(response.code)) return { status: "subtitle_locked", source: "bilibili" };
  if (response.code !== 0 || !Array.isArray(response.tracks)) {
    throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "B 站字幕列表暂时无法读取。");
  }
  const tracks = response.tracks.filter(track => typeof track?.lan === "string");
  const available = tracks.map(track => ({ language: track.lan, label: track.lan_doc || track.lan, locked: Boolean(track.is_lock || !track.subtitle_url) }));
  if (!tracks.length) return { status: "no_subtitle", source: "bilibili", available };
  const matching = language ? tracks.filter(track => track.lan.toLowerCase() === language.toLowerCase()) : tracks;
  if (!matching.length) return { status: "language_unavailable", source: "bilibili", available };
  const priority = ["zh-cn", "zh-hans", "zh", "ai-zh", "zh-tw", "zh-hant"];
  const rank = track => (priority.indexOf(track.lan.toLowerCase()) + 1) || Infinity;
  const track = matching.filter(track => !track.is_lock && track.subtitle_url).sort((a, b) => rank(a) - rank(b))[0];
  if (!track) return { status: "subtitle_locked", source: "bilibili", available };
  const url = httpsUrl(track.subtitle_url.startsWith("//") ? `https:${track.subtitle_url}` : track.subtitle_url);
  if (!url || (url.hostname !== "hdslb.com" && !url.hostname.endsWith(".hdslb.com"))) {
    throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "B 站返回了不受支持的字幕地址。");
  }
  const { body } = await browser.readJson(url.href, "cues");
  if (!Array.isArray(body) || body.some(cue => !Number.isFinite(cue?.from) || !Number.isFinite(cue?.to) || cue.from < 0 || cue.to <= cue.from || typeof cue.content !== "string")) {
    throw new BilibiliDownloadError("SUBTITLE_UNAVAILABLE", "字幕时间戳或文本格式无效。");
  }
  return {
    status: "ready", source: "bilibili", available, language: track.lan, label: track.lan_doc || track.lan,
    machineGenerated: /^ai-/i.test(track.lan) ? true : null,
    cues: body.map(({ from, to, content }) => ({ startSeconds: from, endSeconds: to, text: content }))
  };
}

/** @param {Array<{options: Array<{bytes: number|null, quality?: number}>}>} parts @param {number} limit */
export function planBilibiliBudget(parts, limit) {
  const choices = parts.map(({ options }) => options.filter(item => Number.isSafeInteger(item.bytes) && item.bytes > 0));
  if (choices.some(options => !options.length)) throw new BilibiliDownloadError("BUDGET_UNKNOWN", "所选分 P 有画质缺少体积信息，无法制定预算内的下载计划。");
  const selected = choices.map(options => options.reduce((best, item) => item.bytes < best.bytes ? item : best));
  let remaining = limit - selected.reduce((total, item) => total + item.bytes, 0);
  if (remaining < 0) throw new BilibiliDownloadError("BUDGET_TOO_SMALL", "按当前体积信息估算，预算不足以容纳所选分 P。");
  // 先给每一集留出一个可下载档位，再按 P 顺序提高画质。不同 P 的可用档和体积可能不同。
  return selected.map((base, index) => {
    const choice = choices[index].find(item => item.bytes <= base.bytes + remaining) || base;
    remaining -= choice.bytes - base.bytes;
    return choice;
  });
}
