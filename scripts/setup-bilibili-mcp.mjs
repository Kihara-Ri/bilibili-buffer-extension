import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_NATIVE_HOST } from "../src/mcp-native-bridge.js";
import { STORE_EXTENSION_ID, extensionIdFromKey } from "./lib/release-checks.mjs";
import { MCP_BRIDGE_DIRECTORY } from "./lib/bilibili-mcp-connection.mjs";
import { writeBilibiliNativeHost } from "./lib/register-bilibili-mcp-host.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const argc = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, "").split("=", 2)));
const browser = argc.browser || "chrome";
const channels = {
  chrome: { mac: ["Google", "Chrome"], linux: "google-chrome", registry: "Google\\Chrome" },
  testing: { mac: ["Google", "ChromeForTesting"], linux: "google-chrome-for-testing", registry: "Google\\Chrome" },
  chromium: { mac: ["Chromium"], linux: "chromium", registry: "Chromium" }
};
const channel = channels[browser];
if (!channel) throw new Error("使用 --browser=chrome、--browser=testing 或 --browser=chromium");
const windows = process.platform === "win32";
const registryDirectory = process.platform === "darwin" ? join(homedir(), "Library", "Application Support", ...channel.mac, "NativeMessagingHosts")
  : windows ? MCP_BRIDGE_DIRECTORY : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), channel.linux, "NativeMessagingHosts");
const ids = [STORE_EXTENSION_ID, extensionIdFromKey(manifest.key), ...(argc["extension-id"] ? [argc["extension-id"]] : [])];
const path = await writeBilibiliNativeHost({ registryDirectory, bridgeDirectory: MCP_BRIDGE_DIRECTORY,
  script: fileURLToPath(new URL("./bilibili-mcp-host.mjs", import.meta.url)), ids, windows });
if (windows) {
  execFileSync("reg.exe", ["ADD", `HKCU\\Software\\${channel.registry}\\NativeMessagingHosts\\${MCP_NATIVE_HOST}`, "/ve", "/t", "REG_SZ", "/d", path, "/f"], { stdio: "ignore" });
}
console.log("本机连接器已注册。在希望使用的 Chrome 资料打开海内存知的设置，点「AI 下载」并连接。");
