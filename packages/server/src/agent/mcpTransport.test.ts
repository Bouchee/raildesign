import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedStdioTransport } from "./mcp/transport";

test.skipIf(process.platform === "win32")(
	"natural MCP process exit bounds drains when an escaped descendant retains both pipes",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "mcp-drain-"));
		const pidFile = join(root, "descendant-pid");
		let closed: () => void = () => {};
		const completion = new Promise<void>((resolve) => {
			closed = resolve;
		});
		const transport = new OwnedStdioTransport(
			{
				command: process.execPath,
				args: [
					"-e",
					`
				const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
					detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit"
				});
				child.unref();
				require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
				process.exit(0);
			`,
				],
			},
			() => {},
		);
		transport.onclose = closed;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await transport.start();
			await Promise.race([
				completion,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("MCP pipe drain did not finish")), 1500);
				}),
			]);
			expect(existsSync(pidFile)).toBe(true);
			const pid = Number(readFileSync(pidFile, "utf8"));
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			expect(() => process.kill(pid, 0)).not.toThrow();
			await transport.close();
		} finally {
			clearTimeout(timer);
			if (existsSync(pidFile)) {
				try {
					process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
				} catch {}
			}
			await transport.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
