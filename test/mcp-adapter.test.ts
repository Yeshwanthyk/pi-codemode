import { describe, expect, test, vi } from "vitest";
import { Effect } from "effect";
import { CodeMode } from "../src/codemode/index.js";
import { createMcpAuthorizer, McpAuthorizationDenied } from "../src/mcp/authorization.js";
import {
	buildMcpCodeModeTools,
	type McpClient,
	type McpAuthorizer,
	type McpToolRef,
} from "../src/mcp/codemode-adapter.js";
import { projectMcpResult } from "../src/mcp/result-projector.js";

const schema = {
	type: "object" as const,
	properties: { value: { type: "number", description: "Value to echo" } },
	required: ["value"],
};

const execute = async (refs: McpToolRef[], code: string, authorize: McpAuthorizer = async () => {}) => {
	const built = buildMcpCodeModeTools({ refs, authorize });
	const runtime = CodeMode.make({ tools: built.tools, limits: { timeoutMs: 1_000, maxToolCalls: 20 } });
	const result = await Effect.runPromise(runtime.execute(code) as Effect.Effect<any, never, never>);
	return { result, built, runtime };
};

const ref = (overrides: Partial<McpToolRef> & Pick<McpToolRef, "client">): McpToolRef => ({
	serverId: "github",
	wireToolName: "echo",
	description: "Echo a number",
	inputSchema: schema,
	...overrides,
});

describe("MCP CodeMode adapter", () => {
	test("preserves schemas in the rendered signature and original wire identity at invocation", async () => {
		const callTool = vi.fn(async () => ({ structuredContent: { echoed: 3 } }));
		const { result, built, runtime } = await execute(
			[ref({ serverId: "Git Hub", wireToolName: "echo-value", client: { callTool } })],
			"return await tools.Git_Hub.echo_value({ value: 3 })",
		);

		expect(runtime.catalog()[0]?.signature).toContain("value: number");
		expect(built.mappings).toEqual([
			{ serverId: "Git Hub", wireToolName: "echo-value", runtimePath: "Git_Hub.echo_value" },
		]);
		expect(callTool).toHaveBeenCalledWith("echo-value", { value: 3 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(result).toMatchObject({ ok: true, value: { echoed: 3 } });
		expect(built.catalog.operations[0]).toMatchObject({
			serverId: "Git Hub",
			wireToolName: "echo-value",
			runtimePath: "Git_Hub.echo_value",
		});
	});

	test("resolves normalized server and tool collisions without changing wire names", async () => {
		const calls: string[] = [];
		const client: McpClient = {
			callTool: async (name) => {
				calls.push(name);
				return { content: [{ type: "text", text: name }] };
			},
		};
		const { built } = await execute(
			[
				ref({ serverId: "a-b", wireToolName: "x-y", client }),
				ref({ serverId: "a_b", wireToolName: "x_y", client }),
				ref({ serverId: "a-b", wireToolName: "x_y", client }),
			],
			"return null",
		);
		const paths = built.mappings.map((item) => item.runtimePath);
		expect(new Set(paths).size).toBe(3);
		const wireNames = built.mappings.map((item) => item.wireToolName);
		expect(wireNames).toHaveLength(3);
		expect(new Set(wireNames)).toEqual(new Set(["x-y", "x_y"]));
		expect(calls).toEqual([]);
	});

	test("supports dependent calls and Promise.all across multiple servers", async () => {
		const github: McpClient = {
			callTool: async (_name, input) => ({ structuredContent: { value: Number(input.value) + 1 } }),
		};
		const slack: McpClient = {
			callTool: async (_name, input) => ({ structuredContent: { value: Number(input.value) * 2 } }),
		};
		const { result, built } = await execute(
			[
				ref({ serverId: "github", wireToolName: "increment", client: github }),
				ref({ serverId: "slack", wireToolName: "double", client: slack }),
			],
			`const first = await tools.github.increment({ value: 2 })
const values = await Promise.all([first.value, 5].map(value => tools.slack.double({ value })))
return values.map(item => item.value)`,
		);
		expect(result).toMatchObject({ ok: true, value: [6, 10] });
		expect(built.metadata).toHaveLength(3);
	});

	test("checks authorization before every child call and reports denial safely", async () => {
		const client: McpClient = { callTool: vi.fn(async () => ({ structuredContent: { ok: true } })) };
		const authorize = vi.fn(async ({ wireToolName }: { wireToolName: string }) => {
			if (wireToolName === "denied") throw new McpAuthorizationDenied("github", wireToolName);
		});
		const { result } = await execute(
			[
				ref({ wireToolName: "allowed", client }),
				ref({ wireToolName: "denied", client }),
			],
			`await tools.github.allowed({ value: 1 })
return await tools.github.denied({ value: 2 })`,
			authorize,
		);
		expect(authorize).toHaveBeenCalledTimes(2);
		expect(client.callTool).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
		expect(JSON.stringify(result)).not.toContain("stack");
	});

	test("converts MCP errors into catchable tool failures", async () => {
		const client: McpClient = {
			callTool: async () => ({ isError: true, content: [{ type: "text", text: "rate limited" }] }),
		};
		const { result } = await execute(
			[ref({ client })],
			`try { await tools.github.echo({ value: 1 }); return "missed" } catch (error) { return "caught" }`,
		);
		expect(result).toMatchObject({ ok: true, value: "caught" });
	});

	test("projects structured, text, mixed, and empty results", () => {
		expect(projectMcpResult({ structuredContent: { id: 1 }, content: [{ type: "text", text: "ignored" }] })).toEqual({ id: 1 });
		expect(projectMcpResult({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
		expect(projectMcpResult({ content: [{ type: "text", text: '{"id":1}' }] })).toEqual({ id: 1 });
		expect(projectMcpResult({ content: [{ type: "text", text: '[1,"two"]' }] })).toEqual([1, "two"]);
		expect(projectMcpResult({ content: [{ type: "text", text: "42" }] })).toBe(42);
		expect(projectMcpResult({ content: [{ type: "text", text: "true" }] })).toBe(true);
		expect(projectMcpResult({ content: [{ type: "text", text: "null" }] })).toBeNull();
		expect(projectMcpResult({ content: [{ type: "text", text: '\"decoded\"' }] })).toBe("decoded");
		expect(projectMcpResult({ content: [{ type: "text", text: "{not json}" }] })).toBe("{not json}");
		expect(projectMcpResult({ content: [{ type: "text", text: "hello" }, { type: "image", data: "secret", mimeType: "image/png" }] })).toEqual([
			"hello",
			{ type: "image", mimeType: "image/png", omitted: true },
		]);
		expect(projectMcpResult({ content: [] })).toBeNull();
	});

	test("propagates cancellation before invoking MCP", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const client: McpClient = { callTool: vi.fn(async () => ({ structuredContent: { ok: true } })) };
		const built = buildMcpCodeModeTools({
			refs: [ref({ client })],
			authorize: async () => {},
			signal: controller.signal,
		});
		const runtime = CodeMode.make({ tools: built.tools });
		const result = await Effect.runPromise(
			runtime.execute("return await tools.github.echo({ value: 1 })") as Effect.Effect<any, never, never>,
		);
		expect(client.callTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
	});

	test("fails closed when approval is required but unavailable", async () => {
		const authorize = createMcpAuthorizer({
			isAllowed: () => true,
			requiresApproval: () => true,
		});
		await expect(
			authorize({
				serverId: "db",
				wireToolName: "query",
				input: {},
				signal: new AbortController().signal,
			}),
		).rejects.toBeInstanceOf(McpAuthorizationDenied);
	});
});
