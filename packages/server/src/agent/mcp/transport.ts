import {
	type JSONRPCMessage,
	ReadBuffer,
	STDIO_DEFAULT_MAX_BUFFER_SIZE,
	serializeMessage,
	type Transport,
} from "@modelcontextprotocol/client";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { DRAIN_GRACE_MS, type PipedProcess, spawnPiped } from "../../subprocess";

export class OwnedStdioTransport implements Transport {
	onclose: Transport["onclose"];
	onerror: Transport["onerror"];
	onmessage: Transport["onmessage"];
	private child: PipedProcess | undefined;
	private readonly buffer: ReadBuffer;
	private readonly readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
	private drains: Promise<void>[] = [];
	private closing: Promise<void> | undefined;
	private closed = false;
	private readonly options: StdioServerParameters;
	private readonly onStderr: (chunk: Uint8Array) => void;

	constructor(options: StdioServerParameters, onStderr: (chunk: Uint8Array) => void) {
		this.options = options;
		this.onStderr = onStderr;
		this.buffer = new ReadBuffer({
			maxBufferSize: options.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE,
		});
	}

	async start(): Promise<void> {
		if (this.child || this.closed) throw new Error("MCP transport cannot start again");
		const child = spawnPiped([this.options.command, ...(this.options.args ?? [])], {
			...(this.options.cwd ? { cwd: this.options.cwd } : {}),
			env: this.options.env ?? {},
		});
		this.child = child;
		this.drains = [
			this.read(child.stdout, (chunk) => {
				this.buffer.append(Buffer.from(chunk));
				for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage())
					this.onmessage?.(message);
			}),
			this.read(child.stderr, this.onStderr),
		];
		void child.exited.then(() => this.close()).catch((error: unknown) => this.report(error));
	}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	private report(error: unknown): void {
		if (!this.closed) this.onerror?.(error instanceof Error ? error : new Error(String(error)));
	}

	private async read(
		stream: ReadableStream<Uint8Array>,
		accept: (chunk: Uint8Array) => void,
	): Promise<void> {
		const reader = stream.getReader();
		this.readers.push(reader);
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				accept(result.value);
			}
		} catch (error) {
			this.report(error);
			void this.close().catch((failure: unknown) => this.report(failure));
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.child || this.closed) throw new Error("MCP transport is closed");
		this.child.stdin.write(serializeMessage(message));
		await this.child.stdin.flush();
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			try {
				await this.child?.stop();
			} finally {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						Promise.all(this.drains),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, DRAIN_GRACE_MS);
						}),
					]);
				} finally {
					clearTimeout(timer);
					await Promise.allSettled(this.readers.map((reader) => reader.cancel()));
					this.buffer.clear();
					this.onclose?.();
				}
			}
		})();
		return this.closing;
	}
}
