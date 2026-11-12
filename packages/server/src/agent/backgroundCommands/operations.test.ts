import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")(
	"a background command and its descendants die when the host is killed outright",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "raildesign-command-orphan-"));
		const effect = join(directory, "effect");
		try {
			const host = Bun.spawn(
				[
					process.execPath,
					"-e",
					`const { createShellOperations } = await import(${JSON.stringify(`${import.meta.dir}/operations.ts`)});
					void createShellOperations({}).exec(${JSON.stringify(`(sleep 1; touch '${effect}') & sleep 30`)}, ${JSON.stringify(directory)}, { onData: () => {} });
					setTimeout(() => console.log("ready"), 200);
					setInterval(() => {}, 1000);`,
				],
				{ stdout: "pipe", stderr: "inherit" },
			);
			await host.stdout.getReader().read();
			host.kill("SIGKILL");
			await host.exited;
			await Bun.sleep(2_000);
			expect(existsSync(effect)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	15_000,
);
