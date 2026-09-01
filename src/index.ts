import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Effect } from "effect";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadMcpConfig } from "./config.js";
import { McpServerManager } from "./server-manager.js";
import { McpLifecycleManager } from "./lifecycle.js";
import {
	computeServerHash,
	isServerCacheValid,
	loadMetadataCache,
	reconstructToolIndex,
	saveMetadataCache,
	serializeResources,
	serializeTools,
	type ServerCacheEntry,
} from "./metadata-cache.js";
import { CodeMode } from "./codemode/index.js";
import type { JsonSchema } from "./codemode/tool.js";
import {
	buildMcpCodeModeTools,
	type McpClient,
	type McpToolRef,
	type MetadataFreshness,
} from "./mcp/codemode-adapter.js";
import type { McpCallResult } from "./mcp/result-projector.js";
import { createMcpAuthorizer } from "./mcp/authorization.js";
import { getStoredTokens, getTokensPath, saveStoredTokens } from "./oauth-handler.js";
import { getPiAgentDir } from "./paths.js";
import type { McpConfig, McpContent, McpResource, McpTool, ServerEntry, ToolIndexEntry } from "./types.js";

const FAILURE_BACKOFF_MS = 60 * 1000;
const DEFAULT_INLINE_LIMIT = 20;
const TOOL_POLICY_PATH = join(getPiAgentDir(), "mcp-tool-policies.json");
const MCP_DEBUG = process.env.PI_MCP_DEBUG === "1";

function debugWarn(...args: unknown[]): void {
	if (MCP_DEBUG) {
		console.warn(...args);
	}
}

function debugError(...args: unknown[]): void {
	if (MCP_DEBUG) {
		console.error(...args);
	}
}

interface ServerToolPolicy {
	mode: "denylist" | "allowlist";
	tools: Set<string>;
}

interface McpExtensionState {
	manager: McpServerManager;
	lifecycle: McpLifecycleManager;
	config: McpConfig;
	toolIndex: Map<string, ToolIndexEntry[]>;
	failureTracker: Map<string, number>;
	toolPolicies: Map<string, ServerToolPolicy>;
	metadataFreshness: Map<string, MetadataFreshness>;
	ui?: ExtensionContext["ui"];
}

interface OAuthCallbackServerHandle {
	redirectUrl: string;
	waitForCode: (timeoutMs: number) => Promise<string>;
	close: () => Promise<void>;
}

class ExtensionOAuthClientProvider implements OAuthClientProvider {
	private codeVerifierValue?: string;
	private clientInformationValue?: OAuthClientInformationMixed;
	private configuredClientInformation?: OAuthClientInformationMixed;
	clientMetadataUrl?: string;

	constructor(
		private readonly serverName: string,
		definition: ServerEntry,
		readonly redirectUrl: string,
		private readonly onRedirect: (url: URL) => void,
	) {
		if (definition.oauthClientMetadataUrl?.trim()) {
			this.clientMetadataUrl = definition.oauthClientMetadataUrl.trim();
		}
		if (definition.oauthClientId?.trim()) {
			this.configuredClientInformation = {
				client_id: definition.oauthClientId.trim(),
				client_secret: definition.oauthClientSecret?.trim() || undefined,
				...(definition.oauthTokenEndpointAuthMethod?.trim()
					? { token_endpoint_auth_method: definition.oauthTokenEndpointAuthMethod.trim() }
					: {}),
			};
		}
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "pi-codemode-mcp",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.clientInformationValue ?? this.configuredClientInformation;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.clientInformationValue = clientInformation;
	}

	tokens(): OAuthTokens | undefined {
		const tokens = getStoredTokens(this.serverName);
		if (!tokens) return undefined;
		const out: OAuthTokens = {
			access_token: tokens.access_token,
			token_type: tokens.token_type ?? "Bearer",
		};
		if (tokens.refresh_token) out.refresh_token = tokens.refresh_token;
		if (typeof tokens.expires_in === "number") out.expires_in = tokens.expires_in;
		return out;
	}

	saveTokens(tokens: OAuthTokens): void {
		saveStoredTokens(this.serverName, {
			access_token: tokens.access_token,
			token_type: tokens.token_type,
			refresh_token: tokens.refresh_token,
			expires_in: typeof tokens.expires_in === "number" ? tokens.expires_in : undefined,
		});
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.onRedirect(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.codeVerifierValue = codeVerifier;
	}

	codeVerifier(): string {
		if (!this.codeVerifierValue) {
			throw new Error("No PKCE code verifier available");
		}
		return this.codeVerifierValue;
	}
}

function getConfigPathFromArgv(): string | undefined {
	const idx = process.argv.indexOf("--mcp-config");
	if (idx >= 0 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1];
	}
	return undefined;
}

export default function mcpCodemodeExtension(pi: ExtensionAPI) {
	let state: McpExtensionState | null = null;
	let initPromise: Promise<McpExtensionState> | null = null;

	pi.registerFlag("mcp-config", {
		description: "Path to MCP config file (JSON)",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		initPromise = initializeMcp(pi, ctx);
		initPromise
			.then((loaded) => {
				state = loaded;
				initPromise = null;
				updateStatusBar(loaded);
			})
			.catch((error) => {
				debugError("MCP: initialization failed", error);
				initPromise = null;
			});
	});

	pi.on("session_shutdown", async () => {
		if (!state && initPromise) {
			try {
				state = await initPromise;
			} catch {
				return;
			}
		}

		if (!state) return;
		flushMetadataCache(state);
		await state.lifecycle.gracefulShutdown();
		state = null;
	});

	pi.on("before_agent_start", async (event) => {
		const loaded = await ensureStateReady(state, initPromise);
		if (!loaded) return;
		state = loaded;
		await hydrateAllMetadata(loaded, { refresh: false });
		const snapshot = createCodeModeRuntime(loaded);
		return {
			systemPrompt: `${event.systemPrompt}\n\n# MCP Code Mode\n\n${snapshot.runtime.instructions()}`,
		};
	});

	pi.registerTool({
		name: "mcp_execute",
		label: "MCP Code Mode",
		description:
			"Execute one restricted JavaScript program over the currently authorized MCP tool catalog. The program has no filesystem, process, module, timer, fetch, Pi, or ambient network APIs. Compose dependent operations with await and independent operations with Promise.all. Output is limited to 50KB, 100 MCP calls, and 30 seconds.",
		promptSnippet: "Run confined JavaScript orchestration over authorized MCP tools",
		promptGuidelines: [
			"Use mcp_execute for MCP operations; MCP servers are available only through the Code Mode tools injected into the prompt.",
		],
		parameters: Type.Object({
			code: Type.String({
				description: "Restricted JavaScript program. Return the final plain-data value with `return ...`.",
			}),
		}),
		async execute(
			_toolCallId,
			params: { code: string },
			signal: AbortSignal | undefined,
			_onUpdate,
			ctx,
		): Promise<any> {
			const loaded = await ensureStateReady(state, initPromise);
			if (!loaded) throw new Error("MCP is not initialized");
			state = loaded;
			await hydrateAllMetadata(loaded, { refresh: false });
			const snapshot = createCodeModeRuntime(loaded, signal, ctx);
			const result = await Effect.runPromise(snapshot.runtime.execute(params.code), { signal });
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: {
					result,
					calls: snapshot.metadata,
					mappings: snapshot.mappings,
					code: params.code,
				},
			};
		},
		renderCall(args, theme) {
			const lines = typeof args.code === "string" ? args.code.split("\n").length : 0;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("mcp_execute"))} ${theme.fg("muted", `${lines} lines`)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = (result.details ?? {}) as {
				result?: { ok?: boolean; toolCalls?: unknown[]; error?: { message?: string } };
				calls?: unknown[];
				code?: string;
			};
			if (expanded) return new Text(extractTextFromResult(result), 0, 0);
			if (details.result?.ok === false) {
				return new Text(theme.fg("error", `✗ ${details.result.error?.message ?? "Code Mode failed"}`), 0, 0);
			}
			return new Text(
				theme.fg("success", "✓ MCP Code Mode completed") +
					theme.fg("muted", ` (${details.calls?.length ?? 0} MCP calls)`),
				0,
				0,
			);
		},
	});


	pi.registerCommand("mcp", {
		description: "Manage MCP tools/auth (status, enable, disable, reconnect, auth)",
		handler: async (args, ctx) => {
			const loaded = await ensureStateReady(state, initPromise);
			if (!loaded) {
				notifyUser(ctx, "MCP is not initialized", "error");
				return;
			}
			state = loaded;

			const raw = args?.trim() ?? "";
			if (!raw && ctx.hasUI) {
				await openMcpMenu(loaded, ctx);
				return;
			}

			const parts = raw.split(/\s+/).filter(Boolean);
			const command = (parts[0] ?? "status").toLowerCase();
			const argument = parts[1];

			switch (command) {
				case "status":
				case "":
					await showMcpStatus(loaded, ctx);
					return;
				case "enable":
				case "on":
					await handleServerToolCommand(loaded, ctx, true, parts.slice(1));
					return;
				case "disable":
				case "off":
					await handleServerToolCommand(loaded, ctx, false, parts.slice(1));
					return;
				case "reconnect":
					await reconnectServers(loaded, ctx, argument);
					return;
				case "auth":
					await authenticateServer(loaded, ctx, argument);
					return;
				case "help":
				default:
					await showMcpStatus(loaded, ctx);
					return;
			}
		},
	});
}

