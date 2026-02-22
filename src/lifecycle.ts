import type { ServerEntry } from "./types.js";
import type { McpServerManager } from "./server-manager.js";

const MCP_DEBUG = process.env.PI_MCP_DEBUG === "1";

function debugLog(...args: unknown[]): void {
	if (MCP_DEBUG) {
		console.log(...args);
	}
}

function debugError(...args: unknown[]): void {
	if (MCP_DEBUG) {
		console.error(...args);
	}
}

export type ReconnectCallback = (serverName: string) => void;

export class McpLifecycleManager {
	private manager: McpServerManager;
	private keepAliveServers = new Map<string, ServerEntry>();
	private allServers = new Map<string, ServerEntry>();
	private serverSettings = new Map<string, { idleTimeout?: number }>();
	private globalIdleTimeout = 10 * 60 * 1000;
	private healthCheckInterval?: NodeJS.Timeout;
	private onReconnect?: ReconnectCallback;
	private onIdleShutdown?: (serverName: string) => void;

	constructor(manager: McpServerManager) {
		this.manager = manager;
	}

	setReconnectCallback(callback: ReconnectCallback): void {
		this.onReconnect = callback;
	}

	setIdleShutdownCallback(callback: (serverName: string) => void): void {
		this.onIdleShutdown = callback;
	}

	registerServer(name: string, definition: ServerEntry, settings?: { idleTimeout?: number }): void {
		this.allServers.set(name, definition);
		if (settings?.idleTimeout !== undefined) {
			this.serverSettings.set(name, settings);
		}
	}

	markKeepAlive(name: string, definition: ServerEntry): void {
		this.keepAliveServers.set(name, definition);
	}

	setGlobalIdleTimeout(minutes: number): void {
		this.globalIdleTimeout = Math.max(0, minutes) * 60 * 1000;
	}

	startHealthChecks(intervalMs = 30_000): void {
		this.healthCheckInterval = setInterval(() => {
			void this.checkConnections();
		}, intervalMs);
		this.healthCheckInterval.unref();
	}

	private async checkConnections(): Promise<void> {
		for (const [name, definition] of this.keepAliveServers) {
			const connection = this.manager.getConnection(name);
			if (!connection || connection.status !== "connected") {
				try {
					await this.manager.connect(name, definition);
					this.onReconnect?.(name);
					debugLog(`MCP: keep-alive reconnected ${name}`);
				} catch (error) {
					debugError(`MCP: keep-alive reconnect failed for ${name}:`, error);
				}
			}
		}

		for (const [name] of this.allServers) {
			if (this.keepAliveServers.has(name)) continue;
			const timeout = this.getIdleTimeout(name);
			if (timeout > 0 && this.manager.isIdle(name, timeout)) {
				await this.manager.close(name);
				this.onIdleShutdown?.(name);
			}
		}
	}

	private getIdleTimeout(name: string): number {
		const perServer = this.serverSettings.get(name)?.idleTimeout;
		if (perServer !== undefined) return perServer * 60 * 1000;
		return this.globalIdleTimeout;
	}

	async gracefulShutdown(): Promise<void> {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = undefined;
		}
		await this.manager.closeAll();
	}
}
