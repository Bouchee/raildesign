import type { ThinkingLevel, WireModel } from "@thinkrail/contracts";

export interface CommandOperations {
	exec(
		command: string,
		cwd: string,
		options: {
			env?: NodeJS.ProcessEnv;
			onData(data: Buffer): void;
			signal?: AbortSignal;
			timeout?: number;
		},
	): Promise<{ exitCode: number | null }>;
}

export type BackgroundCommandStatus = "running" | "stopping" | "completed" | "error" | "stopped";

export interface BackgroundCommandStart {
	command: string;
	name?: string;
	timeout?: number;
}

export interface BackgroundCommandContext {
	cwd: string;
	sessionFile?: string | undefined;
	model?: Pick<WireModel, "provider" | "id"> | undefined;
	thinkingLevel?: ThinkingLevel;
	shellPath?: string | undefined;
	commandPrefix?: string | undefined;
	exposeSessionEnvironment?: boolean;
}

export interface BackgroundCommandsBinding {
	sessionId: string;
	getContext(): BackgroundCommandContext;
	canDeliverCompletion?(): boolean;
}

export interface BackgroundCommandsOptions {
	createOperations?(options: { shellPath?: string }): CommandOperations;
}

export interface BackgroundCommandSnapshot {
	readonly id: string;
	readonly sessionId: string;
	readonly name: string;
	readonly command: string;
	readonly status: BackgroundCommandStatus;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly exitCode?: number | null;
	readonly errorMessage?: string;
}

export interface BackgroundCommandOutput {
	readonly text: string;
	readonly truncated: boolean;
}

export interface BackgroundCommandHandle {
	readonly id: string;
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput | undefined;
	stop(): BackgroundCommandSnapshot;
	claimCompletion(): void;
}

export interface BackgroundCommandCompletion {
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput;
}

export interface BackgroundCommandFlush {
	readonly atTurnEnd?: boolean;
}

export interface BackgroundCommandCompletionBinding {
	deliver(
		batch: readonly BackgroundCommandCompletion[],
		flush: BackgroundCommandFlush,
	): readonly BackgroundCommandCompletion[];
	canDeliverCompletion?(flush: BackgroundCommandFlush): boolean;
}

export interface BackgroundCommands {
	readonly sessionId: string;
	start(input: BackgroundCommandStart): BackgroundCommandHandle;
	list(): BackgroundCommandSnapshot[];
	find(id: string): BackgroundCommandHandle | undefined;
	onChange(listener: () => void): () => void;
	bindCompletion(binding: BackgroundCommandCompletionBinding): () => void;
	flushCompletions(flush?: BackgroundCommandFlush): void;
	dispose(options?: { timeoutMs?: number }): Promise<void>;
}
