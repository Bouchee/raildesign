import type { LoginFrame, LoginPush } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { dataDir } from "../persistence";
import {
	acquireMcpSignInLock,
	createMcpConnection,
	loadHostMcpConfig,
	type McpConnection,
	type McpProjectPolicy,
	OwnedMcpOAuthProvider,
	redactMcpText,
} from "./mcp";

export type McpProbeAction = "login" | "test" | "logout";
interface Probe {
	loginId: string;
	ownerClientKey: string;
	serverName: string;
	workspaceId: string;
	controller: AbortController;
	connection?: McpConnection;
	pendingInput?: (value: string) => void;
	last?: LoginFrame;
	done: Promise<LoginFrame>;
}
const probes = new Map<string, Probe>();
let seq = 0;
let publish: (push: LoginPush, ownerClientKey: string) => void = () => {};
export function setMcpLoginPublisher(fn: typeof publish): void {
	publish = fn;
}
export function isMcpLoginId(loginId: string): boolean {
	return loginId.startsWith("mcplogin_");
}

function frame(probe: Probe, raw: LoginFrame): void {
	if (probe.last) return;
	const next = raw.kind === "error" ? { ...raw, message: redactMcpText(raw.message) } : raw;
	if (next.kind === "success" || next.kind === "error") probe.last = next;
	publish(
		{
			loginId: probe.loginId,
			providerId: `mcp:${probe.serverName}`,
			frame: next,
			target: { kind: "mcp", workspaceId: probe.workspaceId, serverName: probe.serverName },
		},
		probe.ownerClientKey,
	);
}

