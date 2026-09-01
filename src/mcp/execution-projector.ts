import type { Result as CodeModeResult, Diagnostic, Success } from "../codemode/codemode.js";
import type { McpCallMetadata } from "./codemode-adapter.js";
import { canonicalJson } from "./catalog.js";
import type { ToolPathMapping } from "./tool-tree.js";

export const DEFAULT_MODEL_CONTENT_BYTES = 50 * 1024;
const MAX_DIAGNOSTIC_MESSAGE_CHARACTERS = 500;
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARACTERS = 200;
const CONTENT_TRUNCATION_MARKER = "\n[truncated: model-facing MCP result exceeded byte limit]";
const RUNTIME_TRUNCATION_MARKER = "\n[truncated: CodeMode output limit reached]";

export type McpExecutionKind = "discovery" | "orchestration" | "snippet";

export interface McpExecutionDetails {
	readonly executionId: string;
	readonly catalogSnapshotId: string;
	readonly kind: McpExecutionKind;
	readonly result: CodeModeResult;
	readonly calls: readonly McpCallMetadata[];
	readonly mappings: readonly ToolPathMapping[];
	readonly code: string;
	readonly snippet?: {
		readonly name: string;
		readonly version: number;
		readonly scope: "project" | "global";
	};
}

export interface McpExecutionProjection {
	readonly text: string;
	readonly details: McpExecutionDetails;
}

const discoveryPaths = new Set(["$codemode.search", "$codemode.describe"]);

export function classifyExecution(
	result: Pick<CodeModeResult, "toolCalls">,
	calls: readonly McpCallMetadata[],
): Exclude<McpExecutionKind, "snippet"> {
	if (
		calls.length === 0 &&
		result.toolCalls.length > 0 &&
		result.toolCalls.every((call) => discoveryPaths.has(call.name))
	) {
		return "discovery";
	}
	return "orchestration";
}

const firstSafeLine = (value: string, maximumCharacters: number): string => {
	const line = value.split(/\r?\n/, 1)[0] ?? "";
	const sanitized = line.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	const characters = Array.from(sanitized);
	return characters.length <= maximumCharacters
		? sanitized
		: `${characters.slice(0, Math.max(0, maximumCharacters - 3)).join("")}...`;
};

const utf8Prefix = (value: string, maximumBytes: number): string => {
	if (maximumBytes <= 0) return "";
	let bytes = 0;
	let output = "";
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maximumBytes) break;
		bytes += size;
		output += character;
	}
	return output;
};

const boundText = (value: string, maximumBytes: number): string => {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
		throw new RangeError("maximumBytes must be a positive safe integer");
	}
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const markerBytes = Buffer.byteLength(CONTENT_TRUNCATION_MARKER, "utf8");
	if (markerBytes >= maximumBytes) return utf8Prefix(CONTENT_TRUNCATION_MARKER.trimStart(), maximumBytes);
	return `${utf8Prefix(value, maximumBytes - markerBytes)}${CONTENT_TRUNCATION_MARKER}`;
};

export function formatModelValue(
	value: Success["value"],
	options: { readonly maximumBytes?: number; readonly runtimeTruncated?: boolean } = {},
): string {
	const maximumBytes = options.maximumBytes ?? DEFAULT_MODEL_CONTENT_BYTES;
	const rendered = typeof value === "string" ? value : canonicalJson(value);
	const withRuntimeMarker = options.runtimeTruncated ? `${rendered}${RUNTIME_TRUNCATION_MARKER}` : rendered;
	return boundText(withRuntimeMarker, maximumBytes);
}

export function formatDiagnostic(
	diagnostic: Diagnostic,
	options: { readonly maximumBytes?: number; readonly runtimeTruncated?: boolean } = {},
): string {
	const message = firstSafeLine(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARACTERS) || "Code Mode execution failed";
	const suggestions = (diagnostic.suggestions ?? [])
		.slice(0, MAX_SUGGESTIONS)
		.map((suggestion) => firstSafeLine(suggestion, MAX_SUGGESTION_CHARACTERS))
		.filter(Boolean);
	const rendered = [
		`${diagnostic.kind}: ${message}`,
		...suggestions.map((suggestion) => `Suggestion: ${suggestion}`),
	].join("\n");
	const withRuntimeMarker = options.runtimeTruncated ? `${rendered}${RUNTIME_TRUNCATION_MARKER}` : rendered;
	return boundText(withRuntimeMarker, options.maximumBytes ?? DEFAULT_MODEL_CONTENT_BYTES);
}

export function projectExecution(options: {
	readonly executionId: string;
	readonly catalogSnapshotId: string;
	readonly result: CodeModeResult;
	readonly calls: readonly McpCallMetadata[];
	readonly mappings: readonly ToolPathMapping[];
	readonly code: string;
	readonly maximumBytes?: number;
}): McpExecutionProjection {
	const details: McpExecutionDetails = {
		executionId: options.executionId,
		catalogSnapshotId: options.catalogSnapshotId,
		kind: classifyExecution(options.result, options.calls),
		result: options.result,
		calls: options.calls.map((call) => ({ ...call })),
		mappings: options.mappings.map((mapping) => ({ ...mapping })),
		code: options.code,
	};
	const formatOptions = {
		maximumBytes: options.maximumBytes,
		runtimeTruncated: options.result.truncated === true,
	};
	return {
		text: options.result.ok
			? formatModelValue(options.result.value, formatOptions)
			: formatDiagnostic(options.result.error, formatOptions),
		details,
	};
}
