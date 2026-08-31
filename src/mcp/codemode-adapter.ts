import { Effect } from "effect";
import { Tool, toolError } from "../codemode/index.js";
import type { JsonSchema } from "../codemode/tool.js";
import { projectMcpResult, type McpCallResult } from "./result-projector.js";
import { buildToolTree, type ToolTreeBuildResult } from "./tool-tree.js";

export interface McpClient {
	callTool(
		wireToolName: string,
		input: Record<string, unknown>,
		options: { signal: AbortSignal; timeout?: number },
	): Promise<McpCallResult>;
}

export interface McpToolRef {
	serverId: string;
	wireToolName: string;
	description?: string;
	inputSchema: JsonSchema;
	outputSchema?: JsonSchema;
	client: McpClient;
	timeout?: number;
}

export interface McpAuthorizationRequest {
	serverId: string;
	wireToolName: string;
	input: Record<string, unknown>;
	signal: AbortSignal;
}

export type McpAuthorizer = (request: McpAuthorizationRequest) => Promise<void>;

export interface McpCallMetadata {
	serverId: string;
	wireToolName: string;
	runtimePath: string;
	startedAt: number;
	endedAt: number;
	outcome: "success" | "failure";
	message?: string;
}

export interface BuildMcpCodeModeToolsOptions {
	refs: readonly McpToolRef[];
	authorize: McpAuthorizer;
	signal?: AbortSignal;
	onCall?: (metadata: McpCallMetadata) => void;
}

export interface McpCodeModeTools extends ToolTreeBuildResult {
	metadata: McpCallMetadata[];
}

const asInputRecord = (input: unknown): Record<string, unknown> => {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("MCP tool input must be an object");
	}
	return input as Record<string, unknown>;
};

const combineSignals = (parent: AbortSignal | undefined, timeout: number | undefined) => {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => controller.abort(parent?.reason ?? new Error("MCP execution cancelled"));
	if (parent) {
		if (parent.aborted) abort();
		else parent.addEventListener("abort", abort, { once: true });
	}
	if (timeout !== undefined) {
		timer = setTimeout(() => controller.abort(new Error(`MCP call timed out after ${timeout}ms`)), timeout);
		timer.unref?.();
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timer) clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
};

const safeFailureMessage = (ref: McpToolRef, error: unknown): string => {
	if (error instanceof Error && error.name === "AbortError") return "MCP call cancelled";
	if (error instanceof Error && /timed out/i.test(error.message)) return error.message;
	if (error instanceof Error && error.message.trim()) {
		return `MCP ${ref.serverId}/${ref.wireToolName} failed: ${error.message}`;
	}
	return `MCP ${ref.serverId}/${ref.wireToolName} failed`;
};

export function buildMcpCodeModeTools(options: BuildMcpCodeModeToolsOptions): McpCodeModeTools {
	const metadata: McpCallMetadata[] = [];
	const built = buildToolTree(options.refs, (ref, runtimePath) =>
		Tool.make({
			description: ref.description?.trim() || `Call ${ref.serverId}/${ref.wireToolName}`,
			input: ref.inputSchema,
			output: ref.outputSchema,
			run: (rawInput) =>
				Effect.tryPromise({
					try: async () => {
						const input = asInputRecord(rawInput);
						const startedAt = Date.now();
						const callSignal = combineSignals(options.signal, ref.timeout);
						try {
							callSignal.signal.throwIfAborted();
							await options.authorize({
								serverId: ref.serverId,
								wireToolName: ref.wireToolName,
								input,
								signal: callSignal.signal,
							});
							callSignal.signal.throwIfAborted();
							const result = await ref.client.callTool(ref.wireToolName, input, {
								signal: callSignal.signal,
								timeout: ref.timeout,
							});
							const entry: McpCallMetadata = {
								serverId: ref.serverId,
								wireToolName: ref.wireToolName,
								runtimePath,
								startedAt,
								endedAt: Date.now(),
								outcome: "success",
							};
							metadata.push(entry);
							options.onCall?.(entry);
							return projectMcpResult(result);
						} catch (error) {
							const message = safeFailureMessage(ref, error);
							const entry: McpCallMetadata = {
								serverId: ref.serverId,
								wireToolName: ref.wireToolName,
								runtimePath,
								startedAt,
								endedAt: Date.now(),
								outcome: "failure",
								message,
							};
							metadata.push(entry);
							options.onCall?.(entry);
							throw error;
						} finally {
							callSignal.cleanup();
						}
					},
					catch: (error) => toolError(safeFailureMessage(ref, error), error),
				}),
		}),
	);
	return { ...built, metadata };
}
