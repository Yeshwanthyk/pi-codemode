import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpResource, McpTool, ServerEntry, Transport } from "./types.js";
import { getStoredTokens } from "./oauth-handler.js";
import { resolveNpxBinary } from "./npx-resolver.js";

export interface ServerConnection {
	client: Client;
	transport: Transport;
	definition: ServerEntry;
	tools: McpTool[];
	resources: McpResource[];
	lastUsedAt: number;
	inFlight: number;
	status: "connected" | "closed";
}

export class McpServerManager {
	private connections = new Map<string, ServerConnection>();
	private connectPromises = new Map<string, Promise<ServerConnection>>();

	async connect(name: string, definition: ServerEntry): Promise<ServerConnection> {
		if (this.connectPromises.has(name)) {
			return this.connectPromises.get(name)!;
		}

		const existing = this.connections.get(name);
		if (existing?.status === "connected") {
			existing.lastUsedAt = Date.now();
			return existing;
		}

		const promise = this.createConnection(name, definition);
		this.connectPromises.set(name, promise);

		try {
			const connection = await promise;
			this.connections.set(name, connection);
			return connection;
		} finally {
			this.connectPromises.delete(name);
		}
	}

	private async createConnection(name: string, definition: ServerEntry): Promise<ServerConnection> {
		const client = new Client({ name: `pi-codemode-mcp-${name}`, version: "0.1.0" });

		let transport: Transport;

		if (definition.command) {
			let command = definition.command;
			let args = definition.args ?? [];

			if (command === "npx" || command === "npm") {
				const resolved = await resolveNpxBinary(command, args);
				if (resolved) {
					command = resolved.isJs ? "node" : resolved.binPath;
					args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
				}
			}

			transport = new StdioClientTransport({
				command,
				args,
				env: resolveEnv(definition.env),
				cwd: definition.cwd,
				stderr: definition.debug ? "inherit" : "ignore",
			});
		} else if (definition.url) {
			transport = await this.createHttpTransport(definition, name);
		} else {
			throw new Error(`Server ${name} has no command or url`);
		}

		try {
			await client.connect(transport);

			const [tools, resources] = await Promise.all([this.fetchAllTools(client), this.fetchAllResources(client)]);

			return {
				client,
				transport,
				definition,
				tools,
				resources,
				lastUsedAt: Date.now(),
				inFlight: 0,
				status: "connected",
			};
		} catch (error) {
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
			throw error;
		}
	}

	private async createHttpTransport(definition: ServerEntry, serverName: string): Promise<Transport> {
		const url = new URL(definition.url!);
		const headers = resolveHeaders(definition.headers) ?? {};

		if (definition.auth === "bearer") {
			const token =
				definition.bearerToken ??
				(definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
		}

		if (definition.auth !== "bearer") {
			const tokens = getStoredTokens(serverName);
			if (definition.auth === "oauth" && !tokens) {
				throw new Error(`No OAuth tokens for "${serverName}" at ~/.pi/agent/mcp-oauth/${serverName}/tokens.json`);
			}
			if (tokens && !headers.Authorization) {
				headers.Authorization = `Bearer ${tokens.access_token}`;
			}
		}

		const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

		const streamable = new StreamableHTTPClientTransport(url, { requestInit });
		try {
			const probe = new Client({ name: "pi-codemode-mcp-probe", version: "0.1.0" });
			await probe.connect(streamable);
			await probe.close().catch(() => {});
			await streamable.close().catch(() => {});
			return new StreamableHTTPClientTransport(url, { requestInit });
		} catch (error) {
			await streamable.close().catch(() => {});
			if (!shouldFallbackToSse(error)) {
				throw error;
			}
			return new SSEClientTransport(url, { requestInit });
		}
	}

	private async fetchAllTools(client: Client): Promise<McpTool[]> {
		const allTools: McpTool[] = [];
		let cursor: string | undefined;

		do {
			const result = await client.listTools(cursor ? { cursor } : undefined);
			allTools.push(...(result.tools ?? []));
			cursor = result.nextCursor;
		} while (cursor);

		return allTools;
	}

	private async fetchAllResources(client: Client): Promise<McpResource[]> {
		try {
			const allResources: McpResource[] = [];
			let cursor: string | undefined;
			do {
				const result = await client.listResources(cursor ? { cursor } : undefined);
				allResources.push(...(result.resources ?? []));
				cursor = result.nextCursor;
			} while (cursor);
			return allResources;
		} catch {
			return [];
		}
	}

	getConnection(name: string): ServerConnection | undefined {
		return this.connections.get(name);
	}

	getAllConnections(): Map<string, ServerConnection> {
		return new Map(this.connections);
	}

	touch(name: string): void {
		const connection = this.connections.get(name);
		if (connection) {
			connection.lastUsedAt = Date.now();
		}
	}

	incrementInFlight(name: string): void {
		const connection = this.connections.get(name);
		if (connection) {
			connection.inFlight += 1;
		}
	}

	decrementInFlight(name: string): void {
		const connection = this.connections.get(name);
		if (connection && connection.inFlight > 0) {
			connection.inFlight -= 1;
		}
	}

	isIdle(name: string, timeoutMs: number): boolean {
		const connection = this.connections.get(name);
		if (!connection || connection.status !== "connected") return false;
		if (connection.inFlight > 0) return false;
		return Date.now() - connection.lastUsedAt > timeoutMs;
	}

	async close(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;

		connection.status = "closed";
		this.connections.delete(name);
		await connection.client.close().catch(() => {});
		await connection.transport.close().catch(() => {});
	}

	async closeAll(): Promise<void> {
		const names = [...this.connections.keys()];
		await Promise.all(names.map((name) => this.close(name)));
	}
}

function shouldFallbackToSse(error: unknown): boolean {
	if (error instanceof StreamableHTTPError) {
		return error.code === 404 || error.code === 405;
	}
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "number") {
			return code === 404 || code === 405;
		}
	}
	return true;
}

function resolveEnv(env?: Record<string, string>): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			resolved[key] = value;
		}
	}

	if (!env) return resolved;

	for (const [key, value] of Object.entries(env)) {
		resolved[key] = value
			.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
			.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
	}
	return resolved;
}

function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = value
			.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
			.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "");
	}
	return resolved;
}
