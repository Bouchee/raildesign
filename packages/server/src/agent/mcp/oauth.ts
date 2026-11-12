import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	auth,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { dataDir } from "../../persistence";
import type { McpHttpServerConfig } from "./types";

type Tokens = NonNullable<Awaited<ReturnType<OAuthClientProvider["tokens"]>>>;
type Client = NonNullable<Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>>;
type IssuerContext = Parameters<OAuthClientProvider["tokens"]>[0];
interface ProviderOptions {
	name: string;
	config: McpHttpServerConfig;
	redirectUrl: string;
	signal: AbortSignal;
	onAuthorization?: (url: string) => void;
	directory?: string;
}

const clientSchema = z.object({ client_id: z.string() }).passthrough();
const tokenSchema = z.object({ access_token: z.string(), token_type: z.string() }).passthrough();
const storedSchema = z.object({
	version: z.literal(1),
	client: clientSchema.optional(),
	tokens: tokenSchema.optional(),
});

export function isAllowedMcpSignInUrl(raw: string): boolean {
	if (!URL.canParse(raw)) return false;
	const url = new URL(raw);
	return (
		!url.username &&
		!url.password &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	);
}

export class McpSignInRequiredError extends Error {
	constructor() {
		super("This MCP server needs sign-in. Sign in in Settings › MCP servers.");
		this.name = "McpSignInRequiredError";
	}
}

/** Protocol/discovery/PKCE are supplied by the official client; this class owns local credentials. */
export class OwnedMcpOAuthProvider implements OAuthClientProvider {
	readonly clientMetadataUrl?: string;
	private readonly options: ProviderOptions;
	private readonly path: string;
	private readonly stateValue = randomBytes(32).toString("base64url");
	private verifier: string | undefined;
	private discovery: OAuthDiscoveryState | undefined;
	private client: Client | undefined;
	private tokenSet: Tokens | undefined;

	constructor(options: ProviderOptions) {
		this.options = options;
		if (
			options.config.oauth?.clientRegistration !== "dcr" &&
			options.config.oauth?.clientMetadataUrl
		)
			this.clientMetadataUrl = options.config.oauth.clientMetadataUrl;
		if (options.config.oauth?.clientRegistration === "cimd" && !this.clientMetadataUrl) {
			throw new Error("OAuth CIMD requires oauth.clientMetadataUrl for this application.");
		}
		const key = createHash("sha256")
			.update(
				JSON.stringify([
					options.name,
					options.config.url,
					options.config.oauth?.clientId,
					options.config.oauth?.clientSecret,
					options.config.oauth?.clientRegistration,
					options.config.oauth?.clientMetadataUrl,
				]),
			)
			.digest("hex");
		const directory = join(options.directory ?? dataDir(), "mcp-auth");
		if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
			throw new Error("MCP credential directory must not be a symbolic link.");
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		this.path = join(directory, `${key}.json`);
		try {
			const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || (stat.mode & 0o077) !== 0)
					throw new Error("MCP credentials must be a private file (mode 0600).");
				const saved = storedSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
				this.client = saved.client as Client | undefined;
				this.tokenSet = saved.tokens as Tokens | undefined;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}

