import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Pi's effective config directory, honoring the host's documented override. */
export function getPiAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolve(configured) : join(homedir(), ".pi", "agent");
}
