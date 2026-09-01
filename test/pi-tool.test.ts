import { describe, expect, test, vi } from "vitest";
import mcpCodemodeExtension from "../src/index.js";

describe("Pi registration", () => {
	test("exposes exactly one model tool named mcp_execute and registers catalog injection", () => {
		const tools: Array<{ name: string; parameters: unknown }> = [];
		const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
		const pi = {
			registerFlag: vi.fn(),
			registerTool: vi.fn((tool) => tools.push(tool)),
			registerCommand: vi.fn(),
			on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}),
		} as any;

		mcpCodemodeExtension(pi);

		expect(tools.map((tool) => tool.name)).toEqual(["mcp_execute"]);
		expect(JSON.stringify(tools[0]?.parameters)).toContain("code");
		expect(JSON.stringify(tools[0]?.parameters)).not.toContain("timeoutMs");
		expect(handlers.get("before_agent_start")).toHaveLength(1);
		expect(handlers.get("context")).toHaveLength(1);
		expect(pi.registerCommand).toHaveBeenCalledWith("mcp", expect.any(Object));
	});
});

test("renders new execution identity and legacy session details defensively", () => {
	const tools: any[] = [];
	const pi = {
		registerFlag: vi.fn(),
		registerTool: vi.fn((tool) => tools.push(tool)),
		registerCommand: vi.fn(),
		on: vi.fn(),
	} as any;
	mcpCodemodeExtension(pi);
	const tool = tools[0];
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	};
	const render = (result: unknown, expanded: boolean) =>
		tool.renderResult(result, { expanded }, theme).render(200).join("\n");

	const legacy = {
		content: [{ type: "text", text: "legacy model content" }],
		details: { result: { ok: true }, calls: [] },
	};
	expect(render(legacy, true)).toContain("legacy model content");
	expect(render(legacy, false)).toContain("✓ MCP Code Mode completed (0 MCP calls)");

	const current = {
		content: [{ type: "text", text: '[{"id":"item-1"}]' }],
		details: {
			executionId: "execution-1",
			catalogSnapshotId: "catalog-1",
			kind: "orchestration",
			result: { ok: true, value: [], toolCalls: [] },
			calls: [{ runtimePath: "tracker.create_item", outcome: "success" }],
			mappings: [],
			code: "const bearerToken = 'must-not-render'",
		},
	};
	const expanded = render(current, true);
	expect(expanded).toContain('[{"id":"item-1"}]');
	expect(expanded).toContain("Execution ID: execution-1");
	expect(expanded).toContain("Catalog ID: catalog-1");
	expect(expanded).toContain("tracker.create_item: success");
	expect(expanded).not.toContain("must-not-render");
	const failure = {
		content: [{ type: "text", text: "ToolFailure: Request denied" }],
		details: {
			result: { ok: false, error: { message: "Request denied\n    at secret/file.ts:1:1" } },
			calls: [],
		},
	};
	const collapsedFailure = render(failure, false);
	expect(collapsedFailure).toContain("✗ ToolFailure: Request denied");
	expect(collapsedFailure).not.toContain("secret/file.ts");
	expect(render(current, false)).toContain("✓ MCP Code Mode completed (1 MCP calls)");
});
