import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadMcpConfig } from "../src/config.js";

describe("MCP config", () => {
	test("preserves an optional connector description", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-codemode-config-"));
		const path = join(dir, "mcp.json");
		try {
			writeFileSync(path, JSON.stringify({
				mcpServers: { described_fixture: { command: "fixture-mcp", description: "Fixture operations" } },
			}));
			expect(loadMcpConfig(path).mcpServers.described_fixture?.description).toBe("Fixture operations");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves resolveNpx so Nono can broker the declared launcher", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-codemode-config-"));
		const path = join(dir, "mcp.json");
		try {
			writeFileSync(path, JSON.stringify({
				mcpServers: {
					brokered: { command: "npx", resolveNpx: false, args: ["-y", "mcp-remote", "https://example.invalid/mcp"] },
				},
			}));
			expect(loadMcpConfig(path).mcpServers.brokered?.resolveNpx).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
