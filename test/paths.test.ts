import { afterEach, describe, expect, test } from "vitest";
import { getPiAgentDir } from "../src/paths.js";

const original = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = original;
});

describe("Pi config paths", () => {
	test("honors PI_CODING_AGENT_DIR for Nono-isolated state", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-codemode-test-agent";
		expect(getPiAgentDir()).toBe("/tmp/pi-codemode-test-agent");
	});
});