async function ensureStateReady(
	state: McpExtensionState | null,
	initPromise: Promise<McpExtensionState> | null,
): Promise<McpExtensionState | null> {
	if (state) return state;
	if (!initPromise) return null;
	try {
		return await initPromise;
	} catch {
		return null;
	}
}

function createCodeModeRuntime(
	state: McpExtensionState,
	signal?: AbortSignal,
	ctx?: ExtensionContext,
) {
	const clientFor = (serverId: string): McpClient => ({
		callTool: async (wireToolName, input, options) => {
			await ensureServerMetadata(state, serverId, false);
			const connection = await ensureConnectedServer(state, serverId);
			state.manager.touch(serverId);
			state.manager.incrementInFlight(serverId);
			try {
				return (await connection.client.callTool(
					{ name: wireToolName, arguments: input },
					undefined,
					{ signal: options.signal, timeout: options.timeout },
				)) as unknown as McpCallResult;
			} finally {
				state.manager.decrementInFlight(serverId);
				state.manager.touch(serverId);
			}
		},
	});

	const refs: McpToolRef[] = getAllEntries(state)
		.filter((entry) => entry.kind === "tool" && isEntryEnabled(state, entry))
		.map((entry) => ({
			serverId: entry.server,
			wireToolName: entry.name,
			connectorDescription: state.config.mcpServers[entry.server]?.description,
			description: entry.description,
			inputSchema: asJsonSchema(entry.inputSchema),
			outputSchema: entry.outputSchema === undefined ? undefined : asJsonSchema(entry.outputSchema),
			client: clientFor(entry.server),
			timeout: 30_000,
			metadataFreshness: state.metadataFreshness.get(entry.server) ?? "live",
		}));

	const authorize = createMcpAuthorizer({
		isAllowed: (serverId, wireToolName) => {
			const entry = findToolEntry(state, serverId, wireToolName);
			return entry !== undefined && isEntryEnabled(state, entry);
		},
		requiresApproval: (serverId) => state.config.mcpServers[serverId]?.approval === "always",
		requestApproval: async (request) => {
			if (!ctx?.hasUI) return false;
			const input = truncate(JSON.stringify(request.input), 800);
			return ctx.ui.confirm(
				`Approve MCP call to ${request.serverId}/${request.wireToolName}?`,
				input || "{}",
				{ signal: request.signal },
			);
		},
	});

	const built = buildMcpCodeModeTools({ refs, authorize, signal });
	return {
		runtime: CodeMode.make({
			tools: built.tools,
			limits: { timeoutMs: 30_000, maxToolCalls: 100, maxOutputBytes: 50 * 1024 },
		}) as CodeMode.Runtime<never>,
		catalog: built.catalog,
		metadata: built.metadata,
		mappings: built.mappings,
	};
}

function asJsonSchema(value: unknown): JsonSchema {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonSchema;
	return { type: "object", additionalProperties: true };
}

async function openMcpMenu(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		await showMcpStatus(state, ctx);
		return;
	}

	while (true) {
		const options = [
			"Status",
			"Manage enabled MCP tools",
			"Enable all tools on a server",
			"Disable all tools on a server",
			"Reconnect all servers",
			"Reconnect one server",
			"Sign in / auth",
			"Close",
		];

		const choice = await ctx.ui.select("MCP menu", options);
		if (!choice || choice === "Close") {
			return;
		}

		switch (choice) {
			case "Status":
				await showMcpStatus(state, ctx);
				break;
			case "Manage enabled MCP tools":
				await manageServerToolsMenu(state, ctx);
				break;
			case "Enable all tools on a server": {
				const serverName = await promptServerSelection(
					ctx,
					Object.keys(state.config.mcpServers),
					"Enable all tools for server",
				);
				if (serverName) {
					clearServerPolicy(state, serverName);
					saveToolPolicies(state.toolPolicies);
					notifyUser(ctx, `Enabled all tools for ${serverName}`);
				}
				break;
			}
			case "Disable all tools on a server": {
				const serverName = await promptServerSelection(
					ctx,
					Object.keys(state.config.mcpServers),
					"Disable all tools for server",
				);
				if (serverName) {
					setServerAllowlist(state, serverName, []);
					saveToolPolicies(state.toolPolicies);
					notifyUser(ctx, `Disabled all tools for ${serverName}`);
				}
				break;
			}
			case "Reconnect all servers":
				await reconnectServers(state, ctx);
				break;
			case "Reconnect one server": {
				const serverName = await promptServerSelection(ctx, Object.keys(state.config.mcpServers), "Reconnect server");
				if (serverName) {
					await reconnectServers(state, ctx, serverName);
				}
				break;
			}
			case "Sign in / auth": {
				const authServers = Object.entries(state.config.mcpServers)
					.filter(([name, definition]) => inferAuthMode(name, definition) !== "none")
					.map(([name]) => name);
				if (authServers.length === 0) {
					notifyUser(ctx, "No auth-configured MCP servers found", "warning");
					break;
				}
				const serverName = await promptServerSelection(ctx, authServers, "Sign in server");
				if (serverName) {
					await authenticateServer(state, ctx, serverName);
				}
				break;
			}
			default:
				break;
		}
	}
}

async function promptServerSelection(
	ctx: ExtensionContext,
	servers: string[],
	title: string,
): Promise<string | undefined> {
	const sorted = [...servers].sort();
	if (sorted.length === 0) return undefined;
	const choice = await ctx.ui.select(title, [...sorted, "Cancel"]);
	if (!choice || choice === "Cancel") return undefined;
	return choice;
}

