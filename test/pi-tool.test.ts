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
		expect(pi.registerCommand).toHaveBeenCalledWith("mcp", expect.any(Object));
	});
});
