import { describe, expect, test } from "vitest";
import type { Failure, Success } from "../src/codemode/codemode.js";
import type { McpCallMetadata } from "../src/mcp/codemode-adapter.js";
import {
	classifyExecution,
	formatDiagnostic,
	formatModelValue,
	projectExecution,
} from "../src/mcp/execution-projector.js";

const success = (value: Success["value"], names: string[] = []): Success => ({
	ok: true,
	value,
	toolCalls: names.map((name) => ({ name })),
});

const failure = (message: string): Failure => ({
	ok: false,
	error: {
		kind: "ToolFailure",
		message,
		suggestions: ["Retry once", "Inspect the schema", "Use a smaller input", "This suggestion is omitted"],
	},
	toolCalls: [],
});

const call: McpCallMetadata = {
	serverId: "tracker",
	wireToolName: "create_item",
	runtimePath: "tracker.create_item",
	startedAt: 1,
	endedAt: 2,
	outcome: "success",
};

const mapping = {
	serverId: "tracker",
	wireToolName: "create_item",
	runtimePath: "tracker.create_item",
};

describe("MCP execution projection", () => {
	test("returns only the successful model value while retaining complete details", () => {
		const result = success({ ok: "domain value", id: 7 }, ["tracker.create_item"]);
		const projected = projectExecution({
			executionId: "execution-1",
			catalogSnapshotId: "catalog-1",
			result,
			calls: [call],
			mappings: [mapping],
			code: "return await tools.tracker.create_item({})",
		});

		expect(projected.text).toBe('{"id":7,"ok":"domain value"}');
		expect(projected.text).not.toContain("toolCalls");
		expect(projected.text).not.toContain("tracker.create_item");
		expect(projected.text).not.toContain("return await");
		expect(projected.details.result).toBe(result);
		expect(projected.details).toMatchObject({
			executionId: "execution-1",
			catalogSnapshotId: "catalog-1",
			kind: "orchestration",
			code: "return await tools.tracker.create_item({})",
			calls: [call],
			mappings: [mapping],
		});
	});

	test("returns strings directly and serializes objects deterministically", () => {
		expect(formatModelValue("hello")).toBe("hello");
		expect(formatModelValue(null)).toBe("null");
		expect(formatModelValue({ z: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"z":1}');
	});

	test("bounds UTF-8 content and marks truncation explicitly", () => {
		const text = formatModelValue("🙂".repeat(100), { maximumBytes: 100 });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(100);
		expect(text).toContain("[truncated:");
		expect(text).not.toContain("�");
	});

	test("marks truncation already reported by CodeMode", () => {
		expect(formatModelValue("partial", { runtimeTruncated: true })).toContain(
			"[truncated: CodeMode output limit reached]",
		);
	});

	test("formats safe bounded diagnostics without stack traces", () => {
		const text = formatDiagnostic(failure("Remote failure\n    at secret/file.ts:12:3").error);
		expect(text).toContain("ToolFailure: Remote failure");
		expect(text.match(/Suggestion:/g)).toHaveLength(3);
		expect(text).not.toContain("secret/file.ts");
		expect(text).not.toContain("stack");
	});

	test("projects concise failures while retaining the full failure result", () => {
		const result = failure("Denied\nError stack");
		const projected = projectExecution({
			executionId: "execution-2",
			catalogSnapshotId: "catalog-2",
			result,
			calls: [],
			mappings: [],
			code: "throw new Error('secret')",
		});

		expect(projected.text).toContain("ToolFailure: Denied");
		expect(projected.text).not.toContain("Error stack");
		expect(projected.text).not.toContain("throw new Error");
		expect(projected.details.result).toBe(result);
	});

	test("classifies only search and describe calls as discovery", () => {
		expect(classifyExecution(success(null, ["$codemode.search"]), [])).toBe("discovery");
		expect(classifyExecution(success(null, ["$codemode.search", "$codemode.describe"]), [])).toBe("discovery");
	});

	test("classifies external, mixed, and call-free programs as orchestration", () => {
		expect(classifyExecution(success(null, ["tracker.create_item"]), [call])).toBe("orchestration");
		expect(classifyExecution(success(null, ["$codemode.search", "tracker.create_item"]), [call])).toBe("orchestration");
		expect(classifyExecution(success(42), [])).toBe("orchestration");
	});
});
