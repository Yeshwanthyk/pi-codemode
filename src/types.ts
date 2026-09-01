import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type Transport =
	| StdioClientTransport
	| SSEClientTransport
	| StreamableHTTPClientTransport;

export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
}

export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface McpContent {
	type: "text" | "image" | "audio" | "resource" | "resource_link";
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: {
		uri: string;
		text?: string;
		blob?: string;
	};
	uri?: string;
	name?: string;
	description?: string;
}

export interface ServerEntry {
	description?: string;
	command?: string;
	args?: string[];
	/** Keep the declared launcher intact so a Nono command policy can broker it. */
	resolveNpx?: boolean;
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: "oauth" | "bearer";
	bearerToken?: string;
	bearerTokenEnv?: string;
	oauthClientId?: string;
	oauthClientSecret?: string;
	oauthClientMetadataUrl?: string;
	oauthTokenEndpointAuthMethod?: string;
	lifecycle?: "keep-alive" | "lazy" | "eager";
	idleTimeout?: number;
	exposeResources?: boolean;
	debug?: boolean;
	approval?: "never" | "always";
}

export interface McpSettings {
	idleTimeout?: number;
}

export interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	settings?: McpSettings;
}

export interface ToolIndexEntry {
	kind: "tool" | "resource";
	server: string;
	name: string;
	description: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	resourceUri?: string;
}
