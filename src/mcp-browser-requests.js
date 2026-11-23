const BILI_API = "https://api.bilibili.com";
const paths = { nav: "/x/web-interface/nav", account: "/x/web-interface/nav", tracks: "/x/player/wbi/v2" };
export const MCP_BILI_LOGIN_URL = "https://passport.bilibili.com/login";

/** @param {string} address @param {"nav"|"account"|"tracks"|"cues"} kind */
export async function readMcpBrowserJson(address, kind, request = fetch) {
  const url = new URL(address);
  // 固定 API 域才使用 Chrome 会话，字幕文件域只接收站点给出的签名地址。
  const allowed = kind === "cues"
    ? url.protocol === "https:" && (url.hostname === "hdslb.com" || url.hostname.endsWith(".hdslb.com"))
    : Object.hasOwn(paths, kind) && url.origin === BILI_API && url.pathname === paths[kind];
  if (!allowed || url.username || url.password || url.port) throw new Error("Unsupported Bilibili request");
  const response = await request(url.href, { credentials: kind === "cues" ? "omit" : "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Bilibili request failed");
  const data = await response.json();
  if (kind === "nav") return { keys: data?.data?.wbi_img };
  if (kind === "account") return { code: data?.code, isLogin: data?.data?.isLogin };
  if (kind === "tracks") return { code: data?.code, tracks: data?.data?.subtitle?.subtitles };
  return { body: data?.body };
}

/** @returns {Promise<{status: "signed_in"|"signed_out"|"unavailable", loginUrl?: string}>} */
export async function readMcpAccountStatus(request = fetch) {
  try {
    const { code, isLogin } = await readMcpBrowserJson(`${BILI_API}${paths.account}`, "account", request);
    if (code === 0 && isLogin === true) return { status: "signed_in" };
    // Cookie 可能已经过期。只按 B 站的显式未登录结果提示，网络错误和风控保留为未知。
    if (code === -101 || (code === 0 && isLogin === false)) return { status: "signed_out", loginUrl: MCP_BILI_LOGIN_URL };
  } catch { /* 到不了登录状态接口时无法判断。 */ }
  return { status: "unavailable" };
}
