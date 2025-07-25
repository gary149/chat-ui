import readline from "readline";
import minimist from "minimist";

// @ts-expect-error: vite-node makes the var available but the typescript compiler doesn't see them
import { env } from "$env/dynamic/private";

import { faker } from "@faker-js/faker";
import { ObjectId } from "mongodb";

// @ts-expect-error: vite-node makes the var available but the typescript compiler doesn't see them
import { ready } from "$lib/server/config";
import { collections } from "$lib/server/database.ts";
import { models } from "../src/lib/server/models.ts";
import type { User } from "../src/lib/types/User";
import type { Conversation } from "../src/lib/types/Conversation";
import type { Settings } from "../src/lib/types/Settings";
import type { CommunityToolDB, ToolLogoColor, ToolLogoIcon } from "../src/lib/types/Tool";
import { defaultEmbeddingModel } from "../src/lib/server/embeddingModels.ts";
import { Message } from "../src/lib/types/Message.ts";

import { addChildren } from "../src/lib/utils/tree/addChildren.ts";
import { generateSearchTokens } from "../src/lib/utils/searchTokens.ts";
import { ReviewStatus } from "../src/lib/types/Review.ts";
import fs from "fs";
import path from "path";
import { MessageUpdateType } from "../src/lib/types/MessageUpdate.ts";
import { MessageReasoningUpdateType } from "../src/lib/types/MessageUpdate.ts";

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

await ready;

rl.on("close", function () {
	process.exit(0);
});

const samples = fs.readFileSync(path.join(__dirname, "samples.txt"), "utf8").split("\n---\n");

const possibleFlags = ["reset", "all", "users", "settings", "conversations", "tools"];
const argv = minimist(process.argv.slice(2));
const flags = argv["_"].filter((flag) => possibleFlags.includes(flag));

async function generateMessages(preprompt?: string): Promise<Message[]> {
	const isLinear = faker.datatype.boolean(0.5);
	const isInterrupted = faker.datatype.boolean(0.05);

	const messages: Message[] = [];

	messages.push({
		id: crypto.randomUUID(),
		from: "system",
		content: preprompt ?? "",
		createdAt: faker.date.recent({ days: 30 }),
		updatedAt: faker.date.recent({ days: 30 }),
	});

	let isUser = true;
	let lastId = messages[0].id;
	if (isLinear) {
		const convLength = faker.number.int({ min: 1, max: 25 }) * 2; // must always be even

		for (let i = 0; i < convLength; i++) {
			const hasReasoning = Math.random() < 0.2;
			lastId = addChildren(
				{
					messages,
					rootMessageId: messages[0].id,
				},
				{
					from: isUser ? "user" : "assistant",
					content:
						faker.lorem.sentence({
							min: 10,
							max: isUser ? 50 : 200,
						}) +
						(!isUser && Math.random() < 0.1
							? "\n```\n" + faker.helpers.arrayElement(samples) + "\n```\n"
							: ""),
					createdAt: faker.date.recent({ days: 30 }),
					updatedAt: faker.date.recent({ days: 30 }),
					reasoning: hasReasoning ? faker.lorem.paragraphs(2) : undefined,
					updates: hasReasoning
						? [
								{
									type: MessageUpdateType.Reasoning,
									subtype: MessageReasoningUpdateType.Status,
									uuid: crypto.randomUUID(),
									status: "thinking",
								},
							]
						: [],
					interrupted: !isUser && i === convLength - 1 && isInterrupted,
				},
				lastId
			);
			isUser = !isUser;
		}
	} else {
		const convLength = faker.number.int({ min: 2, max: 200 });

		for (let i = 0; i < convLength; i++) {
			const hasReasoning = Math.random() < 0.2;
			addChildren(
				{
					messages,
					rootMessageId: messages[0].id,
				},
				{
					from: isUser ? "user" : "assistant",
					content:
						faker.lorem.sentence({
							min: 10,
							max: isUser ? 50 : 200,
						}) +
						(!isUser && Math.random() < 0.1
							? "\n```\n" + faker.helpers.arrayElement(samples) + "\n```\n"
							: ""),
					reasoning: hasReasoning ? faker.lorem.paragraphs(2) : undefined,
					updates: hasReasoning
						? [
								{
									type: MessageUpdateType.Reasoning,
									subtype: MessageReasoningUpdateType.Status,
									uuid: crypto.randomUUID(),
									status: "thinking",
								},
							]
						: [],
					createdAt: faker.date.recent({ days: 30 }),
					updatedAt: faker.date.recent({ days: 30 }),
					interrupted: !isUser && i === convLength - 1 && isInterrupted,
				},
				faker.helpers.arrayElement([
					messages[0].id,
					...messages.filter((m) => m.from === (isUser ? "assistant" : "user")).map((m) => m.id),
				])
			);

			isUser = !isUser;
		}
	}
	return messages;
}

