import { config } from "$lib/server/config";
import {
    MessageReasoningUpdateType,
    MessageUpdateType,
    MessageToolUpdateType,
    type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { AbortedGenerations } from "../abortedGenerations";
import type { TextGenerationContext } from "./types";
import type { EndpointMessage } from "../endpoints/endpoints";
import { generateFromDefaultEndpoint } from "../generateFromDefaultEndpoint";
import { generateSummaryOfReasoning } from "./reasoning";
import { logger } from "../logger";

type GenerateContext = Omit<TextGenerationContext, "messages"> & { messages: EndpointMessage[] };

export async function* generate(
	{
		model,
		endpoint,
		conv,
		messages,
		assistant,
		isContinue,
		promptedAt,
		forceMultimodal,
	}: GenerateContext,
	preprompt?: string
): AsyncIterable<MessageUpdate> {
	// reasoning mode is false by default
	let reasoning = false;
	let reasoningBuffer = "";
	let lastReasoningUpdate = new Date();
	let status = "";
	const startTime = new Date();

	// Track streaming tool-call args by uuid (id or index+name fallback)
	const toolArgBuffers: Record<string, { name?: string; args: string; parsedPublished?: boolean; callPublished?: boolean }> = {};
	if (
		model.reasoning &&
		// if the beginToken is an empty string, the model starts in reasoning mode
		(model.reasoning.type === "regex" ||
			model.reasoning.type === "summarize" ||
			(model.reasoning.type === "tokens" && model.reasoning.beginToken === ""))
	) {
		// if the model has reasoning in regex or summarize mode, it starts in reasoning mode
		// and we extract the answer from the reasoning
		reasoning = true;
		yield {
			type: MessageUpdateType.Reasoning,
			subtype: MessageReasoningUpdateType.Status,
			status: "Started reasoning...",
		};
	}

	for await (const output of await endpoint({
		messages,
		preprompt,
		continueMessage: isContinue,
		generateSettings: assistant?.generateSettings,
		// Allow user-level override to force multimodal
		isMultimodal: (forceMultimodal ?? false) || model.multimodal,
		conversationId: conv._id,
	})) {
		// Map GLM-4.5 reasoning delta if present
		const reasoningDelta = (output as any)?.reasoningDelta as string | undefined;
		if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
			reasoningBuffer += reasoningDelta;
			yield {
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: reasoningDelta,
			};
		}

		// Handle tool call argument streaming
		const toolCallDeltas = (output as any)?.toolCallDeltas as
			| Array<{ index: number; id?: string; name?: string; argumentsChunk?: string }>
			| undefined;
		if (toolCallDeltas && toolCallDeltas.length > 0) {
			for (const d of toolCallDeltas) {
				const uuid = d.id ?? `${d.index}-${d.name ?? "tool"}`;
				const buf = (toolArgBuffers[uuid] = toolArgBuffers[uuid] ?? { args: "" });
				if (d.name) buf.name = d.name;
				if (typeof d.argumentsChunk === "string") buf.args += d.argumentsChunk;

				// Publish initial call update once we know the name
                if (!buf.callPublished && buf.name) {
                    buf.callPublished = true;
                    yield {
                        type: MessageUpdateType.Tool,
                        subtype: MessageToolUpdateType.Call,
                        uuid,
                        call: { name: buf.name!, parameters: {} },
                    } as any;
                }

				// Try to parse JSON arguments to parameters
				if (!buf.parsedPublished) {
                    try {
                        const parsed = JSON.parse(buf.args);
                        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                            buf.parsedPublished = true;
                            yield {
                                type: MessageUpdateType.Tool,
                                subtype: MessageToolUpdateType.Call,
                                uuid,
                                call: { name: buf.name ?? "tool", parameters: parsed as Record<string, unknown> as any },
                            } as any;
                        }
                    } catch {
                        // ignore until JSON is complete
                    }
                }
            }
        }

		// Handle tool result streaming chunks
		const toolResultDelta = (output as any)?.toolResultDelta as
			| { id?: string; name?: string; contentChunk?: string }
			| undefined;
        if (toolResultDelta) {
            const uuid = toolResultDelta.id ?? `${toolResultDelta.name ?? "tool"}-result`;
            const contentChunk = toolResultDelta.contentChunk ?? "";
            if (contentChunk.length > 0) {
                const isError = /(^|\b)(error|failed|exception|traceback)\b/i.test(contentChunk);
                if (isError) {
                    yield {
                        type: MessageUpdateType.Tool,
                        subtype: MessageToolUpdateType.Error,
                        uuid,
                        message: contentChunk,
                    } as any;
                } else {
                    yield {
                        type: MessageUpdateType.Tool,
                        subtype: MessageToolUpdateType.Result,
                        uuid,
                        result: {
                            status: "success",
                            call: { name: toolResultDelta.name ?? "tool", parameters: {}, toolId: toolResultDelta.id },
                            outputs: [{ content: contentChunk }],
                            display: true,
                        },
                    } as any;
                }
            }
        }
		// text generation completed
		if (output.generated_text) {
			let interrupted =
				!output.token.special && !model.parameters.stop?.includes(output.token.text);

			let text = output.generated_text.trimEnd();
			for (const stopToken of model.parameters.stop ?? []) {
				if (!text.endsWith(stopToken)) continue;

				interrupted = false;
				text = text.slice(0, text.length - stopToken.length);
			}

			let finalAnswer = text;
			if (model.reasoning && model.reasoning.type === "regex") {
				const regex = new RegExp(model.reasoning.regex);
				finalAnswer = regex.exec(reasoningBuffer)?.[1] ?? text;
			} else if (model.reasoning && model.reasoning.type === "summarize") {
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status: "Summarizing reasoning...",
				};
				try {
					const summary = yield* generateFromDefaultEndpoint({
						messages: [
							{
								from: "user",
								content: `Question: ${
									messages[messages.length - 1].content
								}\n\nReasoning: ${reasoningBuffer}`,
							},
						],
						preprompt: `Your task is to summarize concisely all your reasoning steps and then give the final answer. Keep it short, one short paragraph at most. If the reasoning steps explicitly include a code solution, make sure to include it in your answer.

If the user is just having a casual conversation that doesn't require explanations, answer directly without explaining your steps, otherwise make sure to summarize step by step, make sure to skip dead-ends in your reasoning and removing excess detail.

Do not use prefixes such as Response: or Answer: when answering to the user.`,
						generateSettings: {
							max_new_tokens: 1024,
						},
						modelId: model.id,
					});
					finalAnswer = summary;
					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Status,
						status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
					};
				} catch (e) {
					finalAnswer = text;
					logger.error(e);
				}
			} else if (model.reasoning && model.reasoning.type === "tokens") {
				// make sure to remove the content of the reasoning buffer from
				// the final answer to avoid duplication

				// if the beginToken is an empty string, we don't need to remove anything
				const beginIndex = model.reasoning.beginToken
					? reasoningBuffer.indexOf(model.reasoning.beginToken)
					: 0;
				const endIndex = reasoningBuffer.lastIndexOf(model.reasoning.endToken);

				if (beginIndex !== -1 && endIndex !== -1) {
					// Remove the reasoning section (including tokens) from final answer
					finalAnswer =
						text.slice(0, beginIndex) + text.slice(endIndex + model.reasoning.endToken.length);
				}
			}

			yield {
				type: MessageUpdateType.FinalAnswer,
				text: finalAnswer,
				interrupted,
			};
			continue;
		}

		if (model.reasoning && model.reasoning.type === "tokens") {
			if (output.token.text === model.reasoning.beginToken) {
				reasoning = true;
				reasoningBuffer += output.token.text;
				continue;
			} else if (output.token.text === model.reasoning.endToken) {
				reasoning = false;
				reasoningBuffer += output.token.text;
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
				};
				continue;
			}
		}
		// ignore special tokens
		if (output.token.special) continue;

		// pass down normal token
		if (reasoning) {
			reasoningBuffer += output.token.text;

			if (model.reasoning && model.reasoning.type === "tokens") {
				// split reasoning buffer so that anything that comes after the end token is separated
				// add it to the normal buffer, and yield two updates, one for the reasoning and one for the normal content
				// also set reasoning to false

				if (reasoningBuffer.lastIndexOf(model.reasoning.endToken) !== -1) {
					const endTokenIndex = reasoningBuffer.lastIndexOf(model.reasoning.endToken);
					const textBuffer = reasoningBuffer.slice(endTokenIndex + model.reasoning.endToken.length);
					reasoningBuffer = reasoningBuffer.slice(
						0,
						endTokenIndex + model.reasoning.endToken.length + 1
					);

					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Stream,
						token: output.token.text,
					};

					yield {
						type: MessageUpdateType.Stream,
						token: textBuffer,
					};

					yield {
						type: MessageUpdateType.Reasoning,
						subtype: MessageReasoningUpdateType.Status,
						status: `Done in ${Math.round((new Date().getTime() - startTime.getTime()) / 1000)}s.`,
					};

					reasoning = false;
					continue;
				}
			}
			// yield status update if it has changed
			if (status !== "") {
				yield {
					type: MessageUpdateType.Reasoning,
					subtype: MessageReasoningUpdateType.Status,
					status,
				};
				status = "";
			}

			// create a new status every 5 seconds
			if (
				config.REASONING_SUMMARY === "true" &&
				new Date().getTime() - lastReasoningUpdate.getTime() > 4000
			) {
				lastReasoningUpdate = new Date();
				try {
					generateSummaryOfReasoning(reasoningBuffer, model.id).then((summary) => {
						status = summary;
					});
				} catch (e) {
					logger.error(e);
				}
			}
			yield {
				type: MessageUpdateType.Reasoning,
				subtype: MessageReasoningUpdateType.Stream,
				token: output.token.text,
			};
		} else {
			yield { type: MessageUpdateType.Stream, token: output.token.text };
		}

		// abort check
		const date = AbortedGenerations.getInstance().getAbortTime(conv._id.toString());

		if (date && date > promptedAt) {
			logger.info(`Aborting generation for conversation ${conv._id}`);
			break;
		}

		// no output check
		if (!output) break;
	}
}
