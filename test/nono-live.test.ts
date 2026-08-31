import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { describe, expect, test } from "vitest";

const project = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const profile = `${project}/nono/pi-codemode.profile.json`;
const nono = "/opt/homebrew/bin/nono";

const hasNono = (() => {
	try {
		accessSync(nono, constants.X_OK);
		return true;
	} catch {
		return false;
	}
})();

const run = (program: string, args: string[] = []) =>
	spawnSync(
		nono,
		["run", "--silent", "--profile", profile, "--allow-cwd", "--", program, ...args],
		{ cwd: project, encoding: "utf8", timeout: 45_000 },
	);

const liveTest = hasNono ? test : test.skip;

describe("live Nono outer-session enforcement", () => {
	liveTest("allows the project while denying unrelated files and real credential stores", () => {
		const result = run(process.execPath, [
			"-e",
			`const fs=require("fs");
const check=(path)=>{try{fs.readFileSync(path);return "readable"}catch{return "denied"}};
console.log(JSON.stringify({project:fs.existsSync("package.json"),ssh:check(process.env.HOME+"/.ssh/id_ed25519"),auth:check(process.env.HOME+"/.pi/agent/auth.json"),isolatedConfig:process.env.PI_CODING_AGENT_DIR?.includes("pi-codemode-agent")}));`,
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({
			project: true,
			ssh: "denied",
			auth: "denied",
			isolatedConfig: true,
		});
	});

	liveTest("denies an unapproved destination and permits an approved one", () => {
		const result = run(process.execPath, [
			"-e",
			`Promise.all([
fetch("https://example.com").then(()=>"allowed",()=>"denied"),
fetch("https://registry.npmjs.org/effect",{method:"HEAD"}).then(r=>r.status)
]).then(([unapproved,approved])=>console.log(JSON.stringify({unapproved,approved})))`,
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ unapproved: "denied", approved: 200 });
	});

	liveTest("starts Pi with the extension without reading the host credential store", () => {
		const result = run("pi", ["-e", "./src/index.ts", "--list-models"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("provider");
		expect(result.stdout).toContain("anthropic");
	});
});
