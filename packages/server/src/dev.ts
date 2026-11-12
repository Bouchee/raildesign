import { parsePort } from "@thinkrail/shared/freePort";
import { bootHost } from "./host";

const host = process.env.THINKRAIL_HOST ?? "localhost";
const staticDir = process.env.THINKRAIL_STATIC_DIR;
const rawPort = process.env.THINKRAIL_PORT;
const port = parsePort(rawPort);
if (rawPort !== undefined && port === undefined) throw new Error("Invalid THINKRAIL_PORT");
const running = await bootHost({
	port: port ?? 24242,
	host,
	portMode: port === undefined ? "free" : "exact",
	resolveShellEnv: true,
	...(staticDir ? { staticDir } : {}),
});
console.log(`RailDesign host: http://${host}:${running.port}`);
