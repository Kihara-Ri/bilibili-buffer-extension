import { dirname, join } from "node:path";
import { LIVE_BROWSER_PROFILE } from "./live-browser.mjs";

export const MCP_JOB_DIRECTORY = join(dirname(LIVE_BROWSER_PROFILE), "MCP");
export const MCP_BRIDGE_DIRECTORY = join(MCP_JOB_DIRECTORY, "bridge");
export const MCP_BRIDGE_FILE = "connection.json";