interface ServerStatusInfo {
	serverName: string;
	status: "connected" | "failed" | "cached" | "idle";
	statusLabel: string;
	enabledCount: number;
	totalCount: number;
	policySummary: string;
	authSummary: string;
}

function collectServerStatus(state: McpExtensionState): ServerStatusInfo[] {
	const serverNames = Object.keys(state.config.mcpServers).sort();
	const rows: ServerStatusInfo[] = [];
	for (const serverName of serverNames) {
		const connection = state.manager.getConnection(serverName);
		const failedAgo = getFailureAgeSeconds(state, serverName);
		const entries = state.toolIndex.get(serverName) ?? [];
		const enabledCount = entries.filter((entry) => isEntryEnabled(state, entry)).length;

		let status: ServerStatusInfo["status"] = "idle";
		let statusLabel = "idle";
		if (connection?.status === "connected") {
			status = "connected";
			statusLabel = "connected";
		} else if (failedAgo !== null) {
			status = "failed";
			statusLabel = `failed ${failedAgo}s ago`;
		} else if (state.toolIndex.has(serverName)) {
			status = "cached";
			statusLabel = "cached";
		}

		rows.push({
			serverName,
			status,
			statusLabel,
			enabledCount,
			totalCount: entries.length,
			policySummary: getServerPolicySummary(state, serverName),
			authSummary: getServerAuthSummary(state.config.mcpServers[serverName], serverName),
		});
	}
	return rows;
}

function statusIcon(status: ServerStatusInfo["status"]): string {
	switch (status) {
		case "connected":
			return "✓";
		case "failed":
			return "✗";
		case "cached":
			return "◔";
		default:
			return "○";
	}
}

async function showMcpStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	const rows = collectServerStatus(state);

	if (ctx.hasUI) {
		const options = rows.map((row) => {
			const policy = row.policySummary ? ` · ${row.policySummary}` : "";
			const auth = row.authSummary ? ` · ${row.authSummary}` : "";
			return `${statusIcon(row.status)} ${row.serverName} — ${row.statusLabel} · ${row.enabledCount}/${row.totalCount} enabled${policy}${auth}`;
		});
		await ctx.ui.select(
			`MCP status (${rows.length} server${rows.length === 1 ? "" : "s"})`,
			options.length > 0 ? [...options, "Back"] : ["(none configured)", "Back"],
		);
		return;
	}

	const lines: string[] = ["MCP status", "", `Servers (${rows.length}):`];
	if (rows.length === 0) {
		lines.push("(none configured)");
	} else {
		for (const row of rows) {
			const policy = row.policySummary ? `, ${row.policySummary}` : "";
			const auth = row.authSummary ? `, ${row.authSummary}` : "";
			lines.push(
				`- ${row.serverName}: ${row.statusLabel}, ${row.enabledCount}/${row.totalCount} enabled${policy}${auth}`,
			);
		}
	}

	notifyUser(ctx, lines.join("\n"));
}

function inferAuthMode(serverName: string, definition: ServerEntry): "oauth" | "bearer" | "none" {
	if (definition.auth === "oauth") return "oauth";
	if (definition.auth === "bearer") return "bearer";
	if (definition.bearerToken || definition.bearerTokenEnv) return "bearer";
	if (!definition.url) return "none";
	if (getStoredTokens(serverName)) return "oauth";
	return "oauth";
}

function getServerAuthSummary(definition: ServerEntry, serverName: string): string {
	if (definition.auth === "bearer" || definition.bearerToken || definition.bearerTokenEnv) {
		if (definition.bearerTokenEnv) {
			return process.env[definition.bearerTokenEnv]
				? `bearer via $${definition.bearerTokenEnv}`
				: `bearer missing $${definition.bearerTokenEnv}`;
		}
		if (definition.bearerToken) {
			return "bearer token configured";
		}
		return "bearer token missing";
	}

	const oauthTokens = getStoredTokens(serverName);
	if (oauthTokens && (definition.auth === "oauth" || definition.url)) {
		return "oauth token present";
	}
	if (definition.auth === "oauth") {
		return "oauth token missing";
	}
	if (definition.url) {
		return "oauth on demand";
	}
	return "no auth";
}

function discoverBearerToken(definition: ServerEntry): { token: string; source: string } | null {
	if (definition.bearerTokenEnv) {
		const value = process.env[definition.bearerTokenEnv]?.trim();
		if (value) return { token: value, source: `$${definition.bearerTokenEnv}` };
	}
	if (definition.bearerToken?.trim()) {
		return { token: definition.bearerToken.trim(), source: "config bearerToken" };
	}
	return null;
}

function isDynamicClientRegistrationUnsupported(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /does not support dynamic client registration/i.test(message);
}

function discoverGithubCliToken(definition: ServerEntry): { token: string; source: string } | null {
	const url = definition.url ?? "";
	if (!/githubcopilot\.com/i.test(url)) {
		return null;
	}
	const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
	if (gh.status !== 0) {
		return null;
	}
	const token = gh.stdout.trim();
	if (!token) {
		return null;
	}
	return { token, source: "gh auth token" };
}

async function handleServerToolCommand(
	state: McpExtensionState,
	ctx: ExtensionContext,
	enable: boolean,
	args: string[],
): Promise<void> {
	const serverName = args[0];
	const toolName = args[1];
	if (!serverName || !toolName) {
		notifyUser(
			ctx,
			`Usage: /mcp ${enable ? "enable" : "disable"} <server> <tool|all>`,
			"error",
		);
		return;
	}

	if (!state.config.mcpServers[serverName]) {
		notifyUser(ctx, `Unknown MCP server: ${serverName}`, "error");
		return;
	}

	await ensureServerMetadata(state, serverName, false);

	if (toolName === "all") {
		if (enable) {
			clearServerPolicy(state, serverName);
			notifyUser(ctx, `Enabled all tools for ${serverName}`);
		} else {
			setServerAllowlist(state, serverName, []);
			notifyUser(ctx, `Disabled all tools for ${serverName}`);
		}
		saveToolPolicies(state.toolPolicies);
		return;
	}

	const exists = hasToolNamed(state, serverName, toolName);
	if (!exists) {
		notifyUser(ctx, `Tool not found on ${serverName}: ${toolName}`, "error");
		return;
	}

	if (enable) {
		enableToolForServer(state, serverName, toolName);
		notifyUser(ctx, `Enabled ${serverName}/${toolName}`);
	} else {
		disableToolForServer(state, serverName, toolName);
		notifyUser(ctx, `Disabled ${serverName}/${toolName}`);
	}
	saveToolPolicies(state.toolPolicies);
}

function hasToolNamed(state: McpExtensionState, serverName: string, toolName: string): boolean {
	return findToolEntry(state, serverName, toolName) !== undefined;
}

function findToolEntry(
	state: McpExtensionState,
	serverName: string,
	toolName: string,
): ToolIndexEntry | undefined {
	const entries = state.toolIndex.get(serverName) ?? [];
	return entries.find((entry) => entry.kind === "tool" && entry.name === toolName);
}

