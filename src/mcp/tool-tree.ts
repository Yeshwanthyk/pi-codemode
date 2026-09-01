import { createHash } from "node:crypto";
import type { Definition } from "../codemode/tool.js";
import type { McpToolRef } from "./codemode-adapter.js";

export interface CodeModeToolTree {
	[name: string]: Definition | CodeModeToolTree;
}

export interface ToolPathMapping {
	readonly serverId: string;
	readonly wireToolName: string;
	readonly runtimePath: string;
}

export interface ToolTreeBuildResult {
	tools: CodeModeToolTree;
	mappings: ToolPathMapping[];
}

const blocked = new Set(["__proto__", "prototype", "constructor", "$codemode"]);

export function normalizeToolSegment(value: string, fallback: string): string {
	let normalized = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^A-Za-z0-9_$]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!normalized) normalized = fallback;
	if (!/^[A-Za-z_$]/.test(normalized)) normalized = `_${normalized}`;
	if (blocked.has(normalized)) normalized = `_${normalized.replace(/^\$+/, "")}`;
	return normalized;
}

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const uniqueSegment = (preferred: string, identity: string, used: Set<string>): string => {
	if (!used.has(preferred)) {
		used.add(preferred);
		return preferred;
	}
	const hashed = `${preferred}_${shortHash(identity)}`;
	if (!used.has(hashed)) {
		used.add(hashed);
		return hashed;
	}
	let index = 2;
	while (used.has(`${hashed}_${index}`)) index += 1;
	const result = `${hashed}_${index}`;
	used.add(result);
	return result;
};

export function buildToolTree(
	refs: readonly McpToolRef[],
	makeDefinition: (ref: McpToolRef, runtimePath: string) => Definition,
): ToolTreeBuildResult {
	const tools: CodeModeToolTree = Object.create(null) as CodeModeToolTree;
	const mappings: ToolPathMapping[] = [];
	const serverNames = new Map<string, string>();
	const usedServers = new Set<string>();
	const usedTools = new Map<string, Set<string>>();

	for (const ref of [...refs].sort((a, b) =>
		a.serverId.localeCompare(b.serverId) || a.wireToolName.localeCompare(b.wireToolName),
	)) {
		let serverName = serverNames.get(ref.serverId);
		if (!serverName) {
			serverName = uniqueSegment(
				normalizeToolSegment(ref.serverId, "server"),
				`server:${ref.serverId}`,
				usedServers,
			);
			serverNames.set(ref.serverId, serverName);
			tools[serverName] = Object.create(null) as CodeModeToolTree;
			usedTools.set(serverName, new Set());
		}

		const toolName = uniqueSegment(
			normalizeToolSegment(ref.wireToolName, "tool"),
			`${ref.serverId}:${ref.wireToolName}`,
			usedTools.get(serverName)!,
		);
		const runtimePath = `${serverName}.${toolName}`;
		(tools[serverName] as CodeModeToolTree)[toolName] = makeDefinition(ref, runtimePath);
		mappings.push({ serverId: ref.serverId, wireToolName: ref.wireToolName, runtimePath });
	}

	return { tools, mappings };
}
