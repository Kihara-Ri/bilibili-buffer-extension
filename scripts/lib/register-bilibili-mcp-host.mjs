import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_NATIVE_HOST } from "../../src/mcp-native-bridge.js";

const quoteShell = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const quoteWindows = value => `"${value.replace(/%/g, "%%")}"`;

/**
 * Chrome 以固定本机清单启动 Node，参数中的扩展来源仍按清单白名单校验。
 * @param {{registryDirectory:string,bridgeDirectory:string,script:string,ids:string[],windows?:boolean}} options
 */
export async function writeBilibiliNativeHost({ registryDirectory, bridgeDirectory, script, ids, windows = process.platform === "win32" }) {
  if (!ids.length || ids.some(id => !/^[a-p]{32}$/.test(id))) throw new Error("扩展 ID 无效");
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  const launcher = join(bridgeDirectory, windows ? "chrome-connector.cmd" : "chrome-connector");
  const args = [process.execPath, script, bridgeDirectory, ids.join(",")];
  const command = windows
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${args.map(quoteWindows).join(" ")} %*\r\n`
    : `#!/bin/sh\nexec ${args.map(quoteShell).join(" ")} "$@"\n`;
  await writeFile(launcher, command, { mode: 0o700 });
  const manifest = join(registryDirectory, `${MCP_NATIVE_HOST}.json`);
  const allowed_origins = [...new Set(ids)].map(id => `chrome-extension://${id}/`);
  await writeFile(manifest, JSON.stringify({ name: MCP_NATIVE_HOST, description: "Kindred Afar local MCP connector", path: launcher, type: "stdio", allowed_origins }, null, 2), { mode: 0o600 });
  return manifest;
}
