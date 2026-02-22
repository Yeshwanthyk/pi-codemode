import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { McpResource, McpTool, ServerEntry, ToolIndexEntry } from "./types.js";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

export interface CachedTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface CachedResource {
	uri: string;
	name: string;
	description?: string;
}

export interface ServerCacheEntry {
	configHash: string;
	tools: CachedTool[];
	resources: CachedResource[];
	cachedAt: number;
}

export interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

export function getMetadataCachePath(): string {
	return CACHE_PATH;
}

export function loadMetadataCache(): MetadataCache | null {
	if (!existsSync(CACHE_PATH)) return null;
	try {
		const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.version !== CACHE_VERSION) return null;
		if (!parsed.servers || typeof parsed.servers !== "object") return null;
		return parsed as MetadataCache;
	} catch {
		return null;
	}
}

export function saveMetadataCache(cache: MetadataCache): void {
	mkdirSync(dirname(CACHE_PATH), { recursive: true });

	let merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
	const existing = loadMetadataCache();
	if (existing) {
		merged = {
			version: CACHE_VERSION,
			servers: { ...existing.servers },
		};
	}

	merged.servers = {
		...merged.servers,
		...cache.servers,
	};

	const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, CACHE_PATH);
}

export function computeServerHash(definition: ServerEntry): string {
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		env: definition.env,
		cwd: definition.cwd,
		url: definition.url,
		headers: definition.headers,
		auth: definition.auth,
		bearerToken: definition.bearerToken,
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
	};
	const normalized = stableStringify(identity);
	return createHash("sha256").update(normalized).digest("hex");
}

export function isServerCacheValid(
	entry: ServerCacheEntry,
	definition: ServerEntry,
	maxAgeMs: number = CACHE_MAX_AGE_MS,
): boolean {
	if (!entry) return false;
	if (entry.configHash !== computeServerHash(definition)) return false;
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
	if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
	return true;
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
	return tools
		.filter((tool) => typeof tool?.name === "string" && tool.name.length > 0)
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
	return resources
		.filter((resource) => typeof resource?.name === "string" && typeof resource?.uri === "string")
		.map((resource) => ({
			name: resource.name,
			uri: resource.uri,
			description: resource.description,
		}));
}

export function reconstructToolIndex(
	serverName: string,
	entry: ServerCacheEntry,
	exposeResources: boolean | undefined,
): ToolIndexEntry[] {
	const output: ToolIndexEntry[] = [];

	for (const tool of entry.tools ?? []) {
		if (!tool?.name) continue;
		output.push({
			kind: "tool",
			server: serverName,
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
		});
	}

	if (exposeResources !== false) {
		for (const resource of entry.resources ?? []) {
			if (!resource?.name || !resource?.uri) continue;
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

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
