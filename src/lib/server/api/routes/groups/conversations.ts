import { Elysia, error, t } from "elysia";
import { authPlugin } from "$api/authPlugin";
import { collections } from "$lib/server/database";
import { ObjectId } from "mongodb";
import { authCondition, requiresUser } from "$lib/server/auth";
import { models, validateModel, validModelIdSchema } from "$lib/server/models";
import { convertLegacyConversation } from "$lib/utils/tree/convertLegacyConversation";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import {
	MessageReasoningUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { v4 } from "uuid";
import { z } from "zod";

import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
import { usageLimits } from "$lib/server/usageLimits";
import { config } from "$lib/server/config";
import { uploadFile } from "$lib/server/files/uploadFile";
import { isMessageId } from "$lib/utils/tree/isMessageId";
import { buildSubtree } from "$lib/utils/tree/buildSubtree";
import { addChildren } from "$lib/utils/tree/addChildren";
import { addSibling } from "$lib/utils/tree/addSibling";
import { textGeneration } from "$lib/server/textGeneration";
import type { TextGenerationContext } from "$lib/server/textGeneration/types";
import { ERROR_MESSAGES } from "$lib/stores/errors";
import { logger } from "$lib/server/logger";
import { hashConv } from "$lib/utils/hashConv";
import type { SharedConversation } from "$lib/types/SharedConversation";
import { nanoid } from "nanoid";
import { downloadFile } from "$lib/server/files/downloadFile";
import mimeTypes from "mime-types";
import { buildPrompt } from "$lib/buildPrompt";
import { getRequestIp } from "$api/utils/ip";

export const conversationGroup = new Elysia().use(authPlugin).group("/conversations", (app) => {
	return (
		app
			.guard({
				as: "scoped",
				beforeHandle: async ({ locals }) => {
					if (!locals.user?._id && !locals.sessionId) {
						return error(401, "Must have a valid session or user");
					}
				},
			})
			.get(
				"",
				async ({ locals, query }) => {
					const convs = await collections.conversations
						.find(authCondition(locals))
						.project<Pick<Conversation, "_id" | "title" | "updatedAt" | "model">>({
							title: 1,
							updatedAt: 1,
							model: 1,
						})
						.sort({ updatedAt: -1 })
						.skip((query.p ?? 0) * CONV_NUM_PER_PAGE)
						.limit(CONV_NUM_PER_PAGE)
						.toArray();

					const nConversations = await collections.conversations.countDocuments(
						authCondition(locals)
					);

					const res = convs.map((conv) => ({
						_id: conv._id,
						id: conv._id, // legacy param iOS
						title: conv.title,
						updatedAt: conv.updatedAt,
						model: conv.model,
						modelId: conv.model, // legacy param iOS
					}));

					return { conversations: res, nConversations };
				},
				{
					query: t.Object({
						p: t.Optional(t.Number()),
					}),
				}
			)
			.delete("", async ({ locals }) => {
				const res = await collections.conversations.deleteMany({
					...authCondition(locals),
				});
				return res.deletedCount;
			})
			.post("", async ({ locals, request }) => {
				let parsed: unknown;
				const bodyText = await request.text();
				try {
					parsed = JSON.parse(bodyText || "{}");
				} catch {
					throw error(400, "Invalid request");
				}

				const result = z
					.object({
						fromShare: z.string().optional(),
						model: validateModel(models),
						preprompt: z.string().optional(),
					})
					.safeParse(parsed);

				if (!result.success) {
					throw error(400, "Invalid request");
				}

				const values = result.data;

				const convCount = await collections.conversations.countDocuments(authCondition(locals));
				if (usageLimits?.conversations !== undefined && convCount >= usageLimits.conversations) {
					throw error(
						429,
						"You have reached the maximum number of conversations. Delete some to continue."
					);
				}

				const model = models.find((m) => (m.id || m.name) === values.model);
				if (!model) {
					throw error(400, "Invalid model");
				}

				let title = "";
				let messages: Message[] = [
					{
						id: v4(),
						from: "system",
						content: values.preprompt ?? "",
						createdAt: new Date(),
						updatedAt: new Date(),
						children: [],
						ancestors: [],
					},
				];

				let rootMessageId: Message["id"] = messages[0].id;

				if (values.fromShare) {
					const sharedConversation = await collections.sharedConversations.findOne({
						_id: values.fromShare,
					});
					if (!sharedConversation) {
						throw error(404, "Conversation not found");
					}

					title = sharedConversation.title.replace(/<\/?think>/gi, "").trim();
					messages = sharedConversation.messages;
					rootMessageId = sharedConversation.rootMessageId ?? rootMessageId;
					values.model = sharedConversation.model;
					values.preprompt = sharedConversation.preprompt;
				}

				if (model.unlisted) {
					throw error(400, "Can't start a conversation with an unlisted model");
				}

				values.preprompt ??= model.preprompt ?? "";

				if (messages.length > 0 && messages[0].from === "system") {
					messages[0].content = values.preprompt;
				}

				const res = await collections.conversations.insertOne({
					_id: new ObjectId(),
					title: (title || "New Chat").replace(/<\/?think>/gi, "").trim(),
					rootMessageId,
					messages,
					model: values.model,
					preprompt: values.preprompt,
					createdAt: new Date(),
					updatedAt: new Date(),
					userAgent: request.headers.get("user-agent") ?? undefined,
					...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
					...(values.fromShare ? { meta: { fromShareId: values.fromShare } } : {}),
				});

				return new Response(JSON.stringify({ conversationId: res.insertedId.toString() }), {
					headers: { "Content-Type": "application/json" },
				});
			})
			// search endpoint removed
			.group(
				"/:id",
				{
					params: t.Object({
						id: t.String(),
					}),
				},
				(app) => {
					return app
						.derive(async ({ locals, params }) => {
							let conversation;
							let shared = false;

							// if the conver
							if (params.id.length === 7) {
								// shared link of length 7
								conversation = await collections.sharedConversations.findOne({
									_id: params.id,
								});
								shared = true;

								if (!conversation) {
									throw new Error("Conversation not found");
								}
							} else {
								// todo: add validation on params.id
								try {
									new ObjectId(params.id);
								} catch {
									throw new Error("Invalid conversation ID format");
								}
								conversation = await collections.conversations.findOne({
									_id: new ObjectId(params.id),
									...authCondition(locals),
								});

								if (!conversation) {
									const conversationExists =
										(await collections.conversations.countDocuments({
											_id: new ObjectId(params.id),
										})) !== 0;

									if (conversationExists) {
										throw new Error(
											"You don't have access to this conversation. If someone gave you this link, ask them to use the 'share' feature instead."
										);
									}

									throw new Error("Conversation not found.");
								}
							}

							const convertedConv = {
								...conversation,
								...convertLegacyConversation(conversation),
								shared,
							};

							return { conversation: convertedConv };
						})
						.get("", async ({ conversation }) => {
							return {
								messages: conversation.messages,
								title: conversation.title,
								model: conversation.model,
								preprompt: conversation.preprompt,
								rootMessageId: conversation.rootMessageId,
								id: conversation._id.toString(),
								updatedAt: conversation.updatedAt,
								modelId: conversation.model,
								shared: conversation.shared,
							};
						})
						.post("", async ({ request, locals, params }) => {
							const id = z.string().parse(params.id);
							const convId = new ObjectId(id);
							const promptedAt = new Date();

							const userId = locals.user?._id ?? locals.sessionId;
							if (!userId) {
								throw error(401, "Unauthorized");
							}

							const authFilter = { _id: convId, ...authCondition(locals) };
							const convBeforeCheck = await collections.conversations.findOne(authFilter);

							if (convBeforeCheck && !convBeforeCheck.rootMessageId) {
								const res = await collections.conversations.updateOne(
									{ _id: convId },
									{
										$set: {
											...convBeforeCheck,
											...convertLegacyConversation(convBeforeCheck),
										},
									}
								);

								if (!res.acknowledged) {
									throw error(500, "Failed to convert conversation");
								}
							}

							const conv = await collections.conversations.findOne(authFilter);
							if (!conv) {
								throw error(404, "Conversation not found");
							}

							const ip = getRequestIp(request);

							await collections.messageEvents.insertOne({
								type: "message",
								userId,
								createdAt: new Date(),
								expiresAt: new Date(Date.now() + 60_000),
								ip,
							});

							const messagesBeforeLogin = config.MESSAGES_BEFORE_LOGIN
								? parseInt(config.MESSAGES_BEFORE_LOGIN)
								: 0;

							if (!locals.user?._id && requiresUser && messagesBeforeLogin) {
								const totalMessages =
									(
										await collections.conversations
											.aggregate([
												{ $match: { ...authCondition(locals), "messages.from": "assistant" } },
												{ $project: { messages: 1 } },
												{ $limit: messagesBeforeLogin + 1 },
												{ $unwind: "$messages" },
												{ $match: { "messages.from": "assistant" } },
												{ $count: "messages" },
											])
											.toArray()
									)[0]?.messages ?? 0;

								if (totalMessages > messagesBeforeLogin) {
									throw error(429, "Exceeded number of messages before login");
								}
							}

							if (usageLimits?.messagesPerMinute) {
								const now = new Date();
								const nEvents = Math.max(
									await collections.messageEvents.countDocuments({
										userId,
										type: "message",
										expiresAt: { $gt: now },
									}),
									await collections.messageEvents.countDocuments({
										ip,
										type: "message",
										expiresAt: { $gt: now },
									})
								);
								if (nEvents > usageLimits.messagesPerMinute) {
									throw error(429, ERROR_MESSAGES.rateLimited);
								}
							}

							if (usageLimits?.messages && conv.messages.length > usageLimits.messages) {
								throw error(
									429,
									`This conversation has more than ${usageLimits.messages} messages. Start a new one to continue`
								);
							}

							const model = models.find((m) => m.id === conv.model);
							if (!model) {
								throw error(410, "Model not available anymore");
							}

							const form = await request.formData();
							const json = form.get("data");

							if (!json || typeof json !== "string") {
								throw error(400, "Invalid request");
							}

							const {
								inputs: newPrompt,
								id: messageId,
								is_retry: isRetry,
								is_continue: isContinue,
								files: filesFromJson,
							} = z
								.object({
									id: z.string().uuid().refine(isMessageId).optional(),
									inputs: z.optional(
										z
											.string()
											.min(1)
											.transform((s) => s.replace(/\r\n/g, "\n"))
									),
									is_retry: z.optional(z.boolean()),
									is_continue: z.optional(z.boolean()),
									files: z.optional(
										z.array(
											z.object({
												type: z.literal("base64").or(z.literal("hash")),
												name: z.string(),
												value: z.string(),
												mime: z.string(),
											})
										)
									),
								})
								.parse(JSON.parse(json));

							const inputFiles = await Promise.all(
								form
									.getAll("files")
									.filter((entry): entry is File => entry instanceof File && entry.size > 0)
									.map(async (file) => {
										const [type, ...name] = file.name.split(";");
										return {
											type: z.literal("base64").or(z.literal("hash")).parse(type),
											value: await file.text(),
											mime: file.type,
											name: name.join(";"),
										};
									})
							);

							const combinedFiles = [...(filesFromJson ?? []), ...inputFiles];

							if (
								usageLimits?.messageLength &&
								(newPrompt?.length ?? 0) > usageLimits.messageLength
							) {
								throw error(400, "Message too long.");
							}

							const hashFiles = combinedFiles.filter((file) => file.type === "hash");
							const b64Files = combinedFiles
								.filter((file) => file.type !== "hash")
								.map((file) => {
									const blob = Buffer.from(file.value, "base64");
									return new File([blob], file.name, { type: file.mime });
								});

							if (b64Files.some((file) => file.size > 10 * 1024 * 1024)) {
								throw error(413, "File too large, should be <10MB");
							}

							const uploadedFiles = await Promise.all(
								b64Files.map((file) => uploadFile(file, conv))
							).then((files) => [...files, ...hashFiles]);

							let messageToWriteToId: Message["id"] | undefined;
							let messagesForPrompt: Message[] = [];

							if (isContinue && messageId) {
								const message = conv.messages.find((msg) => msg.id === messageId);
								if ((message?.children?.length ?? 0) > 0) {
									throw error(400, "Can only continue the last message");
								}
								messageToWriteToId = messageId;
								messagesForPrompt = buildSubtree(conv, messageId);
							} else if (isRetry && messageId) {
								const messageToRetry = conv.messages.find((message) => message.id === messageId);
								if (!messageToRetry) {
									throw error(404, "Message not found");
								}

								if (messageToRetry.from === "user" && newPrompt) {
									const newUserMessageId = addSibling(
										conv,
										{
											from: "user",
											content: newPrompt,
											files: uploadedFiles,
											createdAt: new Date(),
											updatedAt: new Date(),
										},
										messageId
									);

									messageToWriteToId = addChildren(
										conv,
										{
											from: "assistant",
											content: "",
											createdAt: new Date(),
											updatedAt: new Date(),
										},
										newUserMessageId
									);

									messagesForPrompt = buildSubtree(conv, newUserMessageId);
								} else if (messageToRetry.from === "assistant") {
									messageToWriteToId = addSibling(
										conv,
										{
											from: "assistant",
											content: "",
											createdAt: new Date(),
											updatedAt: new Date(),
										},
										messageId
									);
									messagesForPrompt = buildSubtree(conv, messageId);
									messagesForPrompt.pop();
								}
							} else {
								const newUserMessageId = addChildren(
									conv,
									{
										from: "user",
										content: newPrompt ?? "",
										files: uploadedFiles,
										createdAt: new Date(),
										updatedAt: new Date(),
									},
									messageId
								);

								messageToWriteToId = addChildren(
									conv,
									{
										from: "assistant",
										content: "",
										createdAt: new Date(),
										updatedAt: new Date(),
									},
									newUserMessageId
								);
								messagesForPrompt = buildSubtree(conv, newUserMessageId);
							}

							const messageToWriteTo = conv.messages.find(
								(message) => message.id === messageToWriteToId
							);
							if (!messageToWriteTo) {
								throw error(500, "Failed to create message");
							}
							if (messagesForPrompt.length === 0) {
								throw error(500, "Failed to create prompt");
							}

							await collections.conversations.updateOne(
								{ _id: convId },
								{ $set: { messages: conv.messages, title: conv.title, updatedAt: new Date() } }
							);

							let doneStreaming = false;
							let lastTokenTimestamp: Date | undefined = undefined;

							const stream = new ReadableStream({
								async start(controller) {
									messageToWriteTo.updates ??= [];

									async function update(event: MessageUpdate) {
										if (!messageToWriteTo) {
											throw new Error("No message to write events to");
										}

										if (event.type === MessageUpdateType.Stream) {
											if (event.token === "") return;
											messageToWriteTo.content += event.token;
											if (!lastTokenTimestamp) {
												lastTokenTimestamp = new Date();
											}
											lastTokenTimestamp = new Date();
										} else if (
											event.type === MessageUpdateType.Reasoning &&
											event.subtype === MessageReasoningUpdateType.Stream
										) {
											messageToWriteTo.reasoning ??= "";
											messageToWriteTo.reasoning += event.token;
										} else if (event.type === MessageUpdateType.Title) {
											const sanitizedTitle = event.title.replace(/<\/?think>/gi, "").trim();
											conv.title = sanitizedTitle;
											await collections.conversations.updateOne(
												{ _id: convId },
												{ $set: { title: conv.title, updatedAt: new Date() } }
											);
										} else if (event.type === MessageUpdateType.FinalAnswer) {
											messageToWriteTo.interrupted = event.interrupted;
											messageToWriteTo.content = initialMessageContent + event.text;
										} else if (event.type === MessageUpdateType.File) {
											messageToWriteTo.files = [
												...(messageToWriteTo.files ?? []),
												{ type: "hash", name: event.name, value: event.sha, mime: event.mime },
											];
										} else if (event.type === MessageUpdateType.RouterMetadata) {
											if (model?.isRouter) {
												messageToWriteTo.routerMetadata = {
													route: event.route,
													model: event.model,
												};
											}
										}

										if (
											event.type !== MessageUpdateType.Stream &&
											!(
												event.type === MessageUpdateType.Status &&
												event.status === MessageUpdateStatus.KeepAlive
											) &&
											!(
												event.type === MessageUpdateType.Reasoning &&
												event.subtype === MessageReasoningUpdateType.Stream
											)
										) {
											messageToWriteTo.updates?.push(event);
										}

										if (event.type === MessageUpdateType.Stream) {
											event = { ...event, token: event.token.padEnd(16, "\0") };
										}

										controller.enqueue(JSON.stringify(event) + "\n");

										if (event.type === MessageUpdateType.FinalAnswer) {
											controller.enqueue(" ".repeat(4096));
										}
									}

									await collections.conversations.updateOne(
										{ _id: convId },
										{ $set: { title: conv.title, updatedAt: new Date() } }
									);
									messageToWriteTo.updatedAt = new Date();

									let hasError = false;
									const initialMessageContent = messageToWriteTo.content;

									try {
										const ctx: TextGenerationContext = {
											model,
											endpoint: await model.getEndpoint(),
											conv,
											messages: messagesForPrompt,
											assistant: undefined,
											isContinue: isContinue ?? false,
											promptedAt,
											ip,
											username: locals.user?.username,
											forceMultimodal: Boolean(
												(await collections.settings.findOne(authCondition(locals)))
													?.multimodalOverrides?.[model.id]
											),
										};

										for await (const event of textGeneration(ctx)) {
											await update(event);
										}
									} catch (e) {
										hasError = true;
										await update({
											type: MessageUpdateType.Status,
											status: MessageUpdateStatus.Error,
											message: (e as Error).message,
										});
										logger.error(e);
									} finally {
										if (!hasError && messageToWriteTo.content === initialMessageContent) {
											await update({
												type: MessageUpdateType.Status,
												status: MessageUpdateStatus.Error,
												message: "No output was generated. Something went wrong.",
											});
										}
									}

									await collections.conversations.updateOne(
										{ _id: convId },
										{ $set: { messages: conv.messages, title: conv.title, updatedAt: new Date() } }
									);

									doneStreaming = true;
									controller.close();
								},
								async cancel() {
									if (doneStreaming) return;
									await collections.conversations.updateOne(
										{ _id: convId },
										{ $set: { messages: conv.messages, title: conv.title, updatedAt: new Date() } }
									);
								},
							});

							return new Response(stream, {
								headers: {
									"Content-Type": "application/jsonl",
								},
							});
						})
						.delete("", async ({ locals, params }) => {
							const res = await collections.conversations.deleteOne({
								_id: new ObjectId(params.id),
								...authCondition(locals),
							});

							if (res.deletedCount === 0) {
								throw new Error("Conversation not found");
							}

							return { success: true };
						})
						.get(
							"/output/:sha256",
							async ({ locals, params }) => {
								const sha256 = z.string().parse(params.sha256);
								const userId = locals.user?._id ?? locals.sessionId;
								if (!userId) {
									throw error(401, "Unauthorized");
								}

								let convId: ObjectId | undefined;
								if (params.id.length !== 7) {
									try {
										convId = new ObjectId(params.id);
									} catch {
										throw error(400, "Invalid conversation ID format");
									}

									const conv = await collections.conversations.findOne({
										_id: convId,
										...authCondition(locals),
									});
									if (!conv) {
										throw error(404, "Conversation not found");
									}
								} else {
									const conv = await collections.sharedConversations.findOne({
										_id: params.id,
									});
									if (!conv) {
										throw error(404, "Conversation not found");
									}
								}

								const { value, mime } = await downloadFile(
									sha256,
									params.id.length === 7 ? params.id : convId!
								);
								const buffer = Buffer.from(value, "base64");

								return new Response(buffer, {
									headers: {
										"Content-Type": mime ?? "application/octet-stream",
										"Content-Security-Policy":
											"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
										"Content-Disposition": `attachment; filename="${sha256.slice(0, 8)}.${
											mime ? mimeTypes.extension(mime) || "bin" : "bin"
										}"`,
										"Content-Length": buffer.length.toString(),
										"Accept-Range": "bytes",
									},
								});
							},
							{
								params: t.Object({
									id: t.String(),
									sha256: t.String(),
								}),
							}
						)
						.post(
							"/share",
							async ({ locals, params }) => {
								let convId: ObjectId;
								try {
									convId = new ObjectId(params.id);
								} catch {
									throw error(400, "Invalid conversation ID format");
								}

								const conversation = await collections.conversations.findOne({
									_id: convId,
									...authCondition(locals),
								});
								if (!conversation) {
									throw error(404, "Conversation not found");
								}

								const hash = await hashConv(conversation);
								const existingShare = await collections.sharedConversations.findOne({ hash });
								if (existingShare) {
									return Response.json({ shareId: existingShare._id });
								}

								const shared: SharedConversation = {
									_id: nanoid(7),
									hash,
									createdAt: new Date(),
									updatedAt: new Date(),
									rootMessageId: conversation.rootMessageId,
									messages: conversation.messages,
									title: conversation.title,
									model: conversation.model,
									preprompt: conversation.preprompt,
								};

								await collections.sharedConversations.insertOne(shared);

								const files = await collections.bucket
									.find({ filename: { $regex: `${conversation._id}-` } })
									.toArray();

								await Promise.all(
									files.map(
										(file) =>
											new Promise<void>((resolve, reject) => {
												const newFilename = file.filename.replace(
													`${conversation._id}-`,
													`${shared._id}-`
												);
												const downloadStream = collections.bucket.openDownloadStream(file._id);
												const uploadStream = collections.bucket.openUploadStream(newFilename, {
													metadata: { ...file.metadata, conversation: shared._id.toString() },
												});
												downloadStream.on("error", reject);
												uploadStream.on("error", reject);
												uploadStream.on("finish", resolve);
												downloadStream.pipe(uploadStream);
											})
									)
								);

								return Response.json({ shareId: shared._id });
							},
							{
								params: t.Object({ id: t.String() }),
							}
						)
						.post(
							"/stop-generating",
							async ({ locals, params }) => {
								let convId: ObjectId;
								try {
									convId = new ObjectId(params.id);
								} catch {
									throw error(400, "Invalid conversation ID format");
								}

								const conversation = await collections.conversations.findOne({
									_id: convId,
									...authCondition(locals),
								});
								if (!conversation) {
									throw error(404, "Conversation not found");
								}

								await collections.abortedGenerations.updateOne(
									{ conversationId: convId },
									{ $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
									{ upsert: true }
								);

								return new Response();
							},
							{
								params: t.Object({ id: t.String() }),
							}
						)
						.get(
							"/prompt/:messageId",
							async ({ params, conversation }) => {
								const messageId = params.messageId;
								if (!isMessageId(messageId)) {
									throw error(404, "Message not found");
								}
								const messageIndex = conversation.messages.findIndex((msg) => msg.id === messageId);
								if (messageIndex === -1) {
									throw error(404, "Message not found");
								}

								const model = models.find((m) => m.id === conversation.model);
								if (!model) {
									throw error(404, "Conversation model not found");
								}

								const messagesUpTo = buildSubtree(conversation, messageId);

								let prompt: string;
								try {
									prompt = await buildPrompt({
										preprompt: conversation.preprompt,
										messages: messagesUpTo,
										model,
									});
								} catch (err) {
									logger.error(err);
									prompt = "Prompt generation failed";
								}

								const parameters = { ...(model.parameters ?? {}), return_full_text: false };

								return Response.json({
									prompt,
									model: model.name ?? model.id,
									parameters,
									messages: messagesUpTo.map((msg) => ({
										role: msg.from,
										content: msg.content,
										createdAt: msg.createdAt,
										updatedAt: msg.updatedAt,
										reasoning: msg.reasoning,
										updates: msg.updates?.filter((event) => event.type === MessageUpdateType.Title),
										files: msg.files,
									})),
								});
							},
							{
								params: t.Object({
									id: t.String(),
									messageId: t.String(),
								}),
							}
						)
						.patch(
							"",
							async ({ locals, params, body }) => {
								if (body.model) {
									if (!validModelIdSchema.safeParse(body.model).success) {
										throw new Error("Invalid model ID");
									}
								}

								// Only include defined values in the update (sanitize title)
								const updateValues = {
									...(body.title !== undefined && {
										title: body.title.replace(/<\/?think>/gi, "").trim(),
									}),
									...(body.model !== undefined && { model: body.model }),
								};

								const res = await collections.conversations.updateOne(
									{
										_id: new ObjectId(params.id),
										...authCondition(locals),
									},
									{
										$set: updateValues,
									}
								);

								if (res.modifiedCount === 0) {
									throw new Error("Conversation not found");
								}

								return { success: true };
							},
							{
								body: t.Object({
									title: t.Optional(
										t.String({
											minLength: 1,
											maxLength: 100,
										})
									),
									model: t.Optional(t.String()),
								}),
							}
						)
						.delete(
							"/message/:messageId",
							async ({ locals, params, conversation }) => {
								if (!conversation.messages.map((m) => m.id).includes(params.messageId)) {
									throw new Error("Message not found");
								}

								const filteredMessages = conversation.messages
									.filter(
										(message) =>
											// not the message AND the message is not in ancestors
											!(message.id === params.messageId) &&
											message.ancestors &&
											!message.ancestors.includes(params.messageId)
									)
									.map((message) => {
										// remove the message from children if it's there
										if (message.children && message.children.includes(params.messageId)) {
											message.children = message.children.filter(
												(child) => child !== params.messageId
											);
										}
										return message;
									});

								const res = await collections.conversations.updateOne(
									{ _id: new ObjectId(conversation._id), ...authCondition(locals) },
									{ $set: { messages: filteredMessages } }
								);

								if (res.modifiedCount === 0) {
									throw new Error("Deleting message failed");
								}

								return { success: true };
							},
							{
								params: t.Object({
									id: t.String(),
									messageId: t.String(),
								}),
							}
						);
				}
			)
	);
});
