import type { LayoutServerLoad } from "./$types";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { UrlDependency } from "$lib/types/UrlDependency";
import { defaultModel, models, oldModels, validateModel } from "$lib/server/models";
import { authCondition, requiresUser } from "$lib/server/auth";
import { DEFAULT_SETTINGS } from "$lib/types/Settings";
import { config } from "$lib/server/config";
import { ObjectId } from "mongodb";
import type { ConvSidebar } from "$lib/types/ConvSidebar";
import { toolFromConfigs } from "$lib/server/tools";
import { MetricsServer } from "$lib/server/metrics";
import type { ToolFront, ToolInputFile } from "$lib/types/Tool";
import { ReviewStatus } from "$lib/types/Review";
import { base } from "$app/paths";
export const load: LayoutServerLoad = async ({ locals, depends, fetch }) => {
	depends(UrlDependency.ConversationList);

	const settings = await collections.settings.findOne(authCondition(locals));

	// If the active model in settings is not valid, set it to the default model. This can happen if model was disabled.
	if (
		settings &&
		!validateModel(models).safeParse(settings?.activeModel).success
	) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	// if the model is unlisted, set the active model to the default model
	if (
		settings?.activeModel &&
		models.find((m) => m.id === settings?.activeModel)?.unlisted === true
	) {
		settings.activeModel = defaultModel.id;
		await collections.settings.updateOne(authCondition(locals), {
			$set: { activeModel: defaultModel.id },
		});
	}

	const nConversations = await collections.conversations.countDocuments(authCondition(locals));

	const conversations =
		nConversations === 0
			? Promise.resolve([])
			: fetch(`${base}/api/conversations`)
					.then((res) => res.json())
					.then(
						(
							convs: Pick<Conversation, "_id" | "title" | "updatedAt" | "model">[]
						) =>
							convs.map((conv) => ({
								...conv,
								updatedAt: new Date(conv.updatedAt),
							}))
					);

	const messagesBeforeLogin = config.MESSAGES_BEFORE_LOGIN
		? parseInt(config.MESSAGES_BEFORE_LOGIN)
		: 0;

	let loginRequired = false;

	if (requiresUser && !locals.user) {
		if (messagesBeforeLogin === 0) {
			loginRequired = true;
		} else if (nConversations >= messagesBeforeLogin) {
			loginRequired = true;
		} else {
			// get the number of messages where `from === "assistant"` across all conversations.
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

			loginRequired = totalMessages >= messagesBeforeLogin;
		}
	}

	const toolUseDuration = (await MetricsServer.getMetrics().tool.toolUseDuration.get()).values;

	const configToolIds = toolFromConfigs.map((el) => el._id.toString());

	let activeCommunityToolIds = (settings?.tools ?? []).filter(
		(key) => !configToolIds.includes(key)
	);

	const communityTools = await collections.tools
		.find({ _id: { $in: activeCommunityToolIds.map((el) => new ObjectId(el)) } })
		.toArray()
		.then((tools) =>
			tools.map((tool) => ({
				...tool,
				isHidden: false,
				isOnByDefault: true,
				isLocked: true,
			}))
		);

	return {
		nConversations,
		conversations: await conversations.then(
			async (convs) =>
				await Promise.all(
					convs.map(async (conv) => {
						if (settings?.hideEmojiOnSidebar) {
							conv.title = conv.title.replace(/\p{Emoji}/gu, "");
						}

						// remove invalid unicode and trim whitespaces
						conv.title = conv.title.replace(/\uFFFD/gu, "").trimStart();

						return {
							id: conv._id.toString(),
							title: conv.title,
							model: conv.model ?? defaultModel,
							updatedAt: conv.updatedAt,
						} satisfies ConvSidebar;
					})
				)
		),
		settings: {
			searchEnabled: !!(
				config.SERPAPI_KEY ||
				config.SERPER_API_KEY ||
				config.SERPSTACK_API_KEY ||
				config.SEARCHAPI_KEY ||
				config.YDC_API_KEY ||
				config.USE_LOCAL_WEBSEARCH ||
				config.SEARXNG_QUERY_URL ||
				config.BING_SUBSCRIPTION_KEY
			),
			ethicsModalAccepted: !!settings?.ethicsModalAcceptedAt,
			ethicsModalAcceptedAt: settings?.ethicsModalAcceptedAt ?? null,
			activeModel: settings?.activeModel ?? DEFAULT_SETTINGS.activeModel,
			hideEmojiOnSidebar: settings?.hideEmojiOnSidebar ?? false,
			shareConversationsWithModelAuthors:
				settings?.shareConversationsWithModelAuthors ??
				DEFAULT_SETTINGS.shareConversationsWithModelAuthors,
			customPrompts: settings?.customPrompts ?? {},
			tools:
				settings?.tools ??
				toolFromConfigs
					.filter((el) => !el.isHidden && el.isOnByDefault)
					.map((el) => el._id.toString()),
			disableStream: settings?.disableStream ?? DEFAULT_SETTINGS.disableStream,
			directPaste: settings?.directPaste ?? DEFAULT_SETTINGS.directPaste,
		},
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			websiteUrl: model.websiteUrl,
			modelUrl: model.modelUrl,
			tokenizer: model.tokenizer,
			datasetName: model.datasetName,
			datasetUrl: model.datasetUrl,
			displayName: model.displayName,
			description: model.description,
			reasoning: !!model.reasoning,
			logoUrl: model.logoUrl,
			promptExamples: model.promptExamples,
			parameters: model.parameters,
			preprompt: model.preprompt,
			multimodal: model.multimodal,
			multimodalAcceptedMimetypes: model.multimodalAcceptedMimetypes,
			tools: model.tools,
			unlisted: model.unlisted,
			hasInferenceAPI: model.hasInferenceAPI,
		})),
		oldModels,
		tools: [...toolFromConfigs, ...communityTools]
			.filter((tool) => !tool?.isHidden)
			.map(
				(tool) =>
					({
						_id: tool._id.toString(),
						type: tool.type,
						displayName: tool.displayName,
						name: tool.name,
						description: tool.description,
						mimeTypes: (tool.inputs ?? [])
							.filter((input): input is ToolInputFile => input.type === "file")
							.map((input) => (input as ToolInputFile).mimeTypes)
							.flat(),
						isOnByDefault: tool.isOnByDefault ?? true,
						isLocked: tool.isLocked ?? true,
						timeToUseMS:
							toolUseDuration.find(
								(el) => el.labels.tool === tool._id.toString() && el.labels.quantile === 0.9
							)?.value ?? 15_000,
						color: tool.color,
						icon: tool.icon,
					}) satisfies ToolFront
			),
		communityToolCount: await collections.tools.countDocuments({
			type: "community",
			review: ReviewStatus.APPROVED,
		}),
		user: locals.user && {
			id: locals.user._id.toString(),
			username: locals.user.username,
			avatarUrl: locals.user.avatarUrl,
			email: locals.user.email,
			logoutDisabled: locals.user.logoutDisabled,
			isEarlyAccess: locals.user.isEarlyAccess ?? false,
		},
		isAdmin: locals.isAdmin,
		enableCommunityTools: config.COMMUNITY_TOOLS === "true",
		loginRequired,
		loginEnabled: requiresUser,
		guestMode: requiresUser && messagesBeforeLogin > 0,
		publicConfig: config.getPublicConfig(),
	};
};