export function startMcpProbe(options: {
	action: McpProbeAction;
	workspaceId: string;
	cwd: string;
	projectTrusted: boolean;
	policy: McpProjectPolicy;
	serverName: string;
	ownerClientKey: string;
	deadlineMs?: number;
}): { loginId: string; done: Promise<LoginFrame> } {
	const lock = acquireMcpSignInLock(options.serverName, "settings");
	if ("heldBy" in lock)
		throw new Error(
			`A sign-in for "${options.serverName}" is already running${lock.heldBy === "chat" ? " in a chat" : ""}.`,
		);
	let finish!: (result: LoginFrame) => void;
	const done = new Promise<LoginFrame>((resolve) => {
		finish = resolve;
	});
	const probe: Probe = {
		loginId: `mcplogin_${++seq}`,
		ownerClientKey: options.ownerClientKey,
		serverName: options.serverName,
		workspaceId: options.workspaceId,
		controller: new AbortController(),
		done,
	};
	probes.set(probe.loginId, probe);
	const timer = setTimeout(
		() => stop(probe, "Sign-in timed out."),
		options.deadlineMs ?? 10 * 60_000,
	);
	void (async () => {
		let callbackServer: ReturnType<typeof Bun.serve> | undefined;
		try {
			frame(probe, { kind: "progress", message: "Contacting the server…" });
			const entry = loadHostMcpConfig({
				agentDir: dataDir(),
				cwd: options.cwd,
				projectTrusted: options.projectTrusted,
				policy: options.policy,
			}).servers.find((server) => server.name === options.serverName);
			if (!entry)
				throw new Error(`No trusted MCP server named "${options.serverName}" is configured.`);
			const activeEntry = { ...entry, config: { ...entry.config, enabled: true } };
			let provider: OwnedMcpOAuthProvider | undefined;
			if ("url" in entry.config) {
				const config = entry.config;
				let redirectUrl =
					config.oauth?.callbackUrl ??
					`http://127.0.0.1:${config.oauth?.callbackPort ?? 0}/callback`;
				let callback: Promise<string> | undefined;
				if (options.action === "login") {
					callback = new Promise<string>((resolve, reject) => {
						probe.pendingInput = resolve;
						probe.controller.signal.addEventListener(
							"abort",
							() => reject(probe.controller.signal.reason),
							{ once: true },
						);
					});
					// Rejection is handled below after discovery; an early cancellation must not be unhandled.
					void callback.catch(() => {});
					const wanted = new URL(redirectUrl);
					callbackServer = Bun.serve({
						hostname: wanted.hostname === "[::1]" ? "::1" : "127.0.0.1",
						port: Number(wanted.port || 80),
						fetch(request) {
							const url = new URL(request.url);
							if (
								probe.controller.signal.aborted ||
								url.pathname !== wanted.pathname ||
								!provider ||
								url.searchParams.get("state") !== provider.state()
							)
								return new Response("Invalid or expired sign-in callback.", { status: 400 });
							const returned = new URL(redirectUrl);
							returned.search = url.search;
							probe.pendingInput?.(returned.href);
							return new Response("Sign-in received. You may close this tab.", {
								headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
							});
						},
					});
					wanted.port = String(callbackServer.port);
					redirectUrl = wanted.href;
				}
				provider = new OwnedMcpOAuthProvider({
					name: entry.name,
					config,
					redirectUrl,
					signal: probe.controller.signal,
					...(options.action === "login"
						? {
								onAuthorization: (url: string) => {
									frame(probe, {
										kind: "authUrl",
										url,
										instructions: "Finish signing in in your browser.",
									});
									frame(probe, {
										kind: "prompt",
										message:
											"Or paste the complete address the browser was sent to after signing in",
									});
								},
							}
						: {}),
				});
				if (options.action === "logout") provider.invalidateCredentials("all");
				if (options.action === "login") {
					const result = await provider.authorize();
					if (result === "REDIRECT") {
						if (!callback) throw new Error("OAuth callback is unavailable.");
						await provider.authorize(await callback);
					}
				}
			} else if (options.action !== "test")
				throw new Error("This stdio MCP server does not use OAuth sign-in.");
			probe.controller.signal.throwIfAborted();
			if (options.action !== "logout") {
				probe.connection = await createMcpConnection({
					entry: activeEntry,
					cwd: options.cwd,
					signal: probe.controller.signal,
					...(provider ? { oauthProvider: provider } : {}),
				});
				const tools = await probe.connection.connect();
				frame(probe, { kind: "progress", message: `Connected · ${tools.length} tools` });
			}
			probe.controller.signal.throwIfAborted();
			frame(probe, { kind: "success" });
		} catch (error) {
			frame(probe, {
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			clearTimeout(timer);
			await callbackServer?.stop(true);
			await probe.connection?.close().catch(() => {});
			probe.controller.abort(new Error("MCP probe ended."));
			probes.delete(probe.loginId);
			lock.release();
			finish(probe.last ?? { kind: "error", message: "Sign-in did not finish." });
		}
	})();
	return { loginId: probe.loginId, done };
}

function owned(loginId: string, clientKey: string): Probe | undefined {
	const probe = probes.get(loginId);
	if (probe && probe.ownerClientKey !== clientKey)
		throw new CodedError("LOGIN_NOT_OWNER", "This sign-in was started on another device.");
	return probe;
}
function stop(probe: Probe, message: string): void {
	if (probe.last) return;
	frame(probe, { kind: "error", message });
	probe.controller.abort(new Error(message));
	void probe.connection?.close().catch(() => {});
}
export function replyMcpProbe(loginId: string, clientKey: string, value: string): void {
	const probe = owned(loginId, clientKey);
	if (probe && !probe.last) probe.pendingInput?.(value);
}
export function cancelMcpProbe(loginId: string, clientKey: string): void {
	const probe = owned(loginId, clientKey);
	if (probe) stop(probe, "Sign-in cancelled.");
}
export function cancelMcpProbesOwnedBy(clientKey: string): void {
	for (const probe of probes.values())
		if (probe.ownerClientKey === clientKey) stop(probe, "Sign-in cancelled.");
}
export async function cancelAllMcpProbes(): Promise<void> {
	const active = [...probes.values()];
	for (const probe of active) stop(probe, "Sign-in cancelled.");
	await Promise.all(active.map((probe) => probe.done));
}
/** Await cleanup before accepting another authorization after a trust/config change. */
export async function cancelMcpProbesForWorkspace(workspaceId: string): Promise<void> {
	const active = [...probes.values()].filter((probe) => probe.workspaceId === workspaceId);
	for (const probe of active)
		stop(probe, "MCP trust or configuration changed. Start sign-in again.");
	await Promise.all(active.map((probe) => probe.done));
}