async function seed() {
	console.log("Seeding...");
	const modelIds = models.map((model) => model.id);

	if (flags.includes("reset")) {
		console.log("Starting reset of DB");
		await collections.users.deleteMany({});
		await collections.settings.deleteMany({});
		await collections.conversations.deleteMany({});
		await collections.tools.deleteMany({});
		await collections.migrationResults.deleteMany({});
		await collections.semaphores.deleteMany({});
		console.log("Reset done");
	}

	if (flags.includes("users") || flags.includes("all")) {
		console.log("Creating 100 new users");
		const newUsers: User[] = Array.from({ length: 100 }, () => ({
			_id: new ObjectId(),
			createdAt: faker.date.recent({ days: 30 }),
			updatedAt: faker.date.recent({ days: 30 }),
			username: faker.internet.userName(),
			name: faker.person.fullName(),
			hfUserId: faker.string.alphanumeric(24),
			avatarUrl: faker.image.avatar(),
		}));

		await collections.users.insertMany(newUsers);
		console.log("Done creating users.");
	}

	const users = await collections.users.find().toArray();
	if (flags.includes("settings") || flags.includes("all")) {
		console.log("Updating settings for all users");
		users.forEach(async (user) => {
			const settings: Settings = {
				userId: user._id,
				shareConversationsWithModelAuthors: faker.datatype.boolean(0.25),
				hideEmojiOnSidebar: faker.datatype.boolean(0.25),
				ethicsModalAcceptedAt: faker.date.recent({ days: 30 }),
				activeModel: faker.helpers.arrayElement(modelIds),
				createdAt: faker.date.recent({ days: 30 }),
				updatedAt: faker.date.recent({ days: 30 }),
				disableStream: faker.datatype.boolean(0.25),
				directPaste: faker.datatype.boolean(0.25),
				customPrompts: {},
			};
			await collections.settings.updateOne(
				{ userId: user._id },
				{ $set: { ...settings } },
				{ upsert: true }
			);
		});
		console.log("Done updating settings.");
	}


	if (flags.includes("conversations") || flags.includes("all")) {
		console.log("Creating conversations for all users");
		await Promise.all(
			users.map(async (user) => {
				const conversations = faker.helpers.multiple(
					async () => {
						const preprompt = faker.helpers.maybe(() => faker.hacker.phrase(), { probability: 0.5 }) ?? "";

						const messages = await generateMessages(preprompt);

						const conv = {
							_id: new ObjectId(),
							userId: user._id,
							preprompt,
							createdAt: faker.date.recent({ days: 145 }),
							updatedAt: faker.date.recent({ days: 145 }),
							model: faker.helpers.arrayElement(modelIds),
							title: faker.internet.emoji() + " " + faker.hacker.phrase(),
							embeddingModel: defaultEmbeddingModel.id,
							messages,
							rootMessageId: messages[0].id,
						} satisfies Conversation;

						return conv;
					},
					{ count: faker.number.int({ min: 10, max: 200 }) }
				);

				await collections.conversations.insertMany(await Promise.all(conversations));
			})
		);
		console.log("Done creating conversations.");
	}

	// generate Community Tools
	if (flags.includes("tools") || flags.includes("all")) {
		const tools = await Promise.all(
			faker.helpers.multiple(
				() => {
					const _id = new ObjectId();
					const displayName = faker.company.catchPhrase();
					const description = faker.company.catchPhrase();
					const color = faker.helpers.arrayElement([
						"purple",
						"blue",
						"green",
						"yellow",
						"red",
					]) satisfies ToolLogoColor;
					const icon = faker.helpers.arrayElement([
						"wikis",
						"tools",
						"camera",
						"code",
						"email",
						"cloud",
						"terminal",
						"game",
						"chat",
						"speaker",
						"video",
					]) satisfies ToolLogoIcon;
					const baseUrl = faker.helpers.arrayElement([
						"stabilityai/stable-diffusion-3-medium",
						"multimodalart/cosxl",
						"gokaygokay/SD3-Long-Captioner",
						"xichenhku/MimicBrush",
					]);

					// keep empty for populate for now

					const user: User = faker.helpers.arrayElement(users);
					const createdById = user._id;
					const createdByName = user.username ?? user.name;

					return {
						type: "community" as const,
						_id,
						createdById,
						createdByName,
						displayName,
						name: displayName.toLowerCase().replace(" ", "_"),
						endpoint: "/test",
						description,
						color,
						icon,
						baseUrl,
						inputs: [],
						outputPath: null,
						outputType: "str" as const,
						showOutput: false,
						useCount: faker.number.int({ min: 0, max: 100000 }),
						last24HoursUseCount: faker.number.int({ min: 0, max: 1000 }),
						createdAt: faker.date.recent({ days: 30 }),
						updatedAt: faker.date.recent({ days: 30 }),
						searchTokens: generateSearchTokens(displayName),
						review: faker.helpers.enumValue(ReviewStatus),
						outputComponent: null,
						outputComponentIdx: null,
					};
				},
				{ count: faker.number.int({ min: 10, max: 200 }) }
			)
		);

		await collections.tools.insertMany(tools satisfies CommunityToolDB[]);
	}
}

// run seed
(async () => {
	try {
		rl.question(
			"You're about to run a seeding script on the following MONGODB_URL: \x1b[31m" +
				env.MONGODB_URL +
				"\x1b[0m\n\n With the following flags: \x1b[31m" +
				flags.join("\x1b[0m , \x1b[31m") +
				"\x1b[0m\n \n\n Are you sure you want to continue? (yes/no): ",
			async (confirm) => {
				if (confirm !== "yes") {
					console.log("Not 'yes', exiting.");
					rl.close();
					process.exit(0);
				}
				console.log("Starting seeding...");
				await seed();
				console.log("Seeding done.");
				rl.close();
			}
		);
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
})();