function suggestToolNames(
	state: McpExtensionState,
	serverName: string,
	queryToolName: string,
	limit = 3,
): string[] {
	const entries = (state.toolIndex.get(serverName) ?? []).filter((entry) => entry.kind === "tool");
	const scores = entries
		.map((entry) => ({ name: entry.name, score: scoreToolNameMatch(queryToolName, entry.name) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((item) => item.name);
	return [...new Set(scores)];
}

function scoreToolNameMatch(query: string, candidate: string): number {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (q === c) return 1000;
	if (c.includes(q)) return 500 + q.length;
	if (q.includes(c)) return 400 + c.length;

	const qNorm = q.replace(/[_-]+/g, "");
	const cNorm = c.replace(/[_-]+/g, "");
	if (qNorm === cNorm) return 350;
	if (cNorm.includes(qNorm)) return 280;

	let qi = 0;
	let score = 0;
	for (let i = 0; i < c.length && qi < q.length; i++) {
		if (c[i] === q[qi]) {
			score += 5;
			qi += 1;
		}
	}
	if (qi === q.length) return score;
	return 0;
}

function findResourceEntryByUri(
	state: McpExtensionState,
	serverName: string,
	uri: string,
): ToolIndexEntry | undefined {
	const entries = state.toolIndex.get(serverName) ?? [];
	return entries.find((entry) => entry.kind === "resource" && entry.resourceUri === uri);
}

async function manageServerToolsMenu(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	const servers = Object.keys(state.config.mcpServers).sort();
	if (servers.length === 0) {
		notifyUser(ctx, "No MCP servers configured", "warning");
		return;
	}

	while (true) {
		const serverLabels = servers.map((serverName) => {
			const entries = state.toolIndex.get(serverName) ?? [];
			const enabled = entries.filter((entry) => isEntryEnabled(state, entry)).length;
			return `${serverName} (${enabled}/${entries.length})`;
		});
		const choice = await ctx.ui.select("Manage MCP tools - select server", [...serverLabels, "Back"]);
		if (!choice || choice === "Back") return;

		const selectedServer = choice.split(" (")[0];
		await ensureServerMetadata(state, selectedServer, false);
		await manageSingleServerToolsMenu(state, ctx, selectedServer);
	}
}

async function manageSingleServerToolsMenu(
	state: McpExtensionState,
	ctx: ExtensionContext,
	serverName: string,
): Promise<void> {
	while (true) {
		const entries = (state.toolIndex.get(serverName) ?? [])
			.filter((entry) => entry.kind === "tool")
			.sort((a, b) => a.name.localeCompare(b.name));
		const enabled = entries.filter((entry) => isEntryEnabled(state, entry)).length;

		const choice = await ctx.ui.select(`MCP tools: ${serverName} (${enabled}/${entries.length})`, [
			"Toggle tool",
			"Enable all tools",
			"Disable all tools",
			"Back",
		]);

		if (!choice || choice === "Back") return;
		if (choice === "Enable all tools") {
			clearServerPolicy(state, serverName);
			saveToolPolicies(state.toolPolicies);
			notifyUser(ctx, `Enabled all tools for ${serverName}`);
			continue;
		}
		if (choice === "Disable all tools") {
			setServerAllowlist(state, serverName, []);
			saveToolPolicies(state.toolPolicies);
			notifyUser(ctx, `Disabled all tools for ${serverName}`);
			continue;
		}

		const query = await ctx.ui.input("Filter tools (optional)");
		const matcher = buildQueryMatcher(query ?? undefined);
		const matches = entries.filter((entry) => matcher(formatSearchText(entry)));

		if (matches.length === 0) {
			notifyUser(ctx, "No matching tools", "warning");
			continue;
		}

		const MAX_ITEMS = 200;
		if (matches.length > MAX_ITEMS) {
			notifyUser(ctx, `Too many matches (${matches.length}). Please narrow the filter.`, "warning");
			continue;
		}

		const toolOptions = matches.map((entry) => `${isEntryEnabled(state, entry) ? "✓" : "○"} ${entry.name}`);
		const selected = await ctx.ui.select(`Toggle tool on ${serverName}`, [...toolOptions, "Cancel"]);
		if (!selected || selected === "Cancel") continue;

		const toolName = selected.slice(2).trim();
		if (!toolName) continue;
		if (isToolEnabled(state, serverName, toolName)) {
			disableToolForServer(state, serverName, toolName);
			notifyUser(ctx, `Disabled ${serverName}/${toolName}`);
		} else {
			enableToolForServer(state, serverName, toolName);
			notifyUser(ctx, `Enabled ${serverName}/${toolName}`);
		}
		saveToolPolicies(state.toolPolicies);
	}
}

function getServerPolicySummary(state: McpExtensionState, serverName: string): string {
	const policy = state.toolPolicies.get(serverName);
	if (!policy) return "";
	if (policy.mode === "allowlist") {
		return `allowlist:${policy.tools.size}`;
	}
	return `denylist:${policy.tools.size}`;
}

function isEntryEnabled(state: McpExtensionState, entry: ToolIndexEntry): boolean {
	return isToolEnabled(state, entry.server, entry.name);
}

function isToolEnabled(state: McpExtensionState, serverName: string, toolName: string): boolean {
	const policy = state.toolPolicies.get(serverName);
	if (!policy) return true;
	if (policy.mode === "denylist") {
		return !policy.tools.has(toolName);
	}
	return policy.tools.has(toolName);
}

function disableToolForServer(state: McpExtensionState, serverName: string, toolName: string): void {
	const policy = state.toolPolicies.get(serverName);
	if (!policy) {
		state.toolPolicies.set(serverName, { mode: "denylist", tools: new Set([toolName]) });
		return;
	}
	if (policy.mode === "denylist") {
		policy.tools.add(toolName);
		return;
	}
	policy.tools.delete(toolName);
}

function enableToolForServer(state: McpExtensionState, serverName: string, toolName: string): void {
	const policy = state.toolPolicies.get(serverName);
	if (!policy) return;
	if (policy.mode === "denylist") {
		policy.tools.delete(toolName);
		if (policy.tools.size === 0) {
			state.toolPolicies.delete(serverName);
		}
		return;
	}
	policy.tools.add(toolName);
}

function clearServerPolicy(state: McpExtensionState, serverName: string): void {
	state.toolPolicies.delete(serverName);
}

function setServerAllowlist(state: McpExtensionState, serverName: string, allowedTools: string[]): void {
	state.toolPolicies.set(serverName, {
		mode: "allowlist",
		tools: new Set(allowedTools),
	});
}

function loadToolPolicies(): Map<string, ServerToolPolicy> {
	const output = new Map<string, ServerToolPolicy>();
	if (!existsSync(TOOL_POLICY_PATH)) return output;

	try {
		const parsed = JSON.parse(readFileSync(TOOL_POLICY_PATH, "utf-8")) as {
			version?: number;
			servers?: Record<string, { mode?: string; tools?: unknown }>;
		};
		const servers = parsed?.servers ?? {};
		for (const [serverName, rawPolicy] of Object.entries(servers)) {
			if (!rawPolicy || typeof rawPolicy !== "object") continue;
			const mode = rawPolicy.mode === "allowlist" ? "allowlist" : rawPolicy.mode === "denylist" ? "denylist" : null;
			if (!mode) continue;
			const tools = Array.isArray(rawPolicy.tools)
				? rawPolicy.tools.filter((tool): tool is string => typeof tool === "string")
				: [];
			output.set(serverName, { mode, tools: new Set(tools) });
		}
	} catch (error) {
		debugWarn(`MCP: failed to load tool policy file ${TOOL_POLICY_PATH}:`, error);
	}

	return output;
}

function saveToolPolicies(policies: Map<string, ServerToolPolicy>): void {
	const servers: Record<string, { mode: "allowlist" | "denylist"; tools: string[] }> = {};
	for (const [serverName, policy] of policies.entries()) {
		servers[serverName] = {
			mode: policy.mode,
			tools: [...policy.tools].sort(),
		};
	}

	mkdirSync(dirname(TOOL_POLICY_PATH), { recursive: true });
	writeFileSync(
		TOOL_POLICY_PATH,
		`${JSON.stringify({ version: 1, servers }, null, 2)}\n`,
		"utf-8",
	);
}

async function reconnectServers(
	state: McpExtensionState,
	ctx: ExtensionContext,
	serverName?: string,
): Promise<void> {
	const serverNames = Object.keys(state.config.mcpServers);
	if (serverNames.length === 0) {
		notifyUser(ctx, "No MCP servers configured", "warning");
		return;
	}

	if (serverName && !state.config.mcpServers[serverName]) {
		notifyUser(ctx, `Unknown MCP server: ${serverName}`, "error");
		return;
	}

	const targets = serverName ? [serverName] : serverNames;
	const connected: string[] = [];
	const failed: string[] = [];

	await parallelLimit(targets, 4, async (name) => {
		const refreshed = await ensureServerMetadata(state, name, true);
		const isConnected = state.manager.getConnection(name)?.status === "connected";
		if (refreshed && isConnected) connected.push(name);
		else failed.push(name);
	});

	if (connected.length > 0 && failed.length === 0) {
		notifyUser(ctx, `MCP reconnect succeeded: ${connected.join(", ")}`);
		return;
	}
	if (connected.length > 0) {
		notifyUser(
			ctx,
			`MCP reconnect partial success. Connected: ${connected.join(", ")}. Failed: ${failed.join(", ")}`,
			"warning",
		);
		return;
	}
	notifyUser(ctx, `MCP reconnect failed: ${failed.join(", ")}`, "error");
}

function resolveTemplateValue(value: string): string {
	return value
		.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "")
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => process.env[key] ?? "");
}

function buildAuthRequestInit(definition: ServerEntry): RequestInit | undefined {
	if (!definition.headers) return undefined;
	const headers = new Headers();
	for (const [key, value] of Object.entries(definition.headers)) {
		headers.set(key, resolveTemplateValue(value));
	}
	return { headers };
}

function createFetchWithRequestInit(baseInit?: RequestInit): typeof fetch {
	if (!baseInit) return fetch;
	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers = new Headers(baseInit.headers ?? {});
		const initHeaders = new Headers(init?.headers ?? {});
		for (const [key, value] of initHeaders.entries()) {
			headers.set(key, value);
		}
		return fetch(input, {
			...baseInit,
			...init,
			headers,
		});
	};
}

