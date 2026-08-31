import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const serverId = process.argv[2];
if (serverId !== "mcp-alpha" && serverId !== "mcp-beta") {
	process.stderr.write(`fixture: expected mcp-alpha or mcp-beta, received ${String(serverId)}\n`);
	process.exit(64);
}

const markerDir = process.env.MCP_FIXTURE_MARKER_DIR;
if (!markerDir) {
	process.stderr.write("fixture: MCP_FIXTURE_MARKER_DIR is required\n");
	process.exit(64);
}
mkdirSync(markerDir, { recursive: true });

const markerName = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
const markerPath = (name) => join(markerDir, markerName(name));
const mark = (name, value = "1\n") => writeFileSync(markerPath(name), value, "utf8");

const launchesPath = markerPath(`${serverId}.launches`);
let launches = 0;
try {
	launches = Number.parseInt(readFileSync(launchesPath, "utf8"), 10) || 0;
} catch {
	// The first launch has no marker yet.
}
launches += 1;
mark(`${serverId}.launches`, `${launches}\n`);

const inheritedSensitiveVariables = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"SENTRY_AUTH_TOKEN",
	"AWS_SECRET_ACCESS_KEY",
].filter((name) => process.env[name] !== undefined);
mark(`${serverId}.sensitive-env.json`, `${JSON.stringify(inheritedSensitiveVariables)}\n`);

const server = new McpServer(
	{ name: `${serverId}-fixture`, version: "1.0.0" },
	{ instructions: `Deterministic live stdio fixture for ${serverId}` },
);

server.registerTool(
	"identity",
	{
		description: "Return this fixture server's stable identity and launch generation.",
		inputSchema: z.object({}),
		outputSchema: z.object({
			server: z.string(),
			instance: z.string(),
			launches: z.number().int(),
		}),
	},
	async () => ({
		content: [{ type: "text", text: `${serverId} generation ${launches}` }],
		structuredContent: {
			server: serverId,
			instance: `${serverId}-instance-${launches}`,
			launches,
		},
	}),
);

if (serverId === "mcp-alpha") {
	server.registerTool(
		"seed",
		{
			description: "Add one to a number for a dependent cross-server call.",
			inputSchema: z.object({ value: z.number() }),
			outputSchema: z.object({ server: z.string(), value: z.number() }),
		},
		async ({ value }) => ({
			content: [{ type: "text", text: String(value + 1) }],
			structuredContent: { server: serverId, value: value + 1 },
		}),
	);

	server.registerTool(
		"structured-projection",
		{
			description: "Return both MCP content forms so structured content must win projection.",
			inputSchema: z.object({ label: z.string() }),
			outputSchema: z.object({ kind: z.literal("structured"), label: z.string(), server: z.string() }),
		},
		async ({ label }) => ({
			content: [{ type: "text", text: "this text must not be projected" }],
			structuredContent: { kind: "structured", label, server: serverId },
		}),
	);

	server.registerTool(
		"text-projection",
		{
			description: "Return exactly one MCP text content item.",
			inputSchema: z.object({ label: z.string() }),
		},
		async ({ label }) => ({ content: [{ type: "text", text: `text:${serverId}:${label}` }] }),
	);

	server.registerTool(
		"safe-error",
		{
			description: "Return an ordinary MCP isError result with a safe public message.",
			inputSchema: z.object({ code: z.string() }),
		},
		async ({ code }) => ({
			isError: true,
			content: [{ type: "text", text: `fixture-safe-error:${code}` }],
		}),
	);

	server.registerTool(
		"delayed",
		{
			description: "Wait until completion or MCP request cancellation and record both states.",
			inputSchema: z.object({ token: z.string(), delayMs: z.number().int().min(1).max(10_000) }),
			outputSchema: z.object({ completed: z.boolean(), token: z.string() }),
		},
		async ({ token, delayMs }, extra) => {
			const safeToken = markerName(token);
			mark(`${serverId}.delayed.${safeToken}.started`);
			return await new Promise((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer);
					mark(`${serverId}.delayed.${safeToken}.cancelled`);
					reject(extra.signal.reason instanceof Error ? extra.signal.reason : new Error("fixture request cancelled"));
				};
				const timer = setTimeout(() => {
					extra.signal.removeEventListener("abort", onAbort);
					mark(`${serverId}.delayed.${safeToken}.completed`);
					resolve({
						content: [{ type: "text", text: `completed:${token}` }],
						structuredContent: { completed: true, token },
					});
				}, delayMs);
				extra.signal.addEventListener("abort", onAbort, { once: true });
				if (extra.signal.aborted) onAbort();
			});
		},
	);

	server.registerTool(
		"crash",
		{
			description: "Terminate this fixture process after recording a crash marker.",
			inputSchema: z.object({ token: z.string() }),
		},
		async ({ token }) => {
			mark(`${serverId}.crash.${markerName(token)}`);
			process.stderr.write(`fixture: ${serverId} crashing on request\n`);
			setTimeout(() => process.exit(73), 10);
			return await new Promise(() => {});
		},
	);
}

if (serverId === "mcp-beta") {
	server.registerTool(
		"multiply",
		{
			description: "Multiply a number produced by another fixture server.",
			inputSchema: z.object({ value: z.number(), factor: z.number() }),
			outputSchema: z.object({ server: z.string(), value: z.number() }),
		},
		async ({ value, factor }) => ({
			content: [{ type: "text", text: String(value * factor) }],
			structuredContent: { server: serverId, value: value * factor },
		}),
	);

	const batches = new Map();
	server.registerTool(
		"overlap",
		{
			description: "Join a deterministic barrier that only releases once all concurrent callers arrive.",
			inputSchema: z.object({
				batch: z.string(),
				id: z.number().int(),
				participants: z.number().int().min(2).max(8),
			}),
			outputSchema: z.object({ id: z.number().int(), peak: z.number().int(), server: z.string() }),
		},
		async ({ batch, id, participants }, extra) => {
			let state = batches.get(batch);
			if (!state) {
				let release;
				const gate = new Promise((resolve) => {
					release = resolve;
				});
				state = { active: 0, participants, gate, release };
				batches.set(batch, state);
			}
			if (state.participants !== participants) {
				return { isError: true, content: [{ type: "text", text: "participant mismatch" }] };
			}
			state.active += 1;
			if (state.active === state.participants) state.release(state.active);

			const peak = await new Promise((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timeout);
					extra.signal.removeEventListener("abort", onAbort);
				};
				const onAbort = () => {
					cleanup();
					reject(new Error("fixture concurrency barrier cancelled"));
				};
				const timeout = setTimeout(() => {
					cleanup();
					reject(new Error("fixture concurrency barrier timed out"));
				}, 3_000);
				extra.signal.addEventListener("abort", onAbort, { once: true });
				state.gate.then((value) => {
					cleanup();
					resolve(value);
				}, reject);
			});
			state.active -= 1;
			if (state.active === 0) batches.delete(batch);
			return {
				content: [{ type: "text", text: `${id}:${peak}` }],
				structuredContent: { id, peak, server: serverId },
			};
		},
	);
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`fixture: ${serverId} generation ${launches} connected\n`);
