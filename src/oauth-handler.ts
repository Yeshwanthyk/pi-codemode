import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getPiAgentDir } from "./paths.js";

export function getTokensPath(serverName: string): string {
	return join(getPiAgentDir(), "mcp-oauth", serverName, "tokens.json");
}

export function getStoredTokens(serverName: string): OAuthTokens | undefined {
	const tokensPath = getTokensPath(serverName);
	if (!existsSync(tokensPath)) return undefined;

	try {
		const stored = JSON.parse(readFileSync(tokensPath, "utf-8"));
		if (!stored || typeof stored !== "object") return undefined;
		if (typeof stored.access_token !== "string" || stored.access_token.length === 0) {
			return undefined;
		}

		if (typeof stored.expiresAt === "number" && Date.now() > stored.expiresAt) {
			return undefined;
		}

		return {
			access_token: stored.access_token,
			token_type: stored.token_type ?? "bearer",
			refresh_token: stored.refresh_token,
			expires_in: stored.expires_in,
		};
	} catch {
		return undefined;
	}
}

export function saveStoredTokens(
	serverName: string,
	tokens: {
		access_token: string;
		token_type?: string;
		refresh_token?: string;
		expires_in?: number;
	},
): void {
	const path = getTokensPath(serverName);
	mkdirSync(dirname(path), { recursive: true });

	const payload: Record<string, unknown> = {
		access_token: tokens.access_token,
		token_type: tokens.token_type ?? "bearer",
	};

	if (tokens.refresh_token) {
		payload.refresh_token = tokens.refresh_token;
	}

	if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) {
		const expiresIn = Math.floor(tokens.expires_in);
		payload.expires_in = expiresIn;
		payload.expiresAt = Date.now() + expiresIn * 1000;
	}

	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
