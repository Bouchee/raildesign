import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginPush } from "@thinkrail/contracts";
import {
	createMcpConnection,
	isAllowedMcpSignInUrl,
	mcpPolicyOf,
	OwnedMcpOAuthProvider,
} from "./mcp";
import { startOAuthMcpFixture } from "./mcp/fixtures/oauthServer";
import {
	cancelAllMcpProbes,
	cancelMcpProbe,
	cancelMcpProbesForWorkspace,
	replyMcpProbe,
	setMcpLoginPublisher,
	startMcpProbe,
} from "./mcpSignIn";

let root: string;
let savedData: string | undefined;
let fixture: ReturnType<typeof startOAuthMcpFixture>;
const pushes: { push: LoginPush; owner: string }[] = [];
const pending: Promise<unknown>[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "sdk-mcp-oauth-"));
	savedData = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = root;
	fixture = startOAuthMcpFixture();
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({ mcpServers: { docs: { url: fixture.url } } }),
	);
	pushes.length = 0;
	setMcpLoginPublisher((push, owner) => pushes.push({ push, owner }));
});
afterEach(async () => {
	await cancelAllMcpProbes();
	await Promise.allSettled(pending.splice(0));
	setMcpLoginPublisher(() => {});
	fixture.stop();
	if (savedData === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedData;
	rmSync(root, { recursive: true, force: true });
});
function probe(action: "login" | "test" | "logout" = "login", deadlineMs = 3000) {
	const result = startMcpProbe({
		action,
		workspaceId: "workspace",
		cwd: root,
		projectTrusted: false,
		policy: mcpPolicyOf(undefined),
		serverName: "docs",
		ownerClientKey: "owner",
		deadlineMs,
	});
	pending.push(result.done);
	return result;
}
async function authorizationUrl() {
	for (
		let attempt = 0;
		attempt < 150 && !pushes.some(({ push }) => push.frame.kind === "authUrl");
		attempt++
	)
		await Bun.sleep(10);
	expect(pushes.find(({ push }) => push.frame.kind === "authUrl")).toBeDefined();
	const frame = pushes.find(({ push }) => push.frame.kind === "authUrl")?.push.frame;
	if (frame?.kind !== "authUrl") throw new Error("No authorization frame.");
	return new URL(frame.url);
}
function callbackUrl(auth: URL, state = auth.searchParams.get("state") ?? "") {
	const callback = new URL(auth.searchParams.get("redirect_uri") ?? "");
	callback.searchParams.set("code", "fixture-code");
	callback.searchParams.set("state", state);
	return callback;
}
test("official OAuth discovery, DCR and PKCE finish through the owned loopback callback; saved credentials reconnect and logout", async () => {
	const login = probe();
	const auth = await authorizationUrl();
	expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
	expect(auth.searchParams.get("code_challenge")).toBeTruthy();
	const callback = callbackUrl(auth);
	expect((await fetch(callback)).status).toBe(200);
	expect(await login.done).toEqual({ kind: "success" });
	expect(fixture.tokenRequests()).toBe(1);
	expect(pushes.every(({ owner, push }) => owner === "owner" && push.target?.kind === "mcp")).toBe(
		true,
	);
	const credentials = readdirSync(join(root, "mcp-auth"));
	expect(credentials).toHaveLength(1);
	const path = join(root, "mcp-auth", credentials[0] ?? "");
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(statSync(join(root, "mcp-auth")).mode & 0o777).toBe(0o700);
	expect(readFileSync(path, "utf8")).toContain("fixture-access-token");
	expect(JSON.stringify(pushes)).not.toContain("fixture-access-token");
	expect(await probe("test").done).toEqual({ kind: "success" });
	expect(await probe("logout").done).toEqual({ kind: "success" });
	expect(readdirSync(join(root, "mcp-auth"))).toEqual([]);
	expect((await probe("test").done).kind).toBe("error");
});
test("only the initiating client may reply/cancel, and a pasted callback must carry this flow's state", async () => {
	const login = probe();
	const auth = await authorizationUrl();
	expect(() => replyMcpProbe(login.loginId, "other", callbackUrl(auth).href)).toThrow(
		"another device",
	);
	expect(() => cancelMcpProbe(login.loginId, "other")).toThrow("another device");
	expect((await fetch(callbackUrl(auth, "wrong"))).status).toBe(400);
	expect(fixture.tokenRequests()).toBe(0);
	replyMcpProbe(login.loginId, "owner", callbackUrl(auth).href);
	expect(await login.done).toEqual({ kind: "success" });
});
test("workspace revocation cancels callback/listener, releases the namespace lock and cannot exchange a late authorization", async () => {
	const login = probe();
	const auth = await authorizationUrl();
	expect(() => probe()).toThrow("already running");
	await cancelMcpProbesForWorkspace("other-workspace");
	expect(pushes.at(-1)?.push.frame.kind).toBe("prompt");
	await cancelMcpProbesForWorkspace("workspace");
	expect(await login.done).toMatchObject({ kind: "error" });
	replyMcpProbe(login.loginId, "owner", callbackUrl(auth).href);
	expect(fixture.tokenRequests()).toBe(0);
	await expect(fetch(callbackUrl(auth))).rejects.toBeDefined();
	const next = probe();
	cancelMcpProbe(next.loginId, "owner");
	expect(await next.done).toEqual({ kind: "error", message: "Sign-in cancelled." });
});
test("deadline cancels a waiting sign-in and releases its lock after cleanup", async () => {
	const login = probe("login", 80);
	expect(await login.done).toEqual({ kind: "error", message: "Sign-in timed out." });
	const next = probe();
	cancelMcpProbe(next.loginId, "owner");
	await next.done;
	expect(fixture.tokenRequests()).toBe(0);
});
test("revoking trust while the token exchange is in flight prevents late credential persistence", async () => {
	fixture.stop();
	fixture = startOAuthMcpFixture({ tokenDelayMs: 120 });
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({ mcpServers: { docs: { url: fixture.url } } }),
	);
	const login = probe();
	const auth = await authorizationUrl();
	await fetch(callbackUrl(auth));
	for (let attempt = 0; attempt < 100 && fixture.tokenRequests() === 0; attempt++)
		await Bun.sleep(5);
	expect(fixture.tokenRequests()).toBe(1);
	await cancelMcpProbesForWorkspace("workspace");
	expect((await login.done).kind).toBe("error");
	await Bun.sleep(150);
	for (const path of readdirSync(join(root, "mcp-auth")))
		expect(readFileSync(join(root, "mcp-auth", path), "utf8")).not.toContain(
			"fixture-access-token",
		);
});
test("unsafe authorization endpoints never reach the browser and errors remain redacted", async () => {
	fixture.stop();
	fixture = startOAuthMcpFixture({
		authorizationEndpoint: "http://remote.example/authorize?token=secret-value",
	});
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({ mcpServers: { docs: { url: fixture.url } } }),
	);
	const result = await probe().done;
	expect(result.kind).toBe("error");
	expect(pushes.some(({ push }) => push.frame.kind === "authUrl")).toBe(false);
	expect(JSON.stringify(pushes)).not.toContain("secret-value");
});
test("authorization allowlist rejects remote HTTP, other schemes and embedded credentials", () => {
	for (const url of [
		"https://auth.example/login",
		"http://127.0.0.1:9234/authorize",
		"http://localhost/authorize",
		"http://[::1]/authorize",
	])
		expect(isAllowedMcpSignInUrl(url)).toBe(true);
	for (const url of [
		"http://auth.example/login",
		"file:///tmp/token",
		"javascript:alert(1)",
		"https://user:pass@auth.example",
		"not a url",
	])
		expect(isAllowedMcpSignInUrl(url)).toBe(false);
});
test("an aborted OAuth provider cannot persist tokens or reuse another issuer's credentials", () => {
	const controller = new AbortController();
	const provider = new OwnedMcpOAuthProvider({
		name: "direct",
		config: { url: fixture.url },
		redirectUrl: "http://127.0.0.1:9000/callback",
		signal: controller.signal,
	});
	provider.saveTokens({
		access_token: "local-token",
		token_type: "Bearer",
		issuer: "https://issuer.example",
	});
	expect(provider.tokens({ issuer: "https://other.example" })).toBeUndefined();
	controller.abort();
	expect(() => provider.saveTokens({ access_token: "late-token", token_type: "Bearer" })).toThrow();
	expect(
		readFileSync(join(root, "mcp-auth", readdirSync(join(root, "mcp-auth"))[0] ?? ""), "utf8"),
	).not.toContain("late-token");
});
test("dynamic OAuth clients are registered again when a later flow uses a different loopback redirect", async () => {
	fixture.stop();
	fixture = startOAuthMcpFixture({ strictRedirects: true });
	let authorize: string | undefined;
	let firstClient: string | undefined;
	for (const port of [8123, 8124]) {
		const provider = new OwnedMcpOAuthProvider({
			name: "redirect-test",
			config: { url: fixture.url },
			redirectUrl: `http://127.0.0.1:${port}/callback`,
			signal: new AbortController().signal,
			onAuthorization: (url) => {
				authorize = url;
			},
		});
		expect(await provider.authorize()).toBe("REDIRECT");
		if (!authorize) throw new Error("Missing authorization URL.");
		const url = new URL(authorize);
		const client = url.searchParams.get("client_id");
		if (firstClient === undefined) firstClient = client ?? "";
		else expect(client).not.toBe(firstClient);
		const response = await fetch(url, { redirect: "manual" });
		expect(response.status).toBe(302);
		const returned = response.headers.get("location");
		if (!returned) throw new Error("Missing callback.");
		expect(await provider.authorize(returned)).toBe("AUTHORIZED");
		provider.invalidateCredentials("tokens");
	}
	expect(fixture.registrationRequests()).toBe(2);
	expect(fixture.tokenRequests()).toBe(2);
});
test("SDK HTTP reports sign-in required without performing a model call or leaking credentials", async () => {
	const connection = await createMcpConnection({
		entry: { name: "http", source: "test", config: { url: fixture.url } },
		cwd: root,
	});
	try {
		await expect(connection.connect()).rejects.toThrow();
		expect(connection.status().state).toBe("needs-sign-in");
		expect(fixture.tokenRequests()).toBe(0);
	} finally {
		await connection.close();
	}
});
