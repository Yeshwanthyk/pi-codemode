import { describe, expect, test } from "vitest";
import type { McpClient, McpToolRef } from "../src/mcp/codemode-adapter.js";
import {
	buildCatalogSnapshot,
	canonicalJson,
	hashCatalog,
	hashSchema,
} from "../src/mcp/catalog.js";
import { buildToolTree } from "../src/mcp/tool-tree.js";

const client: McpClient = { callTool: async () => ({ content: [] }) };
const ref = (overrides: Partial<McpToolRef> = {}): McpToolRef => ({
	serverId: "github",
	wireToolName: "search-issues",
	description: "Search issues",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	client,
	...overrides,
});

const snapshot = (refs: McpToolRef[]) => {
	const built = buildToolTree(refs, () => ({}) as never);
	return buildCatalogSnapshot(refs, built.mappings);
};

describe("MCP catalog", () => {
	test("canonicalizes object keys recursively and preserves array order", () => {
		expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
			'{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
		);
		expect(hashSchema({ required: ["x"], type: "object" })).toBe(
			hashSchema({ type: "object", required: ["x"] }),
		);
		expect(hashSchema({ type: "string", description: "old" })).toBe(
			hashSchema({ type: "string", description: "new" }),
		);
	});

	test("makes catalog hashes order-independent and excludes descriptions and freshness", () => {
		const first = snapshot([
			ref({ serverId: "z", wireToolName: "two", description: "old", metadataFreshness: "cached" }),
			ref({ serverId: "a", wireToolName: "one" }),
		]);
		const second = snapshot([
			ref({ serverId: "a", wireToolName: "one", description: "changed" }),
			ref({ serverId: "z", wireToolName: "two", description: "new", metadataFreshness: "live" }),
		]);
		expect(first.hash).toBe(second.hash);
		expect(hashCatalog([...first.operations].reverse())).toBe(first.hash);
	});

	test("changes the executable hash for schemas, paths, and wire identities", () => {
		const base = snapshot([ref({ serverId: "a-b" }), ref({ serverId: "a_b" })]);
		const schemaChanged = snapshot([
			ref({ serverId: "a-b", inputSchema: { type: "object", properties: { page: { type: "number" } } } }),
			ref({ serverId: "a_b" }),
		]);
		expect(schemaChanged.hash).not.toBe(base.hash);
		expect(base.operations[0]?.runtimePath).toBe("a_b.search_issues");
		expect(base.operations[1]?.runtimePath).toMatch(/^a_b_[a-f0-9]{8}\.search_issues$/);
	});

	test("deep-freezes a detached snapshot with connector freshness", () => {
		const inputSchema = { type: "object" as const, properties: { query: { type: "string" } } };
		const catalog = snapshot([
			ref({ inputSchema, connectorDescription: "GitHub", metadataFreshness: "cached" }),
		]);
		inputSchema.properties.query.type = "number";

		expect(catalog.connectors[0]).toMatchObject({
			serverId: "github",
			description: "GitHub",
			metadataFreshness: "cached",
		});
		expect(catalog.operations[0]?.inputSchema).toMatchObject({ properties: { query: { type: "string" } } });
		expect(Object.isFrozen(catalog)).toBe(true);
		expect(Object.isFrozen(catalog.connectors)).toBe(true);
		expect(Object.isFrozen(catalog.operations[0]?.inputSchema)).toBe(true);
	});
});
