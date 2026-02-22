import vm from "node:vm";
import util from "node:util";

export interface SandboxLogEntry {
	level: "log" | "info" | "warn" | "error" | "debug";
	message: string;
	timestamp: string;
}

export interface SandboxBindings {
	call: (server: string, tool: string, args?: Record<string, unknown>) => Promise<unknown>;
	readResource: (server: string, uri: string) => Promise<unknown>;
	listTools: (query?: string) => unknown;
	servers: string[];
	tools: Record<string, string[]>;
	resources: Record<string, Array<{ name: string; uri: string; description: string }>>;
}

export interface SandboxExecutionOptions {
	code: string;
	timeoutMs?: number;
	resetState?: boolean;
	bindings: SandboxBindings;
}

export interface SandboxExecutionResult {
	result: unknown;
	logs: SandboxLogEntry[];
}

export class JavaScriptSandboxRuntime {
	private state: Record<string, unknown> = {};

	resetState(): void {
		this.state = {};
	}

	getState(): Record<string, unknown> {
		return this.state;
	}

	async execute(options: SandboxExecutionOptions): Promise<SandboxExecutionResult> {
		if (typeof options.code !== "string" || options.code.trim().length === 0) {
			throw new Error("code must be a non-empty string");
		}

		if (options.resetState) {
			this.resetState();
		}

		const timeoutMs = normalizeTimeout(options.timeoutMs);
		const logs: SandboxLogEntry[] = [];

		const context = vm.createContext({
			Buffer,
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
			setTimeout,
			clearTimeout,
			console: createExecutionConsole(logs),
			__api: {
				...options.bindings,
				state: this.state,
			},
		});

		const wrappedScript = `
(async () => {
  const { call, readResource, listTools, servers, tools, resources, state } = __api;
  ${options.code}
})()
`;

		const executableScript = prepareUserScript(wrappedScript);

		try {
			const compiled = new vm.Script(executableScript, {
				filename: "call-mcp-user-script.js",
			});

			const resultPromise = Promise.resolve(
				compiled.runInContext(context, {
					timeout: Math.min(timeoutMs, 60_000),
					displayErrors: true,
				}),
			);

			const result = await withTimeout(resultPromise, timeoutMs);
			return {
				result: normalizeForJson(result),
				logs,
			};
		} catch (error) {
			(error as Error & { executionLogs?: SandboxLogEntry[] }).executionLogs = logs;
			throw error;
		}
	}
}

export function formatSandboxValue(value: unknown): string {
	const normalized = normalizeForJson(value);
	try {
		return JSON.stringify(normalized, null, 2);
	} catch {
		return util.inspect(normalized, {
			depth: 8,
			maxArrayLength: 300,
			breakLength: 120,
			compact: false,
		});
	}
}

export function formatSandboxError(error: unknown): string {
	const err = error as Error & { executionLogs?: SandboxLogEntry[] };
	return formatSandboxValue({
		ok: false,
		error: {
			name: err?.name || "Error",
			message: err?.message || String(error),
			stack: err?.stack || null,
		},
		logs: Array.isArray(err?.executionLogs) ? err.executionLogs : [],
	});
}

function prepareUserScript(code: string): string {
	if (looksLikeTypeScript(code)) {
		throw new Error(
			"TypeScript syntax detected. call_mcp scripts are JavaScript-only. Remove type annotations and TS-only syntax.",
		);
	}
	return code;
}

function looksLikeTypeScript(code: string): boolean {
	if (/\binterface\s+[A-Za-z_$][\w$]*/.test(code)) return true;
	if (/\btype\s+[A-Za-z_$][\w$]*\s*=/.test(code)) return true;
	if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[^=;\n]+/.test(code)) return true;
	if (/\(\s*[A-Za-z_$][\w$]*\s*:\s*[^,)\n]+/.test(code)) return true;
	if (/\)\s*:\s*[A-Za-z_$][\w$<>,\[\]\s|&]*\s*(?:=>|\{)/.test(code)) return true;
	if (/\bas\s+[A-Za-z_$][\w$<>,\[\]\s|&]*/.test(code)) return true;
	return false;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || timeoutMs === null) {
		return 30_000;
	}
	const numeric = Number(timeoutMs);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		throw new Error("timeoutMs must be a positive number");
	}
	return Math.min(Math.floor(numeric), 300_000);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Execution timed out after ${Math.round(timeoutMs)}ms`));
		}, timeoutMs);
		Promise.resolve(promise).then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function formatLogArg(value: unknown): string {
	if (typeof value === "string") return value;
	return util.inspect(value, {
		depth: 6,
		maxArrayLength: 200,
		breakLength: 120,
		compact: 2,
	});
}

function createExecutionConsole(logs: SandboxLogEntry[]) {
	const push = (level: SandboxLogEntry["level"], args: unknown[]) => {
		logs.push({
			level,
			message: args.map(formatLogArg).join(" "),
			timestamp: new Date().toISOString(),
		});
	};

	return {
		log: (...args: unknown[]) => push("log", args),
		info: (...args: unknown[]) => push("info", args),
		warn: (...args: unknown[]) => push("warn", args),
		error: (...args: unknown[]) => push("error", args),
		debug: (...args: unknown[]) => push("debug", args),
	};
}

function normalizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function") return `[Function ${(value as Function).name || "anonymous"}]`;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (Array.isArray(value)) {
		return value.map((item) => normalizeForJson(item, seen));
	}
	if (typeof value === "object") {
		if (seen.has(value as object)) return "[Circular]";
		seen.add(value as object);
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			out[key] = normalizeForJson(nested, seen);
		}
		return out;
	}
	return value;
}
