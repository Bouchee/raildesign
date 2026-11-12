import { killTree, spawnOptions } from "./runBounded";

export interface PipedProcessOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

export type PipedProcess = Pick<
	Bun.Subprocess<"pipe", "pipe", "pipe">,
	"pid" | "stdin" | "stdout" | "stderr" | "exited"
> & { stop(): Promise<void> };

export function spawnPiped(argv: string[], options: PipedProcessOptions = {}): PipedProcess {
	const child = Bun.spawn(argv, { ...spawnOptions(options), stdin: "pipe" });
	let stopping: Promise<void> | undefined;
	return {
		pid: child.pid,
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		exited: child.exited,
		stop() {
			stopping ??= (async () => {
				if (child.exitCode === null && child.signalCode === null) await killTree(child);
				await child.exited;
			})();
			return stopping;
		},
	};
}
