import { z } from "zod";
import { openAICompletionToTextGenerationStream } from "./openAICompletionToTextGenerationStream";
import {
	openAIChatToTextGenerationSingle,
	openAIChatToTextGenerationStream,
} from "./openAIChatToTextGenerationStream";
import type { CompletionCreateParamsStreaming } from "openai/resources/completions";
import type {
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import { buildPrompt } from "$lib/buildPrompt";
import { config } from "$lib/server/config";
import type { Endpoint } from "../endpoints";
import type OpenAI from "openai";
import { createImageProcessorOptionsValidator, makeImageProcessor } from "../images";
import type { MessageFile } from "$lib/types/Message";
import type { EndpointMessage } from "../endpoints";
// uuid import removed (no tool call ids)
import { callMcpTool, type McpServerConfig } from "$lib/server/mcp/httpClient";
import { getOpenAiToolsForMcp } from "$lib/server/mcp/tools";

export const endpointOAIParametersSchema = z.object({
	weight: z.number().int().positive().default(1),
	model: z.any(),
	type: z.literal("openai"),
	baseURL: z.string().url().default("https://api.openai.com/v1"),
    // Canonical auth token is OPENAI_API_KEY; keep HF_TOKEN as legacy alias
    apiKey: z.string().default(config.OPENAI_API_KEY || config.HF_TOKEN || "sk-"),
	completion: z
		.union([z.literal("completions"), z.literal("chat_completions")])
		.default("chat_completions"),
	defaultHeaders: z.record(z.string()).optional(),
	defaultQuery: z.record(z.string()).optional(),
	extraBody: z.record(z.any()).optional(),
    multimodal: z
        .object({
            image: createImageProcessorOptionsValidator({
                supportedMimeTypes: [
                    // Restrict to the most widely-supported formats
                    "image/png",
                    "image/jpeg",
                ],
                preferredMimeType: "image/jpeg",
                maxSizeInMB: 3,
                maxWidth: 2048,
                maxHeight: 2048,
            }),
        })
        .default({}),
	/* enable use of max_completion_tokens in place of max_tokens */
	useCompletionTokens: z.boolean().default(false),
	streamingSupported: z.boolean().default(true),
});

export async function endpointOai(
	input: z.input<typeof endpointOAIParametersSchema>
): Promise<Endpoint> {
	const {
		baseURL,
		apiKey,
		completion,
		model,
		defaultHeaders,
		defaultQuery,
		multimodal,
		extraBody,
		useCompletionTokens,
		streamingSupported,
	} = endpointOAIParametersSchema.parse(input);

	let OpenAI;
	try {
		OpenAI = (await import("openai")).OpenAI;
	} catch (e) {
		throw new Error("Failed to import OpenAI", { cause: e });
	}

	const openai = new OpenAI({
		apiKey: apiKey || "sk-",
		baseURL,
		defaultHeaders,
		defaultQuery,
	});

	const imageProcessor = makeImageProcessor(multimodal.image);

	if (completion === "completions") {
		return async ({ messages, preprompt, continueMessage, generateSettings, conversationId }) => {
			const prompt = await buildPrompt({
				messages,
				continueMessage,
				preprompt,
				model,
			});

			const parameters = { ...model.parameters, ...generateSettings };
			const body: CompletionCreateParamsStreaming = {
				model: model.id ?? model.name,
				prompt,
				stream: true,
				max_tokens: parameters?.max_new_tokens,
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.repetition_penalty,
				presence_penalty: parameters?.presence_penalty,
			};

			const openAICompletion = await openai.completions.create(body, {
				body: { ...body, ...extraBody },
				headers: {
					"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
					"X-use-cache": "false",
				},
			});

			return openAICompletionToTextGenerationStream(openAICompletion);
		};
    } else if (completion === "chat_completions") {
        return async ({ messages, preprompt, generateSettings, conversationId, isMultimodal }) => {
            // --- MCP single-call hook ---
            try {
                // Enable only if servers are configured
                const serversRaw = (config as any).MCP_SERVERS || "[]";
                let servers: McpServerConfig[] = [];
                try { servers = JSON.parse(serversRaw || "[]"); } catch { servers = []; }
                if (Array.isArray(servers) && servers.length > 0) {
                    const last = messages.at(-1);
                    const isUser = last?.from === "user";
                    const match = isUser
                        ? last.content.match(/^\/mcp\s+([a-z0-9_-]+)\.([a-zA-Z0-9._-]+)(?:\s+([\s\S]*))?$/i)
                        : null;

                    if (match) {
                        const [, serverName, toolName, raw] = match;
                        const server = servers.find((s) => s.name === serverName);
                        if (!server) {
                            const fake = {
                                id: "mcp-error",
                                object: "chat.completion",
                                created: Math.floor(Date.now() / 1000),
                                model: model.id ?? model.name,
                                choices: [
                                    {
                                        index: 0,
                                        finish_reason: "stop",
                                        logprobs: null,
                                        message: { role: "assistant", content: `Unknown MCP server: ${serverName}` },
                                    },
                                ],
                            } as any;
                            return openAIChatToTextGenerationSingle(fake);
                        }

                        let args: unknown = {};
                        if (raw && raw.trim()) {
                            try { args = JSON.parse(raw); }
                            catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                const fake = {
                                    id: "mcp-args-error",
                                    object: "chat.completion",
                                    created: Math.floor(Date.now() / 1000),
                                    model: model.id ?? model.name,
                                    choices: [
                                        {
                                            index: 0,
                                            finish_reason: "stop",
                                            logprobs: null,
                                            message: { role: "assistant", content: `Invalid JSON args: ${msg}` },
                                        },
                                    ],
                                } as any;
                                return openAIChatToTextGenerationSingle(fake);
                            }
                        }

                        let out = "";
                        try {
                            out = await callMcpTool(server, toolName, args);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            const fake = {
                                id: "mcp-call-error",
                                object: "chat.completion",
                                created: Math.floor(Date.now() / 1000),
                                model: model.id ?? model.name,
                                choices: [
                                    {
                                        index: 0,
                                        finish_reason: "stop",
                                        logprobs: null,
                                        message: { role: "assistant", content: `MCP error: ${msg}` },
                                    },
                                ],
                            } as any;
                            return openAIChatToTextGenerationSingle(fake);
                        }

                        const fake = {
                            id: "mcp-ok",
                            object: "chat.completion",
                            created: Math.floor(Date.now() / 1000),
                            model: model.id ?? model.name,
                            choices: [
                                {
                                    index: 0,
                                    finish_reason: "stop",
                                    logprobs: null,
                                    message: { role: "assistant", content: out },
                                },
                            ],
                        } as any;

                        return openAIChatToTextGenerationSingle(fake);
                    }
                }
            } catch {
                // fall through to normal LLM flow
            }
            // --- end MCP hook ---

            // --- MCP model-driven tool-calls ---
            try {
                const serversRaw = (config as any).MCP_SERVERS || "[]";
                let servers: McpServerConfig[] = [];
                try { servers = JSON.parse(serversRaw || "[]"); } catch { servers = []; }
                const mcpEnabled = Array.isArray(servers) && servers.length > 0;

                if (mcpEnabled) {
                    // Build OpenAI-compatible tool defs by querying MCP servers
                    const { tools: oaTools, mapping } = await getOpenAiToolsForMcp(servers);

                    if (oaTools.length > 0) {
                        // Prepare messages (already done below) and create a non-streaming call so we can inspect tool_calls
                        let messagesOpenAI: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
                            await prepareMessages(
                                messages,
                                imageProcessor,
                                isMultimodal ?? model.multimodal
                            );

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
                            messagesOpenAI[0] = { ...messagesOpenAI[0], role: "user" } as any;
                        }

                        const parameters = { ...model.parameters, ...generateSettings };
                        const baseBody = {
                            model: model.id ?? model.name,
                            messages: messagesOpenAI,
                            stream: false,
                            ...(useCompletionTokens
                                ? { max_completion_tokens: parameters?.max_new_tokens }
                                : { max_tokens: parameters?.max_new_tokens }),
                            stop: parameters?.stop,
                            temperature: parameters?.temperature,
                            top_p: parameters?.top_p,
                            frequency_penalty: parameters?.repetition_penalty,
                            presence_penalty: parameters?.presence_penalty,
                        } as any;

                        const bodyWithTools = { ...baseBody, tools: oaTools, tool_choice: "auto" };

                        const completion = await openai.chat.completions.create(
                            bodyWithTools as any,
                            {
                                body: { ...bodyWithTools, ...extraBody },
                                headers: {
                                    "ChatUI-Conversation-ID": conversationId?.toString() ?? "",
                                    "X-use-cache": "false",
                                },
                            }
                        );

                        const call = completion.choices?.[0]?.message?.tool_calls?.[0];
                        if (call?.type === "function" && call.function?.name) {
                            const fnName = call.function.name;
                            const map = mapping[fnName];
                            if (!map) {
                                const fake = {
                                    id: "mcp-map-error",
                                    object: "chat.completion",
                                    created: Math.floor(Date.now() / 1000),
                                    model: model.id ?? model.name,
                                    choices: [
                                        {
                                            index: 0,
                                            finish_reason: "stop",
                                            logprobs: null,
                                            message: { role: "assistant", content: `Unknown MCP function: ${fnName}` },
                                        },
                                    ],
                                } as any;
                                return openAIChatToTextGenerationSingle(fake);
                            }

                            let args: unknown = {};
                            const raw = call.function.arguments ?? "";
                            if (raw && String(raw).trim()) {
                                try { args = JSON.parse(raw); } catch (e) {
                                    const msg = e instanceof Error ? e.message : String(e);
                                    const fake = {
                                        id: "mcp-args-error",
                                        object: "chat.completion",
                                        created: Math.floor(Date.now() / 1000),
                                        model: model.id ?? model.name,
                                        choices: [
                                            {
                                                index: 0,
                                                finish_reason: "stop",
                                                logprobs: null,
                                                message: { role: "assistant", content: `Invalid JSON args: ${msg}` },
                                            },
                                        ],
                                    } as any;
                                    return openAIChatToTextGenerationSingle(fake);
                                }
                            }

                            const server = servers.find((s) => s.name === map.server)!;
                            try {
                                const out = await callMcpTool(server, map.tool, args);
                                const fake = {
                                    id: "mcp-ok",
                                    object: "chat.completion",
                                    created: Math.floor(Date.now() / 1000),
                                    model: model.id ?? model.name,
                                    choices: [
                                        {
                                            index: 0,
                                            finish_reason: "stop",
                                            logprobs: null,
                                            message: { role: "assistant", content: out },
                                        },
                                    ],
                                } as any;
                                return openAIChatToTextGenerationSingle(fake);
                            } catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                const fake = {
                                    id: "mcp-call-error",
                                    object: "chat.completion",
                                    created: Math.floor(Date.now() / 1000),
                                    model: model.id ?? model.name,
                                    choices: [
                                        {
                                            index: 0,
                                            finish_reason: "stop",
                                            logprobs: null,
                                            message: { role: "assistant", content: `MCP error: ${msg}` },
                                        },
                                    ],
                                } as any;
                                return openAIChatToTextGenerationSingle(fake);
                            }
                        }

                        // No tool call: return model content
                        return openAIChatToTextGenerationSingle(completion as any);
                    }
                }
            } catch {
                // fall through to normal flow
            }
            // --- end MCP model-driven tool-calls ---
			// Format messages for the chat API, handling multimodal content if supported
            let messagesOpenAI: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
                await prepareMessages(
                    messages,
                    imageProcessor,
                    isMultimodal ?? model.multimodal
                );

			// Check if a system message already exists as the first message
			const hasSystemMessage = messagesOpenAI.length > 0 && messagesOpenAI[0]?.role === "system";

			if (hasSystemMessage) {
				// System message exists - preserve user configuration
				if (preprompt !== undefined) {
					// Prepend preprompt to existing system message if preprompt exists
					const userSystemPrompt = messagesOpenAI[0].content || "";
					messagesOpenAI[0].content =
						preprompt + (userSystemPrompt ? "\n\n" + userSystemPrompt : "");
				}
				// If no preprompt, user's system message remains unchanged
			} else {
				// No system message exists - create a new one with preprompt or empty string
				messagesOpenAI = [{ role: "system", content: preprompt ?? "" }, ...messagesOpenAI];
			}

			// Handle models that don't support system role by converting to user message
			// This maintains compatibility with older or non-standard models
			if (
				!model.systemRoleSupported &&
				messagesOpenAI.length > 0 &&
				messagesOpenAI[0]?.role === "system"
			) {
				messagesOpenAI[0] = {
					...messagesOpenAI[0],
					role: "user",
				};
			}

			// Tools integration removed

			// Combine model defaults with request-specific parameters
			const parameters = { ...model.parameters, ...generateSettings };
			const body = {
				model: model.id ?? model.name,
				messages: messagesOpenAI,
				stream: streamingSupported,
				// Support two different ways of specifying token limits depending on the model
				...(useCompletionTokens
					? { max_completion_tokens: parameters?.max_new_tokens }
					: { max_tokens: parameters?.max_new_tokens }),
				stop: parameters?.stop,
				temperature: parameters?.temperature,
				top_p: parameters?.top_p,
				frequency_penalty: parameters?.repetition_penalty,
				presence_penalty: parameters?.presence_penalty,
			};

			// Handle both streaming and non-streaming responses with appropriate processors
			if (streamingSupported) {
				const openChatAICompletion = await openai.chat.completions.create(
					body as ChatCompletionCreateParamsStreaming,
					{
						body: { ...body, ...extraBody },
						headers: {
							"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
							"X-use-cache": "false",
						},
					}
				);
				return openAIChatToTextGenerationStream(openChatAICompletion);
			} else {
				const openChatAICompletion = await openai.chat.completions.create(
					body as ChatCompletionCreateParamsNonStreaming,
					{
						body: { ...body, ...extraBody },
						headers: {
							"ChatUI-Conversation-ID": conversationId?.toString() ?? "",
							"X-use-cache": "false",
						},
					}
				);
				return openAIChatToTextGenerationSingle(openChatAICompletion);
			}
		};
	} else {
		throw new Error("Invalid completion type");
	}
}

async function prepareMessages(
	messages: EndpointMessage[],
	imageProcessor: ReturnType<typeof makeImageProcessor>,
	isMultimodal: boolean
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    return Promise.all(
        messages.map(async (message) => {
            if (message.from === "user" && isMultimodal) {
                const parts = [
                    { type: "text" as const, text: message.content },
                    ...(await prepareFiles(imageProcessor, message.files ?? [])),
                ];
                return { role: message.from, content: parts };
            }
            return { role: message.from, content: message.content };
        })
    );
}

async function prepareFiles(
    imageProcessor: ReturnType<typeof makeImageProcessor>,
    files: MessageFile[]
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPartImage[]> {
    const processedFiles = await Promise.all(
        files.filter((file) => file.mime.startsWith("image/")).map(imageProcessor)
    );
    return processedFiles.map((file) => ({
        type: "image_url" as const,
        image_url: {
            url: `data:${file.mime};base64,${file.image.toString("base64")}`,
            // Improves compatibility with some OpenAI-compatible servers
            // that expect an explicit detail setting.
            detail: "auto",
        },
    }));
}
