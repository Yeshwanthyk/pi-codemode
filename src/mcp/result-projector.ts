export interface McpTextContent {
	type: "text";
	text: string;
}

export interface McpImageContent {
	type: "image" | "audio";
	data?: string;
	mimeType?: string;
}

export interface McpResourceContent {
	type: "resource" | "resource_link";
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
	uri?: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export type McpResultContent = McpTextContent | McpImageContent | McpResourceContent | Record<string, unknown>;

export interface McpCallResult {
	isError?: boolean;
	content?: readonly McpResultContent[];
	structuredContent?: unknown;
}

const projectContent = (item: McpResultContent): unknown => {
	if (item.type === "text") return item.text;
	if (item.type === "image" || item.type === "audio") {
		return { type: item.type, mimeType: item.mimeType, omitted: true };
	}
	if (item.type === "resource") {
		const resource = (item as McpResourceContent).resource;
		return {
			type: "resource",
			uri: resource?.uri,
			mimeType: resource?.mimeType,
			...(typeof resource?.text === "string" ? { text: resource.text } : {}),
			...(typeof resource?.blob === "string" ? { blobOmitted: true } : {}),
		};
	}
	if (item.type === "resource_link") {
		const link = item as McpResourceContent;
		return {
			type: "resource_link",
			uri: link.uri,
			name: link.name,
			description: link.description,
			mimeType: link.mimeType,
		};
	}
	return item;
};

const errorText = (result: McpCallResult): string => {
	const text = (result.content ?? [])
		.filter((item): item is McpTextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	return text || "MCP server returned an error";
};

const parseJsonText = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

export function projectMcpResult(result: McpCallResult): unknown {
	if (result.isError) throw new Error(errorText(result));
	if (result.structuredContent !== undefined) return result.structuredContent;
	const content = result.content ?? [];
	if (content.length === 0) return null;
	const single = content[0];
	if (content.length === 1 && single?.type === "text" && typeof single.text === "string") {
		return parseJsonText(single.text);
	}
	return content.map(projectContent);
}
