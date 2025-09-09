import type { TextGenerationStreamOutput } from "@huggingface/inference";
import type OpenAI from "openai";
import type { Stream } from "openai/streaming";

/**
 * Transform a stream of OpenAI.Chat.ChatCompletion into a stream of TextGenerationStreamOutput
 */
export async function* openAIChatToTextGenerationStream(
	completionStream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>
) {
	let generatedText = "";
	let tokenId = 0;

	// Track streamed tool-call argument buffers by index
	const toolArgBuffers: Record<number, { id?: string; name?: string; args: string }> = {};

	// Track parsing of tool-result header (Tool[name] id\n)
	let pendingToolHeader: string | null = null;
	let currentToolName: string | undefined;
	let currentToolId: string | undefined;

	for await (const completion of completionStream) {
		const { choices } = completion;
		const delta = choices?.[0]?.delta ?? {};
		const finishReason = choices?.[0]?.finish_reason;
		const last = finishReason === "stop" || finishReason === "length";

		const roleDelta = (delta as any).role as string | undefined;
		const reasoningContent = (delta as any).reasoning_content as string | undefined;
		const toolCalls = (delta as any).tool_calls as
			| undefined
			| Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string | null; arguments?: string };
			}>;

		// Prepare base output; fill fields conditionally below
		const out: any = {
			token: {
				id: tokenId++,
				text: "",
				logprob: 0,
				special: last ?? false,
			},
			generated_text: null as string | null,
			details: null as any,
		} as TextGenerationStreamOutput;

		// Map GLM-4.5 "reasoning_content" to side-channel
		if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
			(out as any).reasoningDelta = reasoningContent;
		}

		// Handle tool call deltas (streaming function arguments)
		if (toolCalls && toolCalls.length > 0) {
			const deltas = Array.isArray(toolCalls) ? toolCalls : [toolCalls as any];
			const mapped = [] as Array<{ index: number; id?: string; name?: string; argumentsChunk?: string }>;
			for (const c of deltas) {
				const index = typeof c.index === "number" ? c.index : 0;
				const id = c.id || undefined;
				const name = c.function?.name ?? undefined;
				const argChunk = c.function?.arguments ?? undefined;

				// Maintain local buffers for callers to optionally parse later
				const buf = (toolArgBuffers[index] = toolArgBuffers[index] || { args: "" });
				if (id) buf.id = id;
				if (name && name !== null) buf.name = name;
				if (typeof argChunk === "string") buf.args += argChunk;

				mapped.push({ index, id, name, argumentsChunk: argChunk });
			}
			(out as any).toolCallDeltas = mapped;
		}

		// Handle tool results streamed as role: "tool", content: "Tool[name] id\n..."
		if (roleDelta === "tool") {
			let chunk = typeof delta.content === "string" ? (delta.content as string) : "";
			if (pendingToolHeader !== null || !currentToolName) {
				pendingToolHeader = (pendingToolHeader ?? "") + chunk;
				const newlineIndex = pendingToolHeader.indexOf("\n");
				if (newlineIndex !== -1) {
					const header = pendingToolHeader.slice(0, newlineIndex);
					const rest = pendingToolHeader.slice(newlineIndex + 1);
					// Parse header: Tool[name] id
					const m = /^\s*Tool\[([^\]]+)\]\s+(\S+)\s*$/.exec(header);
					if (m) {
						currentToolName = m[1];
						currentToolId = m[2];
					}
					pendingToolHeader = null;
					(out as any).toolResultDelta = {
						name: currentToolName,
						id: currentToolId,
						contentChunk: rest,
					};
				} else {
					// Still waiting for a full header line; do not emit yet
					(out as any).toolResultDelta = {
						name: undefined,
						id: undefined,
						contentChunk: "",
					};
				}
			} else {
				// Header was parsed; stream content chunks
				(out as any).toolResultDelta = {
					name: currentToolName,
					id: currentToolId,
					contentChunk: chunk,
				};
			}
			// For tool role chunks, do not mix into assistant content stream
			yield out;
			continue;
		}

		// Normal assistant content streaming
		const content = typeof delta.content === "string" ? (delta.content as string) : "";
		if (content) {
			generatedText += content;
			(out as any).token.text = content;
			out.generated_text = last ? generatedText : null;
		}

		yield out as TextGenerationStreamOutput;
	}
}

/**
 * Transform a non-streaming OpenAI chat completion into a stream of TextGenerationStreamOutput
 */
export async function* openAIChatToTextGenerationSingle(
	completion: OpenAI.Chat.Completions.ChatCompletion
) {
	const content = completion.choices[0]?.message?.content || "";
	const tokenId = 0;

	// Yield the content as a single token
	yield {
		token: {
			id: tokenId,
			text: content,
			logprob: 0,
			special: false,
		},
		generated_text: content,
		details: null,
	} as TextGenerationStreamOutput;
}
