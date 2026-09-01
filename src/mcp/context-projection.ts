import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type ContextMessage = ContextEvent["messages"][number];
type ToolResultMessage = Extract<ContextMessage, { role: "toolResult" }>;

type ExecutionView = {
	readonly executionId: string;
	readonly kind: "discovery" | "orchestration" | "snippet";
	readonly ok: boolean;
};

type PairedCall = {
	readonly name: string;
	readonly messageIndex: number;
};

type IndexedExecution = {
	readonly messageIndex: number;
	readonly requestIndex: number;
	readonly message: ToolResultMessage;
	readonly execution: ExecutionView;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const executionView = (details: unknown): ExecutionView | undefined => {
	if (!isRecord(details) || typeof details.executionId !== "string") return undefined;
	if (details.kind !== "discovery" && details.kind !== "orchestration" && details.kind !== "snippet") {
		return undefined;
	}
	if (!isRecord(details.result) || typeof details.result.ok !== "boolean") return undefined;
	return {
		executionId: details.executionId,
		kind: details.kind,
		ok: details.result.ok,
	};
};

const indexToolCalls = (messages: readonly ContextMessage[]): ReadonlyMap<string, PairedCall | null> => {
	const calls = new Map<string, PairedCall | null>();
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (calls.has(block.id)) calls.set(block.id, null);
			else calls.set(block.id, { name: block.name, messageIndex });
		}
	}
	return calls;
};

const indexExecutions = (
	messages: readonly ContextMessage[],
	calls: ReadonlyMap<string, PairedCall | null>,
): IndexedExecution[] => {
	const executions: IndexedExecution[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex];
		if (message?.role !== "toolResult" || message.toolName !== "mcp_execute") continue;
		const call = calls.get(message.toolCallId);
		if (!call || call.name !== "mcp_execute" || call.messageIndex >= messageIndex) continue;
		const execution = executionView(message.details);
		if (!execution) continue;
		executions.push({ messageIndex, requestIndex: call.messageIndex, message, execution });
	}
	return executions;
};

const compactDiscovery = (
	message: ToolResultMessage,
	discoveryExecutionId: string,
	consumerExecutionId: string,
): ToolResultMessage => {
	const { details: _details, ...preserved } = message;
	return {
		...preserved,
		content: [{
			type: "text",
			text: `MCP discovery from execution ${discoveryExecutionId} was consumed by execution ${consumerExecutionId}; detailed signatures omitted from later context.`,
		}],
	};
};

/**
 * Project saved MCP discovery results for one provider request. Consumption is
 * derived from message and tool-call order every time; no session state is kept.
 */
export function compactConsumedDiscoveries(messages: readonly ContextMessage[]): ContextMessage[] {
	const calls = indexToolCalls(messages);
	const executions = indexExecutions(messages, calls);
	const successfulOrchestrations = executions.filter(({ message, execution }) =>
		execution.kind === "orchestration" && execution.ok && message.isError === false,
	);
	const consumedBy = new Map<number, string>();

	for (const discovery of executions) {
		if (
			discovery.execution.kind !== "discovery" ||
			!discovery.execution.ok ||
			discovery.message.isError
		) {
			continue;
		}
		const consumer = successfulOrchestrations
			.filter(({ messageIndex, requestIndex }) =>
				requestIndex > discovery.messageIndex && messageIndex > discovery.messageIndex,
			)
			.sort((left, right) => left.requestIndex - right.requestIndex || left.messageIndex - right.messageIndex)[0];
		if (consumer) consumedBy.set(discovery.messageIndex, consumer.execution.executionId);
	}

	return messages.map((message, messageIndex) => {
		const consumerExecutionId = consumedBy.get(messageIndex);
		if (!consumerExecutionId || message.role !== "toolResult") return message;
		const discovery = executionView(message.details);
		if (!discovery || discovery.kind !== "discovery") return message;
		return compactDiscovery(message, discovery.executionId, consumerExecutionId);
	});
}
