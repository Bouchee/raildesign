import { expect, spyOn, test } from "bun:test";
import { spawnPiped } from "./piped";

test("piped processes exchange stdin and stdout without mixing stderr", async () => {
	const child = spawnPiped([
		process.execPath,
		"-e",
		"const input=await new Response(Bun.stdin.stream()).text(); console.log(input.toUpperCase()); console.error('diagnostic');",
	]);
	try {
		child.stdin.write("hello");
		await child.stdin.flush();
		child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stdout.trim()).toBe("HELLO");
		expect(stderr.trim()).toBe("diagnostic");
		expect(code).toBe(0);
	} finally {
		await child.stop();
	}
});

test("Stop does not signal an exited child's reusable PID", async () => {
	const child = spawnPiped([process.execPath, "-e", "process.exit(0)"]);
	await child.exited;
	const signal = spyOn(process, "kill");
	try {
		await child.stop();
		expect(signal).not.toHaveBeenCalled();
	} finally {
		signal.mockRestore();
	}
});

test.skipIf(process.platform === "win32")(
	"piped process Stop terminates its descendant",
	async () => {
		const child = spawnPiped(["/bin/sh", "-c", 'sleep 30 & printf "%s\\n" "$!"; wait']);
		try {
			const reader = child.stdout.getReader();
			const output = await reader.read();
			const pid = Number(new TextDecoder().decode(output.value).trim());
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			const stopped = child.stop();
			expect(child.stop()).toBe(stopped);
			await stopped;
			await reader.cancel();
			const deadline = Date.now() + 3000;
			let alive = true;
			while (alive && Date.now() < deadline) {
				try {
					process.kill(pid, 0);
					await Bun.sleep(5);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false;
					else throw error;
				}
			}
			expect(alive).toBe(false);
		} finally {
			await child.stop();
		}
	},
);
