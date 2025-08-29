import { Elysia } from "elysia";
import { authPlugin } from "../../authPlugin";
import { requiresUser } from "$lib/server/auth";
import { db } from "$lib/server/db";
import { authCondition } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { Client } from "@gradio/client";
import yazl from "yazl";
import { downloadFile } from "$lib/server/files/downloadFile";
import mimeTypes from "mime-types";
import { logger } from "$lib/server/logger";

export interface FeatureFlags {
	enableAssistants: boolean;
	loginEnabled: boolean;
	loginRequired: boolean;
	guestMode: boolean;
	isAdmin: boolean;
}

export type ApiReturnType = Awaited<ReturnType<typeof Client.prototype.view_api>>;

export const misc = new Elysia()
	.use(authPlugin)
	.get("/public-config", async () => config.getPublicConfig())
	.get("/feature-flags", async ({ locals }) => {
		let loginRequired = false;
		const messagesBeforeLogin = config.MESSAGES_BEFORE_LOGIN
			? parseInt(config.MESSAGES_BEFORE_LOGIN)
			: 0;
		const nConversations = await db.conversations.countForLocals(locals);

		if (requiresUser && !locals.user) {
			if (messagesBeforeLogin === 0) {
				loginRequired = true;
			} else if (nConversations >= messagesBeforeLogin) {
				loginRequired = true;
			} else {
				// get the number of messages where `from === "assistant"` across all conversations.
				const totalMessages = await db.conversations.countAssistantMessagesForLocals(
					locals,
					messagesBeforeLogin
				);

				loginRequired = totalMessages >= messagesBeforeLogin;
			}
		}

		return {
			enableAssistants: config.ENABLE_ASSISTANTS === "true",
			loginEnabled: requiresUser, // misnomer, this is actually whether the feature is available, not required
			loginRequired,
			guestMode: requiresUser && messagesBeforeLogin > 0,
			isAdmin: locals.isAdmin,
		} satisfies FeatureFlags;
	})
	.get("/spaces-config", async ({ query }) => {
		if (config.COMMUNITY_TOOLS !== "true") {
			throw new Error("Community tools are not enabled");
		}

		const space = query.space;

		if (!space) {
			throw new Error("Missing space");
		}

		// Extract namespace from space URL or use as-is if it's already in namespace format
		let namespace = null;
		if (space.startsWith("https://huggingface.co/spaces/")) {
			namespace = space.split("/").slice(-2).join("/");
		} else if (space.match(/^[^/]+\/[^/]+$/)) {
			namespace = space;
		}

		if (!namespace) {
			throw new Error("Invalid space name. Specify a namespace or a full URL on huggingface.co.");
		}

		try {
			const api = await (await Client.connect(namespace)).view_api();
			return api as ApiReturnType;
		} catch (e) {
			throw new Error("Error fetching space API. Is the name correct?");
		}
	})
	.get("/export", async ({ locals }) => {
		if (!locals.user) {
			throw new Error("Not logged in");
		}

		if (!locals.isAdmin) {
			throw new Error("Not admin");
		}

		if (config.ENABLE_DATA_EXPORT !== "true") {
			throw new Error("Data export is not enabled");
		}

		const nExports = await db.messageEvents.countUnexpiredByUserAndType(locals.user._id, "export");

		if (nExports >= 1) {
			throw new Error(
				"You have already exported your data recently. Please wait 1 hour before exporting again."
			);
		}

		const stats: { nConversations: number; nMessages: number; nFiles: number } = {
			nConversations: 0,
			nMessages: 0,
			nFiles: 0,
		};

		const zipfile = new yazl.ZipFile();

		const promises = [
			(await db.raw()).conversations
				.find({ ...authCondition(locals) })
				.toArray()
				.then(async (conversations) => {
					const formattedConversations = await Promise.all(
						conversations.map(async (conversation) => {
							stats.nConversations++;
							const hashes: string[] = [];
							conversation.messages.forEach(async (message) => {
								stats.nMessages++;
								if (message.files) {
									message.files.forEach((file) => {
										hashes.push(file.value);
									});
								}
							});
							const files = await Promise.all(
								hashes.map(async (hash) => {
									try {
										const fileData = await downloadFile(hash, conversation._id);
										return fileData;
									} catch {
										return null;
									}
								})
							);

							const filenames: string[] = [];
							files.forEach((file) => {
								if (!file) return;

								const extension = mimeTypes.extension(file.mime) || null;
								const convId = conversation._id.toString();
								const fileId = file.name.split("-")[1].slice(0, 8);
								const fileName = `file-${convId}-${fileId}` + (extension ? `.${extension}` : "");
								filenames.push(fileName);
								zipfile.addBuffer(Buffer.from(file.value, "base64"), fileName);
								stats.nFiles++;
							});

							return {
								...conversation,
								messages: conversation.messages.map((message) => {
									return {
										...message,
										files: filenames,
										updates: undefined,
									};
								}),
							};
						})
					);

					zipfile.addBuffer(
						Buffer.from(JSON.stringify(formattedConversations, null, 2)),
						"conversations.json"
					);
				}),
			db.assistants
				.findByCreatorId(locals.user._id)
				.then(async (assistants) => {
					const formattedAssistants = await Promise.all(
						assistants.map(async (assistant) => {
							if (assistant.avatar) {

								const content = await db.files.getAssistantAvatarBuffer(assistant._id);

								if (!content) return;

								zipfile.addBuffer(content, `avatar-${assistant._id.toString()}.jpg`);
								stats.nAvatars++;
							}

							stats.nAssistants++;

							return {
								_id: assistant._id.toString(),
								name: assistant.name,
								createdById: assistant.createdById.toString(),
								createdByName: assistant.createdByName,
								avatar: `avatar-${assistant._id.toString()}.jpg`,
								modelId: assistant.modelId,
								preprompt: assistant.preprompt,
								description: assistant.description,
								dynamicPrompt: assistant.dynamicPrompt,
								exampleInputs: assistant.exampleInputs,
								generateSettings: assistant.generateSettings,
								createdAt: assistant.createdAt.toISOString(),
								updatedAt: assistant.updatedAt.toISOString(),
							};
						})
					);

					zipfile.addBuffer(
						Buffer.from(JSON.stringify(formattedAssistants, null, 2)),
						"assistants.json"
					);
				}),
		];

		Promise.all(promises).then(async () => {
			logger.info(
				{
					userId: locals.user?._id,
					...stats,
				},
				"Exported user data"
			);
			zipfile.end();
			if (locals.user?._id) {
				await db.messageEvents.insertExportEvent(locals.user._id);
			}
		});

		// @ts-expect-error - zipfile.outputStream is not typed correctly
		return new Response(zipfile.outputStream, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": 'attachment; filename="export.zip"',
			},
		});
	});