function openBrowserUrl(url: string): boolean {
	const platform = process.platform;
	try {
		let command = "";
		let args: string[] = [];
		if (platform === "darwin") {
			command = "open";
			args = [url];
		} else if (platform === "win32") {
			command = "cmd";
			args = ["/c", "start", "", url];
		} else {
			command = "xdg-open";
			args = [url];
		}
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

async function startOAuthCallbackServer(serverName: string): Promise<OAuthCallbackServerHandle> {
	let closed = false;
	let server: HttpServer | undefined;
	let resolveCode: ((code: string) => void) | undefined;
	let rejectCode: ((error: Error) => void) | undefined;

	const codePromise = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = (error: Error) => reject(error);
	});

	server = createServer((req, res) => {
		const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname !== "/callback") {
			res.statusCode = 404;
			res.end("Not found");
			return;
		}

		const code = requestUrl.searchParams.get("code");
		const error = requestUrl.searchParams.get("error");
		const errorDescription = requestUrl.searchParams.get("error_description");

		if (code) {
			res.statusCode = 200;
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(
				"<html><body><h1>Authorization complete</h1><p>You can close this tab and return to pi.</p></body></html>",
			);
			resolveCode?.(code);
			return;
		}

		const message = error
			? `OAuth authorization failed for ${serverName}: ${errorDescription ? `${error} (${errorDescription})` : error}`
			: `OAuth callback for ${serverName} missing authorization code`;
		res.statusCode = 400;
		res.setHeader("content-type", "text/plain; charset=utf-8");
		res.end(message);
		rejectCode?.(new Error(message));
	});

	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		throw new Error("Failed to allocate localhost callback port for OAuth flow");
	}

	const redirectUrl = `http://127.0.0.1:${address.port}/callback`;

	return {
		redirectUrl,
		waitForCode: async (timeoutMs: number) => {
			return await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
							`Timed out waiting for OAuth callback for ${serverName} after ${Math.round(timeoutMs / 1000)}s`,
						),
					);
				}, timeoutMs);
				codePromise.then(
					(code) => {
						clearTimeout(timer);
						resolve(code);
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			});
		},
		close: async () => {
			if (closed) return;
			closed = true;
			await new Promise<void>((resolve) => {
				server?.close(() => resolve());
			});
		},
	};
}

async function performStandardOAuthLogin(
	ctx: ExtensionContext,
	serverName: string,
	definition: ServerEntry,
): Promise<void> {
	if (!definition.url) {
		throw new Error(`Server ${serverName} is not URL-based and cannot use OAuth login`);
	}

	const callback = await startOAuthCallbackServer(serverName);
	const requestInit = buildAuthRequestInit(definition);
	const fetchFn = createFetchWithRequestInit(requestInit);
	const serverUrl = new URL(definition.url);

	try {
		let openedBrowser = false;
		const provider = new ExtensionOAuthClientProvider(
			serverName,
			definition,
			callback.redirectUrl,
			(authorizationUrl) => {
				const urlText = authorizationUrl.toString();
				const opened = openBrowserUrl(urlText);
				openedBrowser = openedBrowser || opened;
				if (opened) {
					notifyUser(ctx, `Opening browser for ${serverName} sign-in…`);
				} else {
					notifyUser(
						ctx,
						`Open this URL to authorize ${serverName}: ${urlText}`,
						"warning",
					);
				}
			},
		);

		const initial = await auth(provider, {
			serverUrl,
			fetchFn,
		});
		if (initial === "AUTHORIZED") {
			notifyUser(ctx, `OAuth already valid for ${serverName}`);
			return;
		}

		notifyUser(
			ctx,
			openedBrowser
				? `Complete the ${serverName} sign-in in your browser…`
				: `Waiting for ${serverName} OAuth callback…`,
		);
		const code = await callback.waitForCode(180_000);
		const completed = await auth(provider, {
			serverUrl,
			authorizationCode: code,
			fetchFn,
		});
		if (completed !== "AUTHORIZED") {
			throw new Error(`OAuth flow did not complete for ${serverName}`);
		}

		notifyUser(ctx, `OAuth login successful for ${serverName} (${getTokensPath(serverName)})`);
	} finally {
		await callback.close().catch(() => undefined);
	}
}

