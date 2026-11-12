const TOKEN = "fixture-access-token";

function rpc(body: { id?: unknown; method?: string; params?: { protocolVersion?: string } }) {
	switch (body.method) {
		case "initialize":
			return {
				protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "oauth-fixture", version: "1.0.0" },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: "whoami",
						description: "Report the signed-in user",
						inputSchema: { type: "object", properties: {} },
						annotations: { readOnlyHint: true },
					},
				],
			};
		case "tools/call":
			return { content: [{ type: "text", text: "fixture-user" }] };
		default:
			return {};
	}
}

export function startOAuthMcpFixture(
	options: {
		tokenDelayMs?: number;
		authorizationEndpoint?: string;
		strictRedirects?: boolean;
	} = {},
): {
	url: string;
	tokenRequests: () => number;
	registrationRequests: () => number;
	stop: () => void;
} {
	let tokenRequests = 0;
	let registrations = 0;
	const clients = new Map<string, string[]>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname, origin } = new URL(request.url);
			const json = (value: unknown, status = 200) => Response.json(value, { status });
			if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
				return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
			}
			if (pathname === "/.well-known/oauth-authorization-server") {
				return json({
					issuer: origin,
					authorization_endpoint: options.authorizationEndpoint ?? `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			}
			if (pathname === "/register") {
				const metadata = (await request.json()) as Record<string, unknown>;
				const clientId = `fixture-client-${++registrations}`;
				clients.set(
					clientId,
					Array.isArray(metadata.redirect_uris)
						? metadata.redirect_uris.filter((value): value is string => typeof value === "string")
						: [],
				);
				return json({ ...metadata, client_id: clientId, token_endpoint_auth_method: "none" }, 201);
			}
			if (pathname === "/authorize") {
				const params = new URL(request.url).searchParams;
				const redirect = params.get("redirect_uri") ?? "";
				if (!clients.get(params.get("client_id") ?? "")?.includes(redirect))
					return json({ error: "invalid_redirect_uri" }, 400);
				const callback = new URL(redirect);
				callback.searchParams.set("code", "fixture-code");
				callback.searchParams.set("state", params.get("state") ?? "");
				return Response.redirect(callback.href, 302);
			}
			if (pathname === "/token") {
				tokenRequests++;
				const params = new URLSearchParams(await request.text());
				if (
					options.strictRedirects &&
					params.get("grant_type") === "authorization_code" &&
					!clients.get(params.get("client_id") ?? "")?.includes(params.get("redirect_uri") ?? "")
				)
					return json({ error: "invalid_grant" }, 400);
				if (options.tokenDelayMs) await Bun.sleep(options.tokenDelayMs);
				return json({
					access_token: TOKEN,
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "fixture-refresh",
				});
			}
			if (pathname !== "/mcp") return new Response("not found", { status: 404 });
			if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				return new Response("unauthorized", {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					},
				});
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body = (await request.json()) as { id?: unknown; method?: string };
			if (body.id === undefined) return new Response(null, { status: 202 });
			return json({ jsonrpc: "2.0", id: body.id, result: rpc(body) });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		tokenRequests: () => tokenRequests,
		registrationRequests: () => registrations,
		stop: () => server.stop(true),
	};
}
