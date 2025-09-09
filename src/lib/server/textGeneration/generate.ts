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
import { getOpenAiToolsForMcp } from "$lib/server/mcp/tools";
import type { McpServerConfig } from "$lib/server/mcp/httpClient";
import { callMcpTool } from "$lib/server/mcp/httpClient";
import { randomUUID } from "crypto";

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
    // If MCP servers are configured, attempt a single model-driven tool call first.
    // If a tool is called, we stream Tool updates and return the tool output as the final answer.
    try {
        const serversRaw = (config as any).MCP_SERVERS || "[]";
        let servers: McpServerConfig[] = [];
        try { servers = JSON.parse(serversRaw || "[]"); } catch { servers = []; }
        const mcpEnabled = Array.isArray(servers) && servers.length > 0;

        if (mcpEnabled) {
            const { tools: oaTools, mapping } = await getOpenAiToolsForMcp(servers);
            if (oaTools.length > 0) {
                const { OpenAI } = await import("openai");
                const openai = new OpenAI({
                    apiKey: config.OPENAI_API_KEY || config.HF_TOKEN || "sk-",
                    baseURL: config.OPENAI_BASE_URL || "https://api.openai.com/v1",
                });

                // Prepare OpenAI messages with optional multimodal support
                const mmEnabled = (forceMultimodal ?? false) || model.multimodal;
                const toOA = (msg: EndpointMessage): any => {
                    if (msg.from === "user" && mmEnabled) {
                        const parts: any[] = [{ type: "text", text: msg.content }];
                        for (const f of msg.files ?? []) {
                            if (f.mime.startsWith("image/")) {
                                parts.push({
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${f.mime};base64,${f.value}`,
                                        detail: "auto",
                                    },
                                });
                            }
                        }
                        return { role: msg.from, content: parts };
                    }
                    return { role: msg.from, content: msg.content };
                };

                let messagesOpenAI: any[] = messages.map(toOA);
                const hasSystemMessage = messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system";
                if (hasSystemMessage) {
                    if (preprompt !== undefined) {
                        const userSystemPrompt = messagesOpenAI[0].content || "";
                        messagesOpenAI[0].content = preprompt + (userSystemPrompt ? "\n\n" + userSystemPrompt : "");
                    }
                } else {
                    messagesOpenAI = [{ role: "system", content: preprompt ?? "" }, ...messagesOpenAI];
                }
                if (!model.systemRoleSupported && messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system") {
                    messagesOpenAI[0] = { ...messagesOpenAI[0], role: "user" };
                }

                const parameters = { ...model.parameters, ...assistant?.generateSettings } as any;
                const body: any = {
                    model: (model as any).id ?? model.name,
                    messages: messagesOpenAI,
                    stream: false,
                    ...(parameters?.max_new_tokens !== undefined
                        ? { max_tokens: parameters.max_new_tokens }
                        : {}),
                    stop: parameters?.stop,
                    temperature: parameters?.temperature,
                    top_p: parameters?.top_p,
                    frequency_penalty: parameters?.repetition_penalty,
                    presence_penalty: parameters?.presence_penalty,
                    tools: oaTools,
                    tool_choice: "auto",
                };

                const completion = await openai.chat.completions.create(body);
                const first = completion.choices?.[0];
                const call = first?.message?.tool_calls?.[0];
                if (call?.type === "function" && call.function?.name) {
                    const fnName = call.function.name;
                    const map = (mapping as any)[fnName];

                    const uuid = randomUUID();
                    const parseArgs = (raw: string | null | undefined): any => {
                        if (!raw || !String(raw).trim()) return {};
                        try { return JSON.parse(raw); } catch { return {}; }
                    };
                    const argsObj = parseArgs(call.function.arguments as any);

                    // Emit Tool.Call and ETA updates
                    const toPrimitive = (v: unknown): string | number | boolean | undefined => {
                        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
                        return undefined;
                    };
                    const parametersClean: Record<string, string | number | boolean> = {};
                    if (argsObj && typeof argsObj === "object") {
                        for (const [k, v] of Object.entries(argsObj)) {
                            const p = toPrimitive(v);
                            if (p !== undefined) parametersClean[k] = p;
                        }
                    }

                    yield {
                        type: MessageUpdateType.Tool,
                        subtype: MessageToolUpdateType.Call,
                        uuid,
                        call: { name: fnName, parameters: parametersClean },
                    } as MessageUpdate;

                    // Rough ETA hint for UI progress bar
                    yield {
                        type: MessageUpdateType.Tool,
                        subtype: MessageToolUpdateType.ETA,
                        uuid,
                        eta: 10,
                    } as MessageUpdate;

                    if (!map) {
                        yield {
                            type: MessageUpdateType.Tool,
                            subtype: MessageToolUpdateType.Error,
                            uuid,
                            message: `Unknown MCP function: ${fnName}`,
                        } as MessageUpdate;
                        yield {
                            type: MessageUpdateType.FinalAnswer,
                            text: `Unknown MCP function: ${fnName}`,
                            interrupted: false,
                        } as MessageUpdate;
                        return; // done
                    }

                    try {
                        const server = servers.find((s) => s.name === map.server)!;
                        const out = await callMcpTool(server, map.tool, argsObj);

                        // Emit tool result for the UI panel
                        yield {
                            type: MessageUpdateType.Tool,
                            subtype: MessageToolUpdateType.Result,
                            uuid,
                            result: {
                                status: "success",
                                call: { name: fnName, parameters: parametersClean },
                                outputs: [{ content: out }],
                                display: true,
                            },
                        } as MessageUpdate;

                        // Ask the model to synthesize an answer using the tool output (single follow-up call)
                        const question = messages[messages.length - 1]?.content ?? "";
                        const synthesis = yield* generateFromDefaultEndpoint({
                            messages: [
                                {
                                    from: "user",
                                    content: `Question: ${question}\n\nTool results:\n${out}\n\nUsing only the tool results above, answer the question concisely. If uncertain, say you don't know.`,
                                },
                            ],
                            preprompt: "You are a helpful assistant. Use the provided tool results as the sole source of truth.",
                            generateSettings: { temperature: 0.2, max_new_tokens: 512 },
                            modelId: model.id,
                        });

                        yield {
                            type: MessageUpdateType.FinalAnswer,
                            text: synthesis,
                            interrupted: false,
                        } as MessageUpdate;
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        yield {
                            type: MessageUpdateType.Tool,
                            subtype: MessageToolUpdateType.Error,
                            uuid,
                            message: msg,
                        } as MessageUpdate;

                        yield {
                            type: MessageUpdateType.FinalAnswer,
                            text: `MCP error: ${msg}`,
                            interrupted: false,
                        } as MessageUpdate;
                    }

                    return; // handled by MCP tool path; stop normal LLM stream
                }
                // No tool call selected -> fall through to normal LLM stream
            }
        }
    } catch (e) {
        logger.warn({ err: e }, "MCP tool flow failed; falling back to normal LLM stream");
    }

	// reasoning mode is false by default
	let reasoning = false;
	let reasoningBuffer = "";
	let lastReasoningUpdate = new Date();
	let status = "";
	const startTime = new Date();
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
				webSources: output.webSources,
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
