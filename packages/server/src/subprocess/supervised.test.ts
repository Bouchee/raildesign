import { expect, test } from "bun:test";
import { spawnSupervised } from "./supervised";

const bun = process.execPath;

test("a supervised child reports its exit code and keeps a stderr tail", async () => {
	const child = spawnSupervised([bun, "-e", "console.error('boom'); process.exit(4)"]);
	expect(await child.exited).toBe(4);
	await Bun.sleep(20);
	expect(child.stderrTail()).toContain("boom");
});

test("observed output drains both UTF-8 streams before exit without a complete capture", async () => {
	const output: string[] = [];
	const child = spawnSupervised(
		[
			bun,
			"-e",
			"process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>{ process.stdout.write(Buffer.from([0xa6,0x8a])); process.stderr.write('界'); },10);",
		],
		{ onData: (text) => output.push(text) },
	);
	expect(await child.exited).toBe(0);
	expect(output.join("")).toContain("🦊");
	expect(output.join("")).toContain("界");
	expect(output.join("")).not.toContain("�");
});

test("stop kills a long-lived child and resolves on its exit", async () => {
	const child = spawnSupervised([bun, "-e", "setInterval(() => {}, 1000)"]);
	expect(child.pid).toBeGreaterThan(0);
	await child.stop();
	expect(await child.exited).toBeNull();
	await child.stop();
});

test("a failed launch is a null exit, never a throw", async () => {
	const child = spawnSupervised(["/definitely/not/a/binary"]);
	expect(await child.exited).toBeNull();
	expect(child.stderrTail().length).toBeGreaterThan(0);
	await child.stop();
});

test.skipIf(process.platform === "win32")(
	"a child spawned with exitWithParent dies when its host is killed outright",
	async () => {
		const marker = `supervised-orphan-${process.pid}-${Date.now()}`;
		const host = Bun.spawn(
			[
				bun,
				"-e",
				`const { spawnSupervised } = await import(${JSON.stringify(`${import.meta.dir}/supervised.ts`)});
				spawnSupervised([process.execPath, "-e", "setInterval(() => {}, 1000)", ${JSON.stringify(marker)}], { exitWithParent: true });
				console.log("ready");
				setInterval(() => {}, 1000);`,
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		const reader = host.stdout.getReader();
		await reader.read();
		const running = () => Bun.spawnSync(["pgrep", "-f", marker]).exitCode === 0;
		expect(running()).toBe(true);
		host.kill("SIGKILL");
		await host.exited;
		const deadline = Date.now() + 5_000;
		while (running() && Date.now() < deadline) await Bun.sleep(100);
		expect(running()).toBe(false);
	},
	15_000,
);

test.skipIf(process.platform === "win32")(
	"the watchdog keeps exit codes above 128 and leaves no listener after exit",
	async () => {
		const marker = `supervised-exit-${process.pid}-${Date.now()}`;
		const child = spawnSupervised([bun, "-e", "process.exit(143)", marker], {
			exitWithParent: true,
		});
		expect(await child.exited).toBe(143);
		const deadline = Date.now() + 2_000;
		while (Bun.spawnSync(["pgrep", "-f", marker]).exitCode === 0 && Date.now() < deadline)
			await Bun.sleep(50);
		expect(Bun.spawnSync(["pgrep", "-f", marker]).exitCode).not.toBe(0);
	},
);

test.skipIf(process.platform === "win32")(
	"a watched child killed by a signal still reports a null exit",
	async () => {
		const marker = `supervised-signal-${process.pid}-${Date.now()}`;
		const child = spawnSupervised([bun, "-e", "setInterval(() => {}, 1000)", marker], {
			exitWithParent: true,
		});
		const deadline = Date.now() + 5_000;
		while (Bun.spawnSync(["pgrep", "-f", marker]).exitCode !== 0 && Date.now() < deadline) {
			await Bun.sleep(50);
		}
		Bun.spawnSync(["pkill", "-KILL", "-f", marker]);
		expect(await child.exited).toBeNull();
	},
);