async function authenticateServer(
	state: McpExtensionState,
	ctx: ExtensionContext,
	serverNameArg?: string,
): Promise<void> {
	let serverName = serverNameArg;
	if (!serverName) {
		const authServers = Object.entries(state.config.mcpServers)
			.filter(([name, definition]) => inferAuthMode(name, definition) !== "none")
			.map(([name]) => name)
			.sort();
		if (authServers.length === 1) {
			serverName = authServers[0];
		} else if (ctx.hasUI && authServers.length > 1) {
			const selected = await ctx.ui.select("Select MCP server for auth", authServers);
			serverName = selected;
		}
	}

	if (!serverName) {
		notifyUser(ctx, "Usage: /mcp auth <server>", "error");
		return;
	}

	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		notifyUser(ctx, `Unknown MCP server: ${serverName}`, "error");
		return;
	}

	const authMode = inferAuthMode(serverName, definition);

	if (authMode === "oauth") {
		if (!ctx.hasUI) {
			notifyUser(
				ctx,
				`OAuth sign-in for ${serverName} requires interactive UI/browser. Re-run in UI mode or pre-populate ${getTokensPath(serverName)}.`,
				"warning",
			);
			return;
		}

		const existing = getStoredTokens(serverName);
		if (existing) {
			const reuse = await ctx.ui.confirm(
				"MCP OAuth",
				`A stored OAuth token exists for ${serverName}. Try reconnecting with it first?`,
			);
			if (reuse) {
				await reconnectServers(state, ctx, serverName);
				return;
			}
		}

		try {
			await performStandardOAuthLogin(ctx, serverName, definition);
			await reconnectServers(state, ctx, serverName);
			return;
		} catch (error) {
			if (isDynamicClientRegistrationUnsupported(error)) {
				const githubCliToken = discoverGithubCliToken(definition);
				if (githubCliToken) {
					definition.auth = "bearer";
					definition.bearerToken = githubCliToken.token;
					notifyUser(
						ctx,
						`OAuth server for ${serverName} does not support dynamic client registration; using ${githubCliToken.source} as bearer token for this session.`,
						"warning",
					);
					await reconnectServers(state, ctx, serverName);
					return;
				}

				if (ctx.hasUI) {
					const token = await ctx.ui.input(
						`OAuth server for ${serverName} requires a pre-registered client. Paste bearer token fallback for this session`,
					);
					if (token?.trim()) {
						definition.auth = "bearer";
						definition.bearerToken = token.trim();
						notifyUser(ctx, `Stored bearer token fallback for ${serverName} (session only)`);
						await reconnectServers(state, ctx, serverName);
						return;
					}
				}
			}

			const message = error instanceof Error ? error.message : String(error);
			notifyUser(ctx, `OAuth login failed for ${serverName}: ${message}`, "error");
			return;
		}
	}

	if (authMode === "bearer") {
		const autoToken = discoverBearerToken(definition);
		if (autoToken) {
			if (definition.bearerTokenEnv) {
				process.env[definition.bearerTokenEnv] = autoToken.token;
				notifyUser(
					ctx,
					`Authenticated ${serverName} automatically using ${autoToken.source} → $${definition.bearerTokenEnv}`,
				);
			} else {
				definition.bearerToken = autoToken.token;
				notifyUser(ctx, `Authenticated ${serverName} automatically using ${autoToken.source}`);
			}
			await reconnectServers(state, ctx, serverName);
			return;
		}

		if (definition.bearerTokenEnv) {
			if (ctx.hasUI) {
				const token = await ctx.ui.input(
					`Bearer token for ${serverName} (stored for this pi session in $${definition.bearerTokenEnv})`,
				);
				if (token?.trim()) {
					process.env[definition.bearerTokenEnv] = token.trim();
					notifyUser(ctx, `Stored token in $${definition.bearerTokenEnv} for current pi process`);
					await reconnectServers(state, ctx, serverName);
					return;
				}
			}
			notifyUser(
				ctx,
				`Set environment variable $${definition.bearerTokenEnv} then run /mcp reconnect ${serverName}`,
				"warning",
			);
			return;
		}

		if (definition.bearerToken) {
			notifyUser(ctx, `Bearer token is already configured for ${serverName}; reconnecting.`);
			await reconnectServers(state, ctx, serverName);
			return;
		}

		if (ctx.hasUI) {
			const token = await ctx.ui.input(`Bearer token for ${serverName}`);
			if (token?.trim()) {
				definition.bearerToken = token.trim();
				notifyUser(ctx, `Stored bearer token in memory for ${serverName} (not persisted)`);
				await reconnectServers(state, ctx, serverName);
				return;
			}
		}

		notifyUser(ctx, `No bearer token configured for ${serverName}`, "warning");
		return;
	}

	notifyUser(ctx, `Server ${serverName} does not require auth. Reconnecting.`);
	await reconnectServers(state, ctx, serverName);
}

function notifyUser(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") console.error(message);
	else console.log(message);
}

async function initializeMcp(pi: ExtensionAPI, ctx: ExtensionContext): Promise<McpExtensionState> {
	const configPath = (pi.getFlag("mcp-config") as string | undefined) ?? getConfigPathFromArgv();
	const config = loadMcpConfig(configPath);

	const manager = new McpServerManager();
	const lifecycle = new McpLifecycleManager(manager);
	const toolIndex = new Map<string, ToolIndexEntry[]>();
	const failureTracker = new Map<string, number>();
	const toolPolicies = loadToolPolicies();
	const metadataFreshness = new Map<string, MetadataFreshness>();
	const state: McpExtensionState = {
		manager,
		lifecycle,
		config,
		toolIndex,
		failureTracker,
		toolPolicies,
		metadataFreshness,
		ui: ctx.hasUI ? ctx.ui : undefined,
	};

	const serverEntries = Object.entries(config.mcpServers);
	if (serverEntries.length === 0) {
		return state;
	}

	const idleTimeoutMinutes = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
	lifecycle.setGlobalIdleTimeout(idleTimeoutMinutes);

	const cache = loadMetadataCache();
	for (const [serverName, definition] of serverEntries) {
		lifecycle.registerServer(serverName, definition, {
			idleTimeout: definition.idleTimeout,
		});
		if ((definition.lifecycle ?? "lazy") === "keep-alive") {
			lifecycle.markKeepAlive(serverName, definition);
		}

		const cachedServer = cache?.servers?.[serverName];
		if (cachedServer && isServerCacheValid(cachedServer, definition)) {
			toolIndex.set(serverName, reconstructToolIndex(serverName, cachedServer, definition.exposeResources));
			metadataFreshness.set(serverName, "cached");
		}
	}

	const startupServers = serverEntries.filter(([, definition]) => {
		const mode = definition.lifecycle ?? "lazy";
		return mode === "eager" || mode === "keep-alive";
	});

	await parallelLimit(startupServers, 8, async ([serverName, definition]) => {
		await ensureServerMetadata(state, serverName, true, definition);
	});

	lifecycle.setReconnectCallback((serverName) => {
		void ensureServerMetadata(state, serverName, true);
	});

	lifecycle.setIdleShutdownCallback(() => {
		updateStatusBar(state);
	});

	lifecycle.startHealthChecks();
	updateStatusBar(state);

	return state;
}

async function hydrateAllMetadata(
	state: McpExtensionState,
	options: { refresh: boolean },
): Promise<string[]> {
	const unavailable: string[] = [];
	const serverNames = Object.keys(state.config.mcpServers);

	await parallelLimit(serverNames, 6, async (serverName) => {
		const ok = await ensureServerMetadata(state, serverName, options.refresh);
		if (!ok && !state.toolIndex.has(serverName)) {
			unavailable.push(serverName);
		}
	});

	return unavailable;
}

