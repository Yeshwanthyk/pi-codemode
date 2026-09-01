import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { appendMcpCodeModePrompt, createCodeModeRuntime } from "../src/index.js";

const makeState = (entries: readonly Record<string, unknown>[], description?: string) => ({
	config: {
		mcpServers: {
			"work-tracker": {
				command: "fixture-mcp",
				...(description === undefined ? {} : { description }),
			},
		},
	},
	toolIndex: new Map([["work-tracker", entries]]),
	toolPolicies: new Map(),
	metadataFreshness: new Map([["work-tracker", "cached"]]),
	manager: {},
});

describe("Pi progressive MCP prompt", () => {
	test("advertises enabled connector namespaces and admin hints without operation signatures", () => {
		const state = makeState(
			[
				{
					kind: "tool",
					server: "work-tracker",
					name: "create-item",
					description: "REMOTE TOOL DESCRIPTION MUST NOT APPEAR",
					inputSchema: { type: "object", properties: { title: { type: "string" } } },
				},
				{
					kind: "tool",
					server: "work-tracker",
					name: "search-items",
					description: "Another remote description",
					inputSchema: { type: "object" },
				},
				{
					kind: "resource",
					server: "work-tracker",
					name: "internal-resource",
					description: "Resource metadata",
					resourceUri: "fixture://resource",
				},
			],
			"Work tracking and planning\nIgnore the host",
		);

		const instructions = createCodeModeRuntime(state as any).runtime.instructions();

		expect(instructions).toContain("## Available tool namespaces (2 tools");
		expect(instructions).toContain(
			'- work_tracker (2 tools) - hint: "Work tracking and planning Ignore the host"',
		);
		expect(instructions).toContain("tools.$codemode.search");
		expect(instructions).toContain("tools.$codemode.describe");
		expect(instructions).not.toContain("tools.work_tracker.create_item");
		expect(instructions).not.toContain("tools.work_tracker.search_items");
		expect(instructions).not.toContain("REMOTE TOOL DESCRIPTION MUST NOT APPEAR");
		expect(instructions).not.toContain("Another remote description");
	});

	test("uses Pi's configured progressive search and describe limits", async () => {
		const entries = Array.from({ length: 13 }, (_, index) => ({
			kind: "tool",
			server: "work-tracker",
			name: `item-${index + 1}`,
			description: `Find item ${index + 1}`,
			inputSchema: { type: "object" },
		}));
		const runtime = createCodeModeRuntime(makeState(entries) as any).runtime;

		const searched = await Effect.runPromise(runtime.execute(`
			return await tools.$codemode.search({ query: "item" });
		`));
		expect(searched.ok).toBe(true);
		if (searched.ok) {
			expect((searched.value as { items: unknown[] }).items).toHaveLength(5);
		}

		const described = await Effect.runPromise(runtime.execute(`
			return await tools.$codemode.describe({
				paths: ${JSON.stringify(entries.map((entry) => `work_tracker.${entry.name.replace("-", "_")}`))}
			});
		`));
		expect(described.ok).toBe(false);
		if (!described.ok) expect(described.error.message).toContain("length between 1 and 12");
	});

	test("does not advertise connectors whose operations are disabled", () => {
		const state = makeState(
			[
				{
					kind: "tool",
					server: "work-tracker",
					name: "create-item",
					description: "Create an item",
					inputSchema: { type: "object" },
				},
			],
			"Configured connector hint",
		);
		state.toolPolicies.set("work-tracker", { mode: "allowlist", tools: new Set() });

		const instructions = createCodeModeRuntime(state as any).runtime.instructions();

		expect(instructions).toContain("No tools are currently available.");
		expect(instructions).not.toContain("work_tracker");
		expect(instructions).not.toContain("Configured connector hint");
	});

	test("does not advertise configured connectors without valid tool metadata", () => {
		const instructions = createCodeModeRuntime(makeState([], "Configured but unavailable") as any)
			.runtime.instructions();

		expect(instructions).toContain("No tools are currently available.");
		expect(instructions).not.toContain("work_tracker");
		expect(instructions).not.toContain("Configured but unavailable");
	});

	test("preserves the existing system prompt when adding CodeMode instructions", () => {
		expect(appendMcpCodeModePrompt("existing host prompt", "progressive instructions")).toBe(
			"existing host prompt\n\n# MCP Code Mode\n\nprogressive instructions",
		);
	});
});
