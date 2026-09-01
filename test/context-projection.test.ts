import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { compactConsumedDiscoveries } from "../src/mcp/context-projection.js";

type Message = ContextEvent["messages"][number];

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (...calls: Array<{ id: string; name?: string }>): Message => ({
	role: "assistant",
	content: calls.map(({ id, name = "mcp_execute" }) => ({
		type: "toolCall" as const,
		id,
		name,
		arguments: { code: "return null" },
	})),
	api: "fixture",
	provider: "fixture",
	model: "fixture",
	usage,
	stopReason: "toolUse",
	timestamp: 1,
});

const mcpResult = (options: {
	callId: string;
	executionId: string;
	kind: "discovery" | "orchestration" | "snippet";
	ok?: boolean;
	isError?: boolean;
	errorKind?: string;
}): Message => {
	const ok = options.ok ?? true;
	return {
		role: "toolResult",
		toolCallId: options.callId,
		toolName: "mcp_execute",
		content: [{ type: "text", text: ok ? "large signatures" : "failure" }],
		details: {
			executionId: options.executionId,
			catalogSnapshotId: "catalog-1",
			kind: options.kind,
			result: ok
				? { ok: true, value: null, toolCalls: [] }
				: {
					ok: false,
					error: { kind: options.errorKind ?? "ToolFailure", message: "failed" },
					toolCalls: [],
				},
			calls: [],
			mappings: [],
			code: "sensitive detailed code",
		},
		usage,
		addedToolNames: ["mcp_execute"],
		isError: options.isError ?? false,
		timestamp: 2,
	};
};

const text = (message: Message): string =>
	message.role === "toolResult" && message.content[0]?.type === "text"
		? message.content[0].text
		: "";

describe("consumed MCP discovery context projection", () => {
	test("preserves an unused discovery", () => {
		const messages = [
			assistant({ id: "discovery-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
		];

		const projected = compactConsumedDiscoveries(messages);

		expect(projected).toEqual(messages);
		expect(projected[1]).toBe(messages[1]);
	});

	test.each([
		["failed", "ToolFailure", false],
		["cancelled", "ExecutionFailure", true],
		["denied", "ToolFailure", true],
		["stale schema", "InvalidToolInput", false],
	])("preserves discovery after a %s orchestration", (_label, errorKind, isError) => {
		const messages = [
			assistant({ id: "discovery-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
			assistant({ id: "orchestration-call" }),
			mcpResult({
				callId: "orchestration-call",
				executionId: "orchestration-1",
				kind: "orchestration",
				ok: false,
				isError,
				errorKind,
			}),
		];

		expect(compactConsumedDiscoveries(messages)).toEqual(messages);
	});

	test("compacts a discovery consumed by a later successful orchestration", () => {
		const discovery = mcpResult({
			callId: "discovery-call",
			executionId: "discovery-1",
			kind: "discovery",
		});
		const messages = [
			assistant({ id: "discovery-call" }),
			discovery,
			assistant({ id: "orchestration-call" }),
			mcpResult({ callId: "orchestration-call", executionId: "orchestration-1", kind: "orchestration" }),
		];

		const projected = compactConsumedDiscoveries(messages);
		const compacted = projected[1];

		expect(text(compacted!)).toBe(
			"MCP discovery from execution discovery-1 was consumed by execution orchestration-1; detailed signatures omitted from later context.",
		);
		expect(compacted).toMatchObject({
			role: "toolResult",
			toolCallId: "discovery-call",
			toolName: "mcp_execute",
			isError: false,
			timestamp: 2,
			usage,
			addedToolNames: ["mcp_execute"],
		});
		expect(compacted).not.toHaveProperty("details");
		expect(discovery).toHaveProperty("details.code", "sensitive detailed code");
	});

	test("compacts multiple independent discovery and orchestration cycles", () => {
		const messages = [
			assistant({ id: "d1" }),
			mcpResult({ callId: "d1", executionId: "discovery-1", kind: "discovery" }),
			assistant({ id: "o1" }),
			mcpResult({ callId: "o1", executionId: "orchestration-1", kind: "orchestration" }),
			assistant({ id: "d2" }),
			mcpResult({ callId: "d2", executionId: "discovery-2", kind: "discovery" }),
			assistant({ id: "o2" }),
			mcpResult({ callId: "o2", executionId: "orchestration-2", kind: "orchestration" }),
		];

		const projected = compactConsumedDiscoveries(messages);
		expect(text(projected[1]!)).toContain("consumed by execution orchestration-1");
		expect(text(projected[5]!)).toContain("consumed by execution orchestration-2");
	});

	test("ignores unrelated parallel tool results without breaking pairing", () => {
		const unrelated = {
			role: "toolResult" as const,
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text" as const, text: "file" }],
			isError: false,
			timestamp: 3,
		};
		const messages = [
			assistant({ id: "discovery-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
			assistant({ id: "read-call", name: "read" }),
			unrelated,
			assistant({ id: "orchestration-call" }),
			mcpResult({ callId: "orchestration-call", executionId: "orchestration-1", kind: "orchestration" }),
		];

		const projected = compactConsumedDiscoveries(messages);
		expect(text(projected[1]!)).toContain("consumed by execution orchestration-1");
		expect(projected[3]).toBe(unrelated);
	});

	test("does not compact a discovery requested in parallel with its apparent consumer", () => {
		const messages = [
			assistant({ id: "discovery-call" }, { id: "orchestration-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
			mcpResult({ callId: "orchestration-call", executionId: "orchestration-1", kind: "orchestration" }),
		];

		expect(compactConsumedDiscoveries(messages)).toEqual(messages);
	});

	test("a later successful retry consumes discovery retained through failure", () => {
		const messages = [
			assistant({ id: "discovery-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
			assistant({ id: "failed-call" }),
			mcpResult({ callId: "failed-call", executionId: "failed-1", kind: "orchestration", ok: false }),
			assistant({ id: "retry-call" }),
			mcpResult({ callId: "retry-call", executionId: "retry-1", kind: "orchestration" }),
		];

		expect(text(compactConsumedDiscoveries(messages)[1]!)).toContain("consumed by execution retry-1");
	});

	test("is deterministic for resumed sessions and never mutates source messages", () => {
		const messages = [
			assistant({ id: "discovery-call" }),
			mcpResult({ callId: "discovery-call", executionId: "discovery-1", kind: "discovery" }),
			assistant({ id: "orchestration-call" }),
			mcpResult({ callId: "orchestration-call", executionId: "orchestration-1", kind: "orchestration" }),
		];
		const original = structuredClone(messages);

		const first = compactConsumedDiscoveries(messages);
		const resumed = compactConsumedDiscoveries(structuredClone(messages));

		expect(first).toEqual(resumed);
		expect(messages).toEqual(original);
		expect(first).not.toBe(messages);
	});

	test("fails open for missing or ambiguous tool-call pairing", () => {
		const orphan = mcpResult({ callId: "missing", executionId: "discovery-1", kind: "discovery" });
		const duplicateCalls = assistant({ id: "duplicate" }, { id: "duplicate" });
		const messages = [
			orphan,
			duplicateCalls,
			mcpResult({ callId: "duplicate", executionId: "orchestration-1", kind: "orchestration" }),
		];

		expect(compactConsumedDiscoveries(messages)).toEqual(messages);
	});
});