async function ensureServerMetadata(
	state: McpExtensionState,
	serverName: string,
	forceRefresh: boolean,
	definitionOverride?: ServerEntry,
): Promise<boolean> {
	const definition = definitionOverride ?? state.config.mcpServers[serverName];
	if (!definition) return false;

	if (!forceRefresh && state.toolIndex.has(serverName)) {
		return true;
	}

	if (!forceRefresh) {
		const failedAgo = getFailureAgeSeconds(state, serverName);
		if (failedAgo !== null) {
			return state.toolIndex.has(serverName);
		}
	}

	try {
		if (forceRefresh) {
			await state.manager.close(serverName).catch(() => {});
		}
		const connection = await state.manager.connect(serverName, definition);
		state.failureTracker.delete(serverName);
		const metadata = buildToolIndex(serverName, connection.tools, connection.resources, definition);
		state.toolIndex.set(serverName, metadata);
		state.metadataFreshness.set(serverName, "live");
		updateMetadataCache(state, serverName);
		updateStatusBar(state);
		return true;
	} catch (error) {
		state.failureTracker.set(serverName, Date.now());
		if (state.ui && forceRefresh) {
			const message = error instanceof Error ? error.message : String(error);
			const needsAuthHint =
				!getStoredTokens(serverName) && /missing required Authorization header|\b401\b/i.test(message);
			const hint = needsAuthHint ? ` Run /mcp auth ${serverName}.` : "";
			state.ui.notify(`MCP: failed to refresh ${serverName}: ${message}${hint}`, "warning");
		}
		updateStatusBar(state);
		return state.toolIndex.has(serverName);
	}
}

function buildToolIndex(
	serverName: string,
	tools: McpTool[],
	resources: McpResource[],
	definition: ServerEntry,
): ToolIndexEntry[] {
	const output: ToolIndexEntry[] = [];

	for (const tool of tools) {
		if (!tool?.name) continue;
		output.push({
			kind: "tool",
			server: serverName,
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
		});
	}

	if (definition.exposeResources !== false) {
		for (const resource of resources) {
			if (!resource?.uri || !resource?.name) continue;
			output.push({
				kind: "resource",
				server: serverName,
				name: resource.name,
				description: resource.description ?? `Resource ${resource.uri}`,
				resourceUri: resource.uri,
			});
		}
	}

	return output;
}

function getAllEntries(state: McpExtensionState): ToolIndexEntry[] {
	const output: ToolIndexEntry[] = [];
	for (const entries of state.toolIndex.values()) {
		output.push(...entries);
	}
	return output;
}

function formatSearchText(entry: ToolIndexEntry): string {
	return [
		entry.server,
		entry.name,
		entry.description,
		entry.kind,
		entry.resourceUri ?? "",
	]
		.join(" ")
		.toLowerCase();
}

function buildQueryMatcher(query: string | undefined): (haystack: string) => boolean {
	const raw = query?.trim();
	if (!raw) {
		return () => true;
	}

	const regex = parseRegex(raw);
	if (regex) {
		return (haystack) => regex.test(haystack);
	}

	const terms = raw
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
	if (terms.length === 0) {
		return () => true;
	}

	return (haystack) => terms.every((term) => haystack.includes(term));
}

function parseRegex(query: string): RegExp | null {
	const slashDelimited = query.match(/^\/(.*)\/([dgimsuvy]*)$/);
	if (slashDelimited) {
		try {
			const flags = slashDelimited[2].includes("i") ? slashDelimited[2] : `${slashDelimited[2]}i`;
			return new RegExp(slashDelimited[1], flags);
		} catch {
			return null;
		}
	}

	if (query.startsWith("re:")) {
		const body = query.slice(3);
		if (!body) return null;
		try {
			return new RegExp(body, "i");
		} catch {
			return null;
		}
	}

	return null;
}

function getSchemaParameters(schema: unknown): { required: string[]; optional: string[] } {
	if (!schema || typeof schema !== "object") {
		return { required: [], optional: [] };
	}
	const s = schema as Record<string, unknown>;
	if (s.type !== "object") {
		return { required: [], optional: [] };
	}
	if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
		return { required: [], optional: [] };
	}

	const propertyNames = Object.keys(s.properties as Record<string, unknown>);
	const requiredSet = new Set(
		Array.isArray(s.required)
			? s.required.filter((item): item is string => typeof item === "string")
			: [],
	);

	const required: string[] = [];
	const optional: string[] = [];
	for (const name of propertyNames) {
		if (requiredSet.has(name)) required.push(name);
		else optional.push(name);
	}
	return { required, optional };
}

function formatSchemaSignature(schema: unknown): string {
	const { required, optional } = getSchemaParameters(schema);
	if (required.length === 0 && optional.length === 0) {
		return "()";
	}

	const requiredPart = required.map((name) => `${name}*`);
	const optionalPart = optional.map((name) => `[${name}]`);
	const combined = [...requiredPart, ...optionalPart].join(", ");
	return `(${truncate(combined, 100)})`;
}

function formatSchemaHint(schema: unknown): string {
	const { required, optional } = getSchemaParameters(schema);
	if (required.length === 0 && optional.length === 0) {
		return "No parameters.";
	}
	let text = "Expected parameters:";
	if (required.length > 0) {
		text += ` required: ${required.join(", ")}`;
	}
	if (optional.length > 0) {
		text += `${required.length > 0 ? ";" : ""} optional: ${optional.join(", ")}`;
	}
	return text;
}

function formatInlineEntry(entry: ToolIndexEntry): string {
	if (entry.kind === "resource") {
		const uri = entry.resourceUri ?? "(missing-uri)";
		const desc = truncate(entry.description, 90);
		return `[resource] ${entry.server}/${entry.name} -> ${uri}${desc ? ` :: ${desc}` : ""}`;
	}
	const signature = formatSchemaSignature(entry.inputSchema);
	const desc = truncate(entry.description, 78);
	return `${entry.server}/${entry.name}${signature}${desc ? ` :: ${desc}` : ""}`;
}

function truncate(value: string, maxChars: number): string {
	if (!value) return "";
	if (value.length <= maxChars) return value;
	const head = value.slice(0, maxChars);
	const lastSpace = head.lastIndexOf(" ");
	if (lastSpace > maxChars * 0.6) {
		return `${head.slice(0, lastSpace)}...`;
	}
	return `${head}...`;
}

function previewCodeLines(
	code: unknown,
	maxLines: number,
	maxCharsPerLine: number,
): { lines: string[]; remaining: number } {
	if (typeof code !== "string") {
		return { lines: [], remaining: 0 };
	}
	const normalized = code.replace(/\t/g, "  ");
	const lines = normalized.split("\n");
	const shown = lines.slice(0, maxLines).map((line) => truncate(line, maxCharsPerLine));
	return {
		lines: shown,
		remaining: Math.max(0, lines.length - shown.length),
	};
}

function summarizeValue(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "";
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		if (keys.length === 0) return "{}";
		const head = keys.slice(0, 4).join(", ");
		const suffix = keys.length > 4 ? `, +${keys.length - 4}` : "";
		return `{${head}${suffix}}`;
	}
	if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 80);
	return String(value);
}

function firstLine(text: string): string {
	const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0);
	return line ?? "";
}

function extractTextFromResult(result: { content?: Array<{ type: string; text?: string }> }): string {
	for (const block of result.content ?? []) {
		if (block.type === "text") {
			return block.text ?? "";
		}
	}
	return "";
}

function normalizeToolArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return {};
	}
	return { ...args };
}

function extractMcpErrorText(content: McpContent[]): string {
	const textParts: string[] = [];
	for (const item of content) {
		if (item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0) {
			textParts.push(item.text.trim());
		}
	}
	if (textParts.length === 0) {
		return "MCP tool execution failed";
	}
	return textParts.join("\n\n");
}

