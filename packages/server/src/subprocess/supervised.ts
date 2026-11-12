import { DRAIN_GRACE_MS, killTree, spawnOptions } from "./runBounded";

const STDERR_TAIL_BYTES = 4096;

export type SupervisedOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** POSIX: the child dies with the host even when the host is SIGKILLed. */
	exitWithParent?: boolean;
	onData?: (text: string) => void;
};

// The shell leads the process group, forks a listener on the host's stdin pipe, then becomes the
// command itself so exit codes and signals stay native. A newline from the host releases the listener;
// EOF without one means the host died, so it kills the whole group, descendants included.
const WATCHDOG =
	'exec 3<&0; (read _ <&3 || kill -s KILL 0) </dev/null >/dev/null 2>&1 & exec "$@" </dev/null 3<&-';

export type Supervised = {
	pid: number;
	exited: Promise<number | null>;
	stop: () => Promise<void>;
	stderrTail: () => string;
};

function drainTail(stream: ReadableStream<Uint8Array>, keep: (text: string) => void) {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	const emit = (text: string) => {
		try {
			keep(text);
		} catch {}
	};
	const done = (async () => {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			emit(decoder.decode(chunk.value, { stream: true }));
		}
		emit(decoder.decode());
	})().catch(() => {});
	return { done, cancel: () => reader.cancel().catch(() => {}) };
}

export function spawnSupervised(argv: string[], opts: SupervisedOptions = {}): Supervised {
	const watched = opts.exitWithParent === true && process.platform !== "win32";
	let proc: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
	try {
		proc = watched
			? Bun.spawn(["/bin/sh", "-c", WATCHDOG, "sh", ...argv], {
					...spawnOptions(opts),
					stdin: "pipe",
				})
			: Bun.spawn(argv, spawnOptions(opts));
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			pid: 0,
			exited: Promise.resolve(null),
			stop: async () => {},
			stderrTail: () => message,
		};
	}
	let tail = "";
	const stdout = drainTail(proc.stdout, (text) => opts.onData?.(text));
	const stderr = drainTail(proc.stderr, (text) => {
		tail = (tail + text).slice(-STDERR_TAIL_BYTES);
		opts.onData?.(text);
	});
	let killed = false;
	const exited = proc.exited.then(async (code) => {
		if (watched && proc.stdin && typeof proc.stdin !== "number") {
			try {
				proc.stdin.write("\n");
				await proc.stdin.end();
			} catch {}
		}
		if (opts.onData) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.all([stdout.done, stderr.done]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, DRAIN_GRACE_MS);
				}),
			]);
			clearTimeout(timer);
			await Promise.all([stdout.cancel(), stderr.cancel()]);
		}
		return killed || proc.signalCode ? null : code;
	});
	let stopping: Promise<void> | null = null;
	return {
		pid: proc.pid,
		exited,
		stop: () => {
			stopping ??= (async () => {
				if (proc.exitCode === null && proc.signalCode === null) {
					killed = true;
					await killTree(proc);
				}
				await exited;
			})();
			return stopping;
		},
		stderrTail: () => tail,
	};
}