	get redirectUrl(): string {
		return this.options.redirectUrl;
	}
	get clientMetadata(): OAuthClientProvider["clientMetadata"] {
		const oauth = this.options.config.oauth;
		return {
			client_name: oauth?.clientName ?? "RailDesign",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: oauth?.clientSecret ? "client_secret_post" : "none",
			...(oauth?.scope ? { scope: oauth.scope } : {}),
		};
	}
	state(): string {
		return this.stateValue;
	}
	private active(): void {
		this.options.signal.throwIfAborted();
	}
	private save(): void {
		this.active();
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(
				temp,
				`${JSON.stringify({ version: 1, client: this.client, tokens: this.tokenSet })}\n`,
				{ mode: 0o600, flag: "wx" },
			);
			this.active();
			renameSync(temp, this.path);
		} finally {
			rmSync(temp, { force: true });
		}
	}
	clientInformation(ctx?: IssuerContext): Client | undefined {
		this.active();
		const oauth = this.options.config.oauth;
		if (oauth?.clientId)
			return {
				client_id: oauth.clientId,
				...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
			};
		if (ctx && this.client?.issuer !== ctx.issuer) return undefined;
		const redirects =
			this.client && "redirect_uris" in this.client ? this.client.redirect_uris : undefined;
		if (!Array.isArray(redirects) || !redirects.includes(this.redirectUrl)) return undefined;
		return this.client;
	}
	saveClientInformation(client: Client): void {
		this.active();
		this.client = client;
		this.save();
	}
	tokens(ctx?: IssuerContext): Tokens | undefined {
		this.active();
		return ctx && this.tokenSet?.issuer !== ctx.issuer ? undefined : this.tokenSet;
	}
	saveTokens(tokens: Tokens): void {
		this.active();
		this.tokenSet = tokens;
		this.save();
	}
	redirectToAuthorization(url: URL): void {
		this.active();
		if (!isAllowedMcpSignInUrl(url.href))
			throw new Error("The server sent a sign-in address that is not https or loopback.");
		if (!this.options.onAuthorization) throw new McpSignInRequiredError();
		this.options.onAuthorization(url.href);
	}
	saveCodeVerifier(value: string): void {
		this.active();
		this.verifier = value;
	}
	codeVerifier(): string {
		this.active();
		if (!this.verifier)
			throw new Error("The OAuth code verifier is no longer available. Start sign-in again.");
		return this.verifier;
	}
	saveDiscoveryState(value: OAuthDiscoveryState): void {
		this.active();
		this.discovery = value;
	}
	discoveryState(): OAuthDiscoveryState | undefined {
		this.active();
		return this.discovery;
	}
	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		this.active();
		if (scope === "all" || scope === "client") this.client = undefined;
		if (scope === "all" || scope === "tokens") this.tokenSet = undefined;
		if (scope === "all" || scope === "verifier") this.verifier = undefined;
		if (scope === "all" || scope === "discovery") this.discovery = undefined;
		if (scope === "all") rmSync(this.path, { force: true });
		else if (scope === "client" || scope === "tokens") this.save();
	}

	/** Abort applies to discovery, registration and exchange, including a late callback after revocation. */
	readonly fetch: NonNullable<Parameters<typeof auth>[1]["fetchFn"]> = (input, init) => {
		this.active();
		const raw = input instanceof Request ? input.url : String(input);
		const metadata = this.options.config.oauth?.authServerMetadataUrl;
		const isMetadata =
			/\/\.well-known\/(?:oauth-authorization-server|openid-configuration)(?:\/|$)/.test(
				new URL(raw).pathname,
			);
		const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		return fetch(metadata && isMetadata ? metadata : input, {
			...init,
			signal: requestSignal
				? AbortSignal.any([this.options.signal, requestSignal])
				: this.options.signal,
		});
	};

	async authorize(callback?: string): Promise<"AUTHORIZED" | "REDIRECT"> {
		this.active();
		let authorizationCode: string | undefined;
		let iss: string | undefined;
		if (callback !== undefined) {
			if (!URL.canParse(callback)) throw new Error("Paste the complete OAuth callback address.");
			const url = new URL(callback);
			const expected = new URL(this.redirectUrl);
			if (
				url.origin !== expected.origin ||
				url.pathname !== expected.pathname ||
				url.hash ||
				url.searchParams.get("state") !== this.stateValue
			) {
				throw new Error("The OAuth callback address or state does not match this sign-in.");
			}
			if (url.searchParams.has("error"))
				throw new Error("The authorization server declined sign-in.");
			authorizationCode = url.searchParams.get("code") ?? undefined;
			iss = url.searchParams.get("iss") ?? undefined;
			if (!authorizationCode)
				throw new Error("The OAuth callback did not include an authorization code.");
		}
		return auth(this, {
			serverUrl: this.options.config.url,
			...(authorizationCode ? { authorizationCode } : {}),
			...(iss ? { iss } : {}),
			...(this.options.config.oauth?.scope ? { scope: this.options.config.oauth.scope } : {}),
			fetchFn: this.fetch,
		});
	}
}
