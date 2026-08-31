import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CodeMode } from "../src/codemode/index.js";
import type { JsonSchema } from "../src/codemode/tool.js";
import { createMcpAuthorizer } from "../src/mcp/authorization.js";
import {
	buildMcpCodeModeTools,
	type McpClient,
	type McpToolRef,
} from "../src/mcp/codemode-adapter.js";
import type { McpCallResult } from "../src/mcp/result-projector.js";
import { McpServerManager } from "../src/server-manager.js";
import type { ServerEntry } from "../src/types.js";

const ALPHA = "mcp-alpha";
const BETA = "mcp-beta";
const wrapper = (name: typeof ALPHA | typeof BETA) =>
	process.env.NONO_BROKERED_MCP_FIXTURES === "1"
		? name
		: fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const asJsonSchema = (schema: unknown): JsonSchema =>
	schema !== null && typeof schema === "object" && !Array.isArray(schema)
		? (schema as JsonSchema)
		: { type: "object", additionalProperties: true };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface LiveHarness {
	built: ReturnType<typeof buildMcpCodeModeTools>;
	runtime: CodeMode.Runtime<never>;
	path(serverId: string, wireToolName: string): string;
}

const listedHarness = (
	manager: McpServerManager,
	serverIds: readonly string[],
	signal?: AbortSignal,
): LiveHarness => {
	const refs: McpToolRef[] = [];
	for (const serverId of serverIds) {
		const listed = manager.getConnection(serverId);
		if (!listed) throw new Error(`Expected a live listed connection for ${serverId}`);

		const client: McpClient = {
			callTool: async (wireToolName, input, options) => {
				const current = manager.getConnection(serverId);
				if (!current) throw new Error(`MCP server is not connected: ${serverId}`);
				manager.touch(serverId);
				manager.incrementInFlight(serverId);
				try {
					return (await current.client.callTool(
						{ name: wireToolName, arguments: input },
						undefined,
						{ signal: options.signal, timeout: options.timeout },
					)) as unknown as McpCallResult;
				} finally {
					manager.decrementInFlight(serverId);
					manager.touch(serverId);
				}
			},
		};

		for (const tool of listed.tools) {
			refs.push({
				serverId,
				wireToolName: tool.name,
				description: tool.description,
				inputSchema: asJsonSchema(tool.inputSchema),
				outputSchema: tool.outputSchema === undefined ? undefined : asJsonSchema(tool.outputSchema),
				client,
				timeout: 5_000,
			});
		}
	}

	const allowed = new Set(refs.map((ref) => `${ref.serverId}\0${ref.wireToolName}`));
	const authorize = createMcpAuthorizer({
		isAllowed: (serverId, wireToolName) => allowed.has(`${serverId}\0${wireToolName}`),
	});
	const built = buildMcpCodeModeTools({ refs, authorize, signal });
	const runtime = CodeMode.make({
		tools: built.tools,
		limits: { timeoutMs: 6_000, maxToolCalls: 20, maxOutputBytes: 16 * 1024 },
	}) as CodeMode.Runtime<never>;

	return {
		built,
		runtime,
		path: (serverId, wireToolName) => {
			const mapping = built.mappings.find(
				(candidate) => candidate.serverId === serverId && candidate.wireToolName === wireToolName,
			);
			if (!mapping) throw new Error(`No listed runtime mapping for ${serverId}/${wireToolName}`);
			return mapping.runtimePath;
		},
	};
};

const execute = (harness: LiveHarness, code: string) =>
	Effect.runPromise(harness.runtime.execute(code) as Effect.Effect<CodeMode.Result, never, never>);