function maybeConvertArgsForRetry(
	args: Record<string, unknown>,
	errorText: string,
): Record<string, unknown> | null {
	if (!/input validation error|required|invalid arguments/i.test(errorText)) {
		return null;
	}

	const converted = convertSnakeKeysToCamel(args);
	if (!converted.changed) {
		return null;
	}

	const requiredPaths = extractRequiredPathHints(errorText);
	if (requiredPaths.length === 0) {
		return converted.args;
	}

	const hasAnyRequired = requiredPaths.some((path) => Object.hasOwn(converted.args, path));
	if (hasAnyRequired) {
		return converted.args;
	}
	return null;
}

function convertSnakeKeysToCamel(args: Record<string, unknown>): { args: Record<string, unknown>; changed: boolean } {
	const output: Record<string, unknown> = { ...args };
	let changed = false;

	for (const [key, value] of Object.entries(args)) {
		if (!key.includes("_")) continue;
		const camel = key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
		if (!camel || camel === key) continue;
		if (Object.hasOwn(output, camel)) continue;
		output[camel] = value;
		delete output[key];
		changed = true;
	}

	return { args: output, changed };
}

function extractRequiredPathHints(errorText: string): string[] {
	const paths = new Set<string>();
	const pathRegex = /"path"\s*:\s*\[\s*"([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = pathRegex.exec(errorText)) !== null) {
		if (match[1]) paths.add(match[1]);
	}
	const requiredRegex = /required[^a-zA-Z0-9]+([a-zA-Z][a-zA-Z0-9_]*)/gi;
	while ((match = requiredRegex.exec(errorText)) !== null) {
		if (match[1]) paths.add(match[1]);
	}
	return [...paths];
}

function buildToolCallErrorMessage(
	entry: ToolIndexEntry,
	errorText: string,
	args: Record<string, unknown>,
): string {
	const lines: string[] = [];
	lines.push(`MCP tool call failed: ${entry.server}/${entry.name}`);
	lines.push(errorText.trim() || "Unknown MCP error");
	lines.push(formatSchemaHint(entry.inputSchema));

	const example = buildToolCallExample(entry);
	if (example) {
		lines.push(`Example: ${example}`);
	}

	if (Object.keys(args).some((key) => key.includes("_"))) {
		lines.push("Hint: use camelCase parameter names unless the schema says otherwise.");
	}

	const requiredPaths = extractRequiredPathHints(errorText);
	if (requiredPaths.length > 0) {
		lines.push(`Validation hint: missing/invalid fields may include ${requiredPaths.join(", ")}.`);
	}

	return lines.join("\n\n");
}

function buildToolCallExample(entry: ToolIndexEntry): string {
	const { required } = getSchemaParameters(entry.inputSchema);
	if (required.length === 0) {
		return `await call(${JSON.stringify(entry.server)}, ${JSON.stringify(entry.name)}, {});`;
	}
	const args = required
		.slice(0, 4)
		.map((name) => `${name}: "..."`)
		.join(", ");
	return `await call(${JSON.stringify(entry.server)}, ${JSON.stringify(entry.name)}, { ${args} });`;
}

function writeOverflowFile(entries: ToolIndexEntry[], query?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-tools-"));
	const file = join(dir, "mcp-tools.tsv");
	const lines: string[] = [
		`# generated: ${new Date().toISOString()}`,
		query ? `# query: ${query}` : "# query: (none)",
		"# columns: kind\tserver\tname\tresourceUri\tsignature\tdescription",
		...entries.map((entry) => {
			const signature = entry.kind === "tool" ? formatSchemaSignature(entry.inputSchema) : "";
			return [
				entry.kind,
				entry.server,
				entry.name,
				entry.resourceUri ?? "",
				signature,
				entry.description.replace(/\s+/g, " ").trim(),
			].join("\t");
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
	return file;
}


async function ensureConnectedServer(state: McpExtensionState, serverName: string) {
	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		throw new Error(`Unknown MCP server: ${serverName}`);
	}

	const existing = state.manager.getConnection(serverName);
	if (existing?.status === "connected") {
		return existing;
	}

	const failedAgo = getFailureAgeSeconds(state, serverName);
	if (failedAgo !== null) {
		throw new Error(`Server ${serverName} is in backoff (last failure ${failedAgo}s ago)`);
	}

	try {
		const connection = await state.manager.connect(serverName, definition);
		state.failureTracker.delete(serverName);
		state.toolIndex.set(serverName, buildToolIndex(serverName, connection.tools, connection.resources, definition));
		state.metadataFreshness.set(serverName, "live");
		updateMetadataCache(state, serverName);
		updateStatusBar(state);
		return connection;
	} catch (error) {
		state.failureTracker.set(serverName, Date.now());
		updateStatusBar(state);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to connect to ${serverName}: ${message}`);
	}
}

function normalizeMcpContent(content: McpContent[]): Array<Record<string, unknown>> {
	return content.map((item) => {
		if (item.type === "text") {
			return { type: "text", text: item.text ?? "" };
		}
		if (item.type === "image") {
			return {
				type: "image",
				mimeType: item.mimeType ?? "image/png",
				data: item.data ?? "",
			};
		}
		if (item.type === "resource") {
			return {
				type: "resource",
				uri: item.resource?.uri,
				text: item.resource?.text,
				blob: item.resource?.blob,
			};
		}
		if (item.type === "resource_link") {
			return {
				type: "resource_link",
				uri: item.uri,
				name: item.name,
				description: item.description,
			};
		}
		if (item.type === "audio") {
			return {
				type: "audio",
				mimeType: item.mimeType,
				data: item.data,
			};
		}
		return { type: "unknown", value: item };
	});
}

function updateMetadataCache(state: McpExtensionState, serverName: string): void {
	const connection = state.manager.getConnection(serverName);
	if (!connection || connection.status !== "connected") return;
	const definition = state.config.mcpServers[serverName];
	if (!definition) return;

	const entry: ServerCacheEntry = {
		configHash: computeServerHash(definition),
		tools: serializeTools(connection.tools),
		resources: definition.exposeResources === false ? [] : serializeResources(connection.resources),
		cachedAt: Date.now(),
	};

	saveMetadataCache({
		version: 1,
		servers: {
			[serverName]: entry,
		},
	});
}

function flushMetadataCache(state: McpExtensionState): void {
	const updates: Record<string, ServerCacheEntry> = {};

	for (const [serverName, connection] of state.manager.getAllConnections()) {
		if (connection.status !== "connected") continue;
		const definition = state.config.mcpServers[serverName];
		if (!definition) continue;
		updates[serverName] = {
			configHash: computeServerHash(definition),
			tools: serializeTools(connection.tools),
			resources: definition.exposeResources === false ? [] : serializeResources(connection.resources),
			cachedAt: Date.now(),
		};
	}

	if (Object.keys(updates).length === 0) return;

	saveMetadataCache({
		version: 1,
		servers: updates,
	});
}

function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
	const failedAt = state.failureTracker.get(serverName);
	if (!failedAt) return null;
	const age = Date.now() - failedAt;
	if (age > FAILURE_BACKOFF_MS) return null;
	return Math.round(age / 1000);
}

function updateStatusBar(state: McpExtensionState): void {
	if (!state.ui) return;
	state.ui.setStatus("mcp", undefined);
}

async function parallelLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let index = 0;

	async function worker() {
		while (index < items.length) {
			const current = index;
			index += 1;
			results[current] = await fn(items[current]);
		}
	}

	const workers = Array(Math.min(limit, items.length))
		.fill(null)
		.map(() => worker());
	await Promise.all(workers);
	return results;
}
