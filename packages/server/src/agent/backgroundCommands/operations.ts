import { spawnSupervised } from "../../subprocess";
import type { CommandOperations } from "./types";

export function createShellOperations(options: { shellPath?: string }): CommandOperations {
	return {
		async exec(command, cwd, context) {
			context.signal?.throwIfAborted();
			const shell = options.shellPath ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
			const args =
				process.platform === "win32" && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)
					? ["/d", "/s", "/c", command]
					: ["-c", command];
			const child = spawnSupervised([shell, ...args], {
				cwd,
				exitWithParent: true,
				...(context.env ? { env: context.env } : {}),
				onData: (text) => context.onData(Buffer.from(text)),
			});
			if (child.pid === 0) throw new Error(child.stderrTail());
			let stopping: Promise<void> | undefined;
			const stop = () => {
				stopping ??= child.stop();
				void stopping.catch(() => {});
			};
			let timedOut = false;
			const timer =
				context.timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							stop();
						}, context.timeout * 1000);
			context.signal?.addEventListener("abort", stop, { once: true });
			if (context.signal?.aborted) stop();
			try {
				const exitCode = await child.exited;
				if (timedOut) throw new Error(`Command timed out after ${context.timeout} seconds`);
				return { exitCode };
			} finally {
				clearTimeout(timer);
				context.signal?.removeEventListener("abort", stop);
				await stopping;
			}
		},
	};
}