describe("live stdio MCP integration", () => {
	let markerDir: string;
	let manager: McpServerManager;
	let definitions: Record<typeof ALPHA | typeof BETA, ServerEntry>;

	beforeEach(async () => {
		markerDir = await mkdtemp(
			join(process.env.MCP_FIXTURE_MARKER_ROOT ?? tmpdir(), "pi-codemode-live-mcp-"),
		);
		manager = new McpServerManager();
		definitions = {
			[ALPHA]: {
				command: wrapper(ALPHA),
				cwd:
					process.env.NONO_BROKERED_MCP_FIXTURES === "1"
						? process.env.MCP_FIXTURE_MARKER_ROOT
						: undefined,
				debug: process.env.NONO_BROKERED_MCP_FIXTURES === "1",
				env: { MCP_FIXTURE_MARKER_DIR: markerDir },
			},
			[BETA]: {
				command: wrapper(BETA),
				cwd:
					process.env.NONO_BROKERED_MCP_FIXTURES === "1"
						? process.env.MCP_FIXTURE_MARKER_ROOT
						: undefined,
				debug: process.env.NONO_BROKERED_MCP_FIXTURES === "1",
				env: { MCP_FIXTURE_MARKER_DIR: markerDir },
			},
		};
		await Promise.all([
			manager.connect(ALPHA, definitions[ALPHA]),
			manager.connect(BETA, definitions[BETA]),
		]);
	});

	afterEach(async () => {
		await manager?.closeAll();
		if (markerDir) await rm(markerDir, { recursive: true, force: true });
	});

	const marker = (name: string) => join(markerDir, name);
	const waitForMarker = async (name: string, timeoutMs = 3_000): Promise<string> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				await access(marker(name));
				return await readFile(marker(name), "utf8");
			} catch {
				await sleep(10);
			}
		}
		throw new Error(`Timed out waiting for fixture marker ${name}`);
	};

	test("connects two distinct executable fixtures and derives refs from listed metadata", async () => {
		const alpha = manager.getConnection(ALPHA)!;
		const beta = manager.getConnection(BETA)!;
		expect(alpha.client.getServerVersion()).toMatchObject({ name: "mcp-alpha-fixture", version: "1.0.0" });
		expect(beta.client.getServerVersion()).toMatchObject({ name: "mcp-beta-fixture", version: "1.0.0" });
		expect(alpha.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["identity", "seed", "structured-projection", "text-projection", "safe-error", "delayed", "crash"]),
		);
		expect(beta.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["identity", "multiply", "overlap"]),
		);
		expect(JSON.parse(await readFile(marker("mcp-alpha.sensitive-env.json"), "utf8"))).toEqual([]);
		expect(JSON.parse(await readFile(marker("mcp-beta.sensitive-env.json"), "utf8"))).toEqual([]);

		const harness = listedHarness(manager, [ALPHA, BETA]);
		expect(harness.built.mappings).toHaveLength(alpha.tools.length + beta.tools.length);
		const result = await execute(
			harness,
			`return await Promise.all([
				tools.${harness.path(ALPHA, "identity")}({}),
				tools.${harness.path(BETA, "identity")}({})
			])`,
		);
		expect(result).toMatchObject({
			ok: true,
			value: [
				{ server: ALPHA, instance: "mcp-alpha-instance-1", launches: 1 },
				{ server: BETA, instance: "mcp-beta-instance-1", launches: 1 },
			],
		});
	});

	test("runs dependent calls across the two real MCP clients", async () => {
		const harness = listedHarness(manager, [ALPHA, BETA]);
		const result = await execute(
			harness,
			`const seeded = await tools.${harness.path(ALPHA, "seed")}({ value: 4 })
			return await tools.${harness.path(BETA, "multiply")}({ value: seeded.value, factor: 3 })`,
		);
		expect(result).toMatchObject({ ok: true, value: { server: BETA, value: 15 } });
		expect(harness.built.metadata.map(({ serverId, wireToolName, outcome }) => ({ serverId, wireToolName, outcome }))).toEqual([
			{ serverId: ALPHA, wireToolName: "seed", outcome: "success" },
			{ serverId: BETA, wireToolName: "multiply", outcome: "success" },
		]);
	});

	test("proves Promise.all calls overlap with a server-side barrier instead of wall-clock timing", async () => {
		const harness = listedHarness(manager, [BETA]);
		const overlap = harness.path(BETA, "overlap");
		const result = await execute(
			harness,
			`const ids = [1, 2, 3]
			return await Promise.all(ids.map((id) => tools.${overlap}({ batch: "promise-all", id, participants: 3 })))`,
		);
		expect(result).toMatchObject({
			ok: true,
			value: [
				{ id: 1, peak: 3, server: BETA },
				{ id: 2, peak: 3, server: BETA },
				{ id: 3, peak: 3, server: BETA },
			],
		});
	});

	test("projects structured content before text and projects a lone text item as a string", async () => {
		const harness = listedHarness(manager, [ALPHA]);
		const result = await execute(
			harness,
			`const structured = await tools.${harness.path(ALPHA, "structured-projection")}({ label: "live" })
			const text = await tools.${harness.path(ALPHA, "text-projection")}({ label: "live" })
			return { structured, text }`,
		);
		expect(result).toMatchObject({
			ok: true,
			value: {
				structured: { kind: "structured", label: "live", server: ALPHA },
				text: "text:mcp-alpha:live",
			},
		});
		expect(JSON.stringify(result)).not.toContain("this text must not be projected");
	});

	test("turns MCP isError responses into catchable, stack-free restricted-program errors", async () => {
		const harness = listedHarness(manager, [ALPHA]);
		const safeError = harness.path(ALPHA, "safe-error");
		const caught = await execute(
			harness,
			`try {
				await tools.${safeError}({ code: "E_FIXTURE" })
				return "missed"
			} catch (error) {
				return { name: error.name, message: error.message }
			}`,
		);
		expect(caught).toMatchObject({
			ok: true,
			value: {
				name: "Error",
				message: "MCP mcp-alpha/safe-error failed: fixture-safe-error:E_FIXTURE",
			},
		});
		expect(JSON.stringify(caught)).not.toContain("stack");

		const uncaught = await execute(harness, `return await tools.${safeError}({ code: "E_PUBLIC" })`);
		expect(uncaught).toMatchObject({
			ok: false,
			error: { kind: "ToolFailure", message: "MCP mcp-alpha/safe-error failed: fixture-safe-error:E_PUBLIC" },
		});
		expect(JSON.stringify(uncaught)).not.toContain("stack");
	});

	test("propagates delayed cancellation over MCP and waits for the server cancellation marker", async () => {
		const controller = new AbortController();
		const harness = listedHarness(manager, [ALPHA], controller.signal);
		const execution = execute(
			harness,
			`return await tools.${harness.path(ALPHA, "delayed")}({ token: "cancel-case", delayMs: 5000 })`,
		);
		await waitForMarker("mcp-alpha.delayed.cancel-case.started");
		controller.abort(new DOMException("cancel live MCP call", "AbortError"));

		const result = await execution;
		expect(result).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
		expect(JSON.stringify(result)).not.toContain("stack");
		await waitForMarker("mcp-alpha.delayed.cancel-case.cancelled");
		await expect(access(marker("mcp-alpha.delayed.cancel-case.completed"))).rejects.toThrow();
		expect(manager.getConnection(ALPHA)?.inFlight).toBe(0);
	});

	test("evicts a crashed process, then reconnects that server without restarting the other", async () => {
		const crashedConnection = manager.getConnection(ALPHA);
		const firstHarness = listedHarness(manager, [ALPHA]);
		const crashResult = await execute(
			firstHarness,
			`return await tools.${firstHarness.path(ALPHA, "crash")}({ token: "reconnect-case" })`,
		);
		expect(crashResult).toMatchObject({ ok: false, error: { kind: "ToolFailure" } });
		await waitForMarker("mcp-alpha.crash.reconnect-case");

		const reconnected = await manager.connect(ALPHA, definitions[ALPHA]);
		expect(reconnected).not.toBe(crashedConnection);
		expect(reconnected.client.getServerVersion()).toMatchObject({ name: "mcp-alpha-fixture", version: "1.0.0" });
		const secondHarness = listedHarness(manager, [ALPHA, BETA]);
		const identityResult = await execute(
			secondHarness,
			`return await Promise.all([
				tools.${secondHarness.path(ALPHA, "identity")}({}),
				tools.${secondHarness.path(BETA, "identity")}({})
			])`,
		);
		expect(identityResult).toMatchObject({
			ok: true,
			value: [
				{ server: ALPHA, instance: "mcp-alpha-instance-2", launches: 2 },
				{ server: BETA, instance: "mcp-beta-instance-1", launches: 1 },
			],
		});
		expect(await readFile(marker("mcp-alpha.launches"), "utf8")).toBe("2\n");
		expect(await readFile(marker("mcp-beta.launches"), "utf8")).toBe("1\n");
	}, 15_000);
});
