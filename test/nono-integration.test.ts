import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const loadProfile = async () =>
	JSON.parse(
		await readFile(new URL("../nono/pi-codemode.profile.json", import.meta.url), "utf8"),
	) as {
		workdir: { access: string };
		groups: { include: string[] };
		filesystem: { read: string[]; deny: string[] };
		network: { network_profile: string; allow_domain: string[]; credentials: string[] };
		environment: { set_vars: Record<string, string> };
	};

describe("Nono outer-session profile", () => {
	test("grants the project and Node runtime while denying direct credential files", async () => {
		const profile = await loadProfile();
		expect(profile.workdir.access).toBe("readwrite");
		expect(profile.groups.include).toContain("node_runtime");
		expect(profile.filesystem.read).toContain("$HOME/.pi/pi-codemode");
		expect(profile.filesystem.deny).toContain("$HOME/.pi/agent/auth.json");
		expect(profile.filesystem.deny).toContain("$HOME/.pi/agent/mcp-oauth");
		expect(profile.environment.set_vars.PI_CODING_AGENT_DIR).toBe("$TMPDIR/pi-codemode-agent");
	});

	test("uses an allowlisted network profile and brokered model credentials", async () => {
		const profile = await loadProfile();
		expect(profile.network.network_profile).toBe("minimal");
		expect(profile.network.allow_domain).toEqual([
			"api.githubcopilot.com",
			"mcp.sentry.dev",
			"mcp.linear.app",
			"registry.npmjs.org",
		]);
		expect(profile.network.credentials).toEqual(expect.arrayContaining(["openai", "anthropic"]));
	});
});
