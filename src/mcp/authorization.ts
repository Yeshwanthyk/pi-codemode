import type { McpAuthorizationRequest, McpAuthorizer } from "./codemode-adapter.js";

export class McpAuthorizationDenied extends Error {
	constructor(
		readonly serverId: string,
		readonly wireToolName: string,
		message = `MCP tool is not authorized: ${serverId}/${wireToolName}`,
	) {
		super(message);
		this.name = "McpAuthorizationDenied";
	}
}

export interface McpAuthorizationPolicy {
	isAllowed(serverId: string, wireToolName: string): boolean;
	requiresApproval?(serverId: string, wireToolName: string): boolean;
	requestApproval?(request: McpAuthorizationRequest): Promise<boolean>;
}

/**
 * Builds the host-side authorization boundary used by every generated CodeMode tool.
 * Approval prompts are serialized so Promise.all fan-out cannot overlap interactive UI.
 */
export function createMcpAuthorizer(policy: McpAuthorizationPolicy): McpAuthorizer {
	let approvalQueue = Promise.resolve();
	return async (request) => {
		request.signal.throwIfAborted();
		if (!policy.isAllowed(request.serverId, request.wireToolName)) {
			throw new McpAuthorizationDenied(request.serverId, request.wireToolName);
		}
		if (!policy.requiresApproval?.(request.serverId, request.wireToolName)) return;
		if (!policy.requestApproval) {
			throw new McpAuthorizationDenied(
				request.serverId,
				request.wireToolName,
				`MCP approval is required but unavailable: ${request.serverId}/${request.wireToolName}`,
			);
		}

		let release!: () => void;
		const previous = approvalQueue;
		approvalQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			request.signal.throwIfAborted();
			if (!(await policy.requestApproval(request))) {
				throw new McpAuthorizationDenied(
					request.serverId,
					request.wireToolName,
					`User denied MCP call: ${request.serverId}/${request.wireToolName}`,
				);
			}
		} finally {
			release();
		}
	};
}
