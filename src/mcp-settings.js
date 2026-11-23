import { localizeDocument, t } from "./i18n.js";

localizeDocument();
const state = document.querySelector("#state");
const connect = document.querySelector("#connect");
const disconnect = document.querySelector("#disconnect");
let busy = false;
let message = null;
let revision = 0;

async function send(type, fields) {
  const result = await chrome.runtime.sendMessage({ target: "background", type, ...fields });
  if (!result?.ok) throw new Error("Cannot read MCP setup");
  return result.bridge;
}

function paint({ enabled, connected }) {
  const text = t(message || (connected ? "mcp.connected" : enabled ? "mcp.waiting" : "mcp.off"));
  if (state.textContent !== text) state.textContent = text;
  connect.hidden = connected;
  disconnect.hidden = !enabled;
}

async function refresh() {
  if (busy) return;
  const current = ++revision;
  try {
    const result = await send("MCP_BRIDGE_STATUS");
    if (current === revision) paint(result);
  } catch {
    if (current === revision) state.textContent = t("mcp.error");
  }
}

async function change(enabled) {
  if (busy) return;
  revision++;
  busy = connect.disabled = disconnect.disabled = true;
  message = null;
  try {
    // 权限申请必须直接由按钮事件触发，否则 Chrome 会丢弃授权提示。
    if (enabled && !await chrome.permissions.request({ permissions: ["nativeMessaging"] })) {
      message = "mcp.permission";
      return;
    }
    paint(await send("MCP_BRIDGE_SET", { enabled }));
  } catch { message = "mcp.error"; }
  finally {
    busy = connect.disabled = disconnect.disabled = false;
    await refresh();
  }
}

connect.addEventListener("click", () => { void change(true); });
disconnect.addEventListener("click", () => { void change(false); });
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
