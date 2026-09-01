import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpConfig, McpSettings, ServerEntry } from "./types.js";
import { getPiAgentDir } from "./paths.js";

const MCP_DEBUG = process.env.PI_MCP_DEBUG === "1";

function debugWarn(...args: unknown[]): void {
	if (MCP_DEBUG) {
		console.warn(...args);
	}
}

const GLOBAL_CONFIG_CANDIDATES = [
	join(getPiAgentDir(), "mcp.json"),
	join(getPiAgentDir(), ".mcp.json"),
];

const PROJECT_CONFIG_CANDIDATES = [
	resolve(process.cwd(), ".pi", "mcp.json"),
	resolve(process.cwd(), ".mcp.json"),
];

export function loadMcpConfig(overridePath?: string): McpConfig {
	const sourceFiles = new Set<string>();

	if (overridePath) {
		sourceFiles.add(resolve(overridePath));
	} else {
		for (const candidate of GLOBAL_CONFIG_CANDIDATES) {
			sourceFiles.add(candidate);
		}
	}

	for (const candidate of PROJECT_CONFIG_CANDIDATES) {
		sourceFiles.add(candidate);
	}

	const merged: McpConfig = { mcpServers: {} };

	for (const path of sourceFiles) {
		if (!existsSync(path)) continue;
		const parsed = loadSingleConfig(path);
		if (!parsed) continue;

		merged.mcpServers = {
			...merged.mcpServers,
			...parsed.mcpServers,
		};

		if (parsed.settings) {
			merged.settings = {
				...(merged.settings ?? {}),
				...parsed.settings,
			};
		}
	}

	return merged;
}

function loadSingleConfig(path: string): McpConfig | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return validateConfig(raw);
	} catch (error) {
		debugWarn(`MCP: failed to load config from ${path}:`, error);
		return null;
	}
}

function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { mcpServers: {} };
	}

	const obj = raw as Record<string, unknown>;
	const rawServers = obj.mcpServers ?? obj["mcp-servers"] ?? obj.servers ?? {};

	const mcpServers: Record<string, ServerEntry> = {};
	if (rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)) {
		for (const [name, value] of Object.entries(rawServers)) {
			const entry = normalizeServerEntry(value);
			if (entry) {
				mcpServers[name] = entry;
			}
		}
	}

	const settings = normalizeSettings(obj.settings);

	return {
		mcpServers,
		settings,
	};
}

function normalizeSettings(value: unknown): McpSettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const settings = value as Record<string, unknown>;
	const out: McpSettings = {};
	if (typeof settings.idleTimeout === "number" && Number.isFinite(settings.idleTimeout)) {
		out.idleTimeout = settings.idleTimeout;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeServerEntry(value: unknown): ServerEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const entry = value as Record<string, unknown>;

	const args = Array.isArray(entry.args)
		? entry.args.map((arg) => String(arg))
		: undefined;

	const env = normalizeStringRecord(entry.env);
	const headers = normalizeStringRecord(entry.headers);

	const out: ServerEntry = {
		description: typeof entry.description === "string" ? entry.description : undefined,
		command: typeof entry.command === "string" ? entry.command : undefined,
		args,
		resolveNpx: typeof entry.resolveNpx === "boolean" ? entry.resolveNpx : undefined,
		env,
		cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
		url: typeof entry.url === "string" ? entry.url : undefined,
		headers,
		auth: entry.auth === "oauth" || entry.auth === "bearer" ? entry.auth : undefined,
		bearerToken: typeof entry.bearerToken === "string" ? entry.bearerToken : undefined,
		bearerTokenEnv: typeof entry.bearerTokenEnv === "string" ? entry.bearerTokenEnv : undefined,
		oauthClientId: typeof entry.oauthClientId === "string" ? entry.oauthClientId : undefined,
		oauthClientSecret: typeof entry.oauthClientSecret === "string" ? entry.oauthClientSecret : undefined,
		oauthClientMetadataUrl:
			typeof entry.oauthClientMetadataUrl === "string" ? entry.oauthClientMetadataUrl : undefined,
		oauthTokenEndpointAuthMethod:
			typeof entry.oauthTokenEndpointAuthMethod === "string"
				? entry.oauthTokenEndpointAuthMethod
				: undefined,
		lifecycle:
			entry.lifecycle === "lazy" || entry.lifecycle === "eager" || entry.lifecycle === "keep-alive"
				? entry.lifecycle
				: undefined,
		idleTimeout:
			typeof entry.idleTimeout === "number" && Number.isFinite(entry.idleTimeout)
				? entry.idleTimeout
				: undefined,
		exposeResources: typeof entry.exposeResources === "boolean" ? entry.exposeResources : undefined,
		debug: typeof entry.debug === "boolean" ? entry.debug : undefined,
		approval: entry.approval === "always" || entry.approval === "never" ? entry.approval : undefined,
	};

	if (!out.command && !out.url) {
		return null;
	}

	return out;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item === "string") {
			out[key] = item;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
