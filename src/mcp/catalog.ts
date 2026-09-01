import { createHash } from "node:crypto";
import type { JsonSchema } from "../codemode/tool.js";
import type { McpToolRef, MetadataFreshness } from "./codemode-adapter.js";
import type { ToolPathMapping } from "./tool-tree.js";

export interface CatalogOperation {
	readonly serverId: string;
	readonly wireToolName: string;
	readonly runtimePath: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly outputSchema?: JsonSchema;
}

export interface CatalogConnector {
	readonly serverId: string;
	readonly description?: string;
	readonly metadataFreshness: MetadataFreshness;
	readonly operations: readonly CatalogOperation[];
}

export interface CatalogSnapshot {
	readonly hash: string;
	readonly connectors: readonly CatalogConnector[];
	readonly operations: readonly CatalogOperation[];
}

/** Serialize JSON-compatible values deterministically. */
export function canonicalJson(value: unknown): string {
	const ancestors = new Set<object>();
	const serialize = (item: unknown, inArray: boolean): string | undefined => {
		if (item === null || typeof item !== "object") {
			const serialized = JSON.stringify(item);
			return serialized === undefined && inArray ? "null" : serialized;
		}
		if (ancestors.has(item)) throw new TypeError("Cannot canonicalize a cyclic value");
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				return `[${item.map((child) => serialize(child, true) ?? "null").join(",")}]`;
			}
			const record = item as Record<string, unknown>;
			const fields: string[] = [];
			for (const key of Object.keys(record).sort()) {
				const child = serialize(record[key], false);
				if (child !== undefined) fields.push(`${JSON.stringify(key)}:${child}`);
			}
			return `{${fields.join(",")}}`;
		} finally {
			ancestors.delete(item);
		}
	};
	const serialized = serialize(value, false);
	return serialized === undefined ? "undefined" : serialized;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function hashSchema(schema: JsonSchema | undefined): string {
	return sha256(canonicalJson(withoutDescriptions(schema ?? null)));
}

const withoutDescriptions = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(withoutDescriptions);
	if (value !== null && typeof value === "object") {
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, child] of Object.entries(value)) {
			if (key !== "description") result[key] = withoutDescriptions(child);
		}
		return result;
	}
	return value;
};

/**
 * Hash only the executable catalog contract. Presentation descriptions and
 * metadata provenance intentionally do not invalidate executable code.
 */
export function hashCatalog(operations: readonly CatalogOperation[]): string {
	const executable = operations
		.map((operation) => ({
			serverId: operation.serverId,
			wireToolName: operation.wireToolName,
			runtimePath: operation.runtimePath,
			inputSchemaHash: hashSchema(operation.inputSchema),
			...(operation.outputSchema === undefined ? {} : { outputSchemaHash: hashSchema(operation.outputSchema) }),
		}))
		.sort((left, right) =>
			left.serverId.localeCompare(right.serverId) ||
			left.wireToolName.localeCompare(right.wireToolName) ||
			left.runtimePath.localeCompare(right.runtimePath),
		);
	return sha256(canonicalJson(executable));
}

const cloneJson = <T>(value: T): T => {
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	if (value !== null && typeof value === "object") {
		const clone = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value)) clone[key] = cloneJson(item);
		return clone as T;
	}
	return value;
};

const deepFreeze = <T>(value: T): T => {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
};

const identity = (serverId: string, wireToolName: string) => `${serverId}\0${wireToolName}`;

export function buildCatalogSnapshot(
	refs: readonly McpToolRef[],
	mappings: readonly ToolPathMapping[],
): CatalogSnapshot {
	const mappingByIdentity = new Map(
		mappings.map((mapping) => [identity(mapping.serverId, mapping.wireToolName), mapping.runtimePath]),
	);
	const connectors = new Map<string, {
		description?: string;
		metadataFreshness: MetadataFreshness;
		operations: CatalogOperation[];
	}>();

	for (const ref of refs) {
		const runtimePath = mappingByIdentity.get(identity(ref.serverId, ref.wireToolName));
		if (!runtimePath) {
			throw new Error(`Missing runtime mapping for ${ref.serverId}/${ref.wireToolName}`);
		}
		let connector = connectors.get(ref.serverId);
		if (!connector) {
			connector = {
				description: ref.connectorDescription?.trim() || undefined,
				metadataFreshness: ref.metadataFreshness ?? "live",
				operations: [],
			};
			connectors.set(ref.serverId, connector);
		} else if (ref.metadataFreshness === "cached") {
			// Mixed provenance is conservatively reported as cached.
			connector.metadataFreshness = "cached";
		}
		connector.operations.push({
			serverId: ref.serverId,
			wireToolName: ref.wireToolName,
			runtimePath,
			description: ref.description?.trim() || `Call ${ref.serverId}/${ref.wireToolName}`,
			inputSchema: cloneJson(ref.inputSchema),
			...(ref.outputSchema === undefined ? {} : { outputSchema: cloneJson(ref.outputSchema) }),
		});
	}

	const frozenConnectors = [...connectors.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([serverId, connector]) => ({
			serverId,
			...(connector.description === undefined ? {} : { description: connector.description }),
			metadataFreshness: connector.metadataFreshness,
			operations: connector.operations.sort((left, right) =>
				left.wireToolName.localeCompare(right.wireToolName) || left.runtimePath.localeCompare(right.runtimePath),
			),
		}));
	const operations = frozenConnectors.flatMap((connector) => connector.operations);
	return deepFreeze({ hash: hashCatalog(operations), connectors: frozenConnectors, operations });
}
