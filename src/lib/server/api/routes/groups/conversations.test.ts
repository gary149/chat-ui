import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { Readable, Writable } from "stream";

import type { Message } from "$lib/types/Message";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import { collections, ready } from "$lib/server/database";

const testUserId = new ObjectId();
const usageLimitsMock: {
	conversations?: number;
	messagesPerMinute?: number;
	messages?: number;
} = {};
const streamingEvents: MessageUpdate[] = [];

vi.mock("$api/authPlugin", () => {
	const plugin = new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
		locals: {
			user: { _id: testUserId, username: "tester" },
			sessionId: "test-session",
			isAdmin: false,
		},
	}));
	return { authPlugin: plugin };
});

vi.mock("$lib/server/models", () => {
	const testModel = {
		id: "test-model",
		name: "test-model",
		preprompt: "system preprompt",
		unlisted: false,
		async getEndpoint() {
			return { type: "openai", baseURL: "http://localhost" } as const;
		},
	};
	return {
		models: [testModel],
		validateModel: (models: (typeof testModel)[]) =>
			z.enum(models.map((m) => m.id) as [string, ...string[]]),
		validModelIdSchema: z.enum([testModel.id] as [string, ...string[]]),
	};
});

vi.mock("$lib/server/usageLimits", () => ({ usageLimits: usageLimitsMock }));

vi.mock("$lib/server/textGeneration", () => ({
	async *textGeneration() {
		for (const event of streamingEvents) {
			yield event;
		}
	},
}));

const downloadFileMock = vi.fn();

vi.mock("$lib/server/files/downloadFile", () => ({
	downloadFile: downloadFileMock,
}));

const buildPromptMock = vi.fn(async () => "PROMPT");

vi.mock("$lib/buildPrompt", () => ({ buildPrompt: buildPromptMock }));

const { conversationGroup } = await import("$lib/server/api/routes/groups/conversations");

const app = new Elysia().use(conversationGroup);

describe("conversationGroup", () => {
	beforeAll(async () => {
		await ready;
	});

	beforeEach(async () => {
		streamingEvents.splice(0, streamingEvents.length);
		usageLimitsMock.conversations = undefined;
		usageLimitsMock.messages = undefined;
		usageLimitsMock.messagesPerMinute = undefined;
		buildPromptMock.mockReset();
		buildPromptMock.mockResolvedValue("PROMPT");
		downloadFileMock.mockReset();
		downloadFileMock.mockResolvedValue({
			type: "base64",
			name: "test",
			value: Buffer.from("hello world").toString("base64"),
			mime: "text/plain",
		});
		await collections.conversations.deleteMany({});
		await collections.sharedConversations.deleteMany({});
		await collections.messageEvents.deleteMany({});
		await collections.abortedGenerations.deleteMany({});
	});

	it("creates a new conversation", async () => {
		const response = await app.handle(
			new Request("http://localhost/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "test-model" }),
			})
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.conversationId).toBeTypeOf("string");

		const stored = await collections.conversations.findOne({
			_id: new ObjectId(body.conversationId),
		});
		expect(stored).not.toBeNull();
		expect(stored?.userId?.toString()).toBe(testUserId.toString());
		expect(stored?.messages[0]?.from).toBe("system");
		expect(stored?.preprompt).toBe("system preprompt");
	});

	it("clones a shared conversation and sanitises the title", async () => {
		const sharedId = "share01";
		const sharedMessages: Message[] = [
			{
				id: "shared-root",
				from: "system",
				content: "shared preprompt",
				createdAt: new Date(),
				updatedAt: new Date(),
				children: [],
				ancestors: [],
			},
		];
		await collections.sharedConversations.insertOne({
			_id: sharedId,
			title: "<think>Shared Title</think>",
			messages: sharedMessages,
			model: "test-model",
			preprompt: "shared preprompt",
			rootMessageId: "shared-root",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await app.handle(
			new Request("http://localhost/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "test-model", fromShare: sharedId }),
			})
		);

		expect(response.status).toBe(200);
		const { conversationId } = await response.json();
		const stored = await collections.conversations.findOne({
			_id: new ObjectId(conversationId),
		});
		expect(stored?.title).toBe("Shared Title");
		expect(stored?.messages.map((m) => m.id)).toEqual(["shared-root"]);
		expect(stored?.meta?.fromShareId).toBe(sharedId);
	});

	it("applies conversation rate limits", async () => {
		usageLimitsMock.conversations = 0;
		await collections.conversations.insertOne({
			_id: new ObjectId(),
			userId: testUserId,
			title: "Existing",
			messages: [],
			model: "test-model",
			preprompt: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await app.handle(
			new Request("http://localhost/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "test-model" }),
			})
		);

		expect(response.status).toBe(429);
	});

	it("streams message updates and updates the conversation", async () => {
		const conversationId = new ObjectId();
		const now = new Date();
		const rootMessage: Message = {
			id: "root",
			from: "system",
			content: "system preprompt",
			createdAt: now,
			updatedAt: now,
			children: [],
			ancestors: [],
		};
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Test Conversation",
			messages: [rootMessage],
			model: "test-model",
			preprompt: "system preprompt",
			rootMessageId: rootMessage.id,
			createdAt: now,
			updatedAt: now,
		});

		streamingEvents.splice(
			0,
			streamingEvents.length,
			...[
				{ type: MessageUpdateType.Stream, token: "Hello" },
				{ type: MessageUpdateType.FinalAnswer, text: "Hello world", interrupted: false },
				{ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished },
			]
		);

		const form = new FormData();
		form.append(
			"data",
			JSON.stringify({
				inputs: "How are you?",
				id: rootMessage.id,
				is_retry: false,
				is_continue: false,
			})
		);

		const response = await app.handle(
			new Request(`http://localhost/conversations/${conversationId.toString()}`, {
				method: "POST",
				body: form,
			})
		);

		expect(response.status).toBe(200);
		const text = await response.text();
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && /^[{\[]/.test(line));
		expect(lines.length).toBeGreaterThanOrEqual(2);

		const parsed = lines.map((line) => JSON.parse(line) as MessageUpdate);
		expect(parsed[0].type).toBe(MessageUpdateType.Stream);
		expect((parsed[0] as any).token.startsWith("Hello")).toBe(true);
		const finalEvent = parsed.find((evt) => evt.type === MessageUpdateType.FinalAnswer) as
			| MessageUpdate
			| undefined;
		expect(finalEvent).toBeDefined();
		expect((finalEvent as any).text).toBe("Hello world");

		const updated = await collections.conversations.findOne({ _id: conversationId });
		expect(updated?.messages.length).toBe(3);
		const assistantMessage = updated?.messages.find((msg) => msg.from === "assistant");
		expect(assistantMessage?.content).toBe("Hello world");
	});

	it("creates and reuses share links while copying attachments", async () => {
		const conversationId = new ObjectId();
		const now = new Date();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Share Me",
			messages: [
				{
					id: "root",
					from: "system",
					content: "system preprompt",
					createdAt: now,
					updatedAt: now,
					children: [],
					ancestors: [],
				},
			],
			model: "test-model",
			preprompt: "system preprompt",
			rootMessageId: "root",
			createdAt: now,
			updatedAt: now,
		});

		const cursorMock = {
			toArray: vi.fn(async () => [
				{
					_id: new ObjectId(),
					filename: `${conversationId.toString()}-filehash`,
					metadata: { conversation: conversationId.toString(), mime: "text/plain" },
				},
			]),
		};
		const findSpy = vi.spyOn(collections.bucket, "find").mockReturnValue(cursorMock as any);
		const downloadSpy = vi.spyOn(collections.bucket, "openDownloadStream").mockImplementation(
			() =>
				new Readable({
					read() {
						this.push(Buffer.from("filedata"));
						this.push(null);
					},
				}) as any
		);
		const uploadSpy = vi.spyOn(collections.bucket, "openUploadStream").mockImplementation(
			() =>
				new Writable({
					write(_chunk, _encoding, callback) {
						callback();
					},
				}) as any
		);

		try {
			const firstResponse = await app.handle(
				new Request(`http://localhost/conversations/${conversationId.toString()}/share`, {
					method: "POST",
				})
			);

			expect(firstResponse.status).toBe(200);
			const firstBody = await firstResponse.json();
			expect(firstBody.shareId).toHaveLength(7);

			const secondResponse = await app.handle(
				new Request(`http://localhost/conversations/${conversationId.toString()}/share`, {
					method: "POST",
				})
			);

			expect(secondResponse.status).toBe(200);
			const secondBody = await secondResponse.json();
			expect(secondBody.shareId).toBe(firstBody.shareId);
			const shared = await collections.sharedConversations.findOne({ _id: firstBody.shareId });
			expect(shared).not.toBeNull();
			expect(uploadSpy).toHaveBeenCalled();
		} finally {
			findSpy.mockRestore();
			downloadSpy.mockRestore();
			uploadSpy.mockRestore();
		}
	});

	it("records aborted generations", async () => {
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Stop",
			messages: [],
			model: "test-model",
			preprompt: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await app.handle(
			new Request(`http://localhost/conversations/${conversationId.toString()}/stop-generating`, {
				method: "POST",
			})
		);

		expect(response.status).toBe(200);
		const aborted = await collections.abortedGenerations.findOne({ conversationId });
		expect(aborted).not.toBeNull();
	});

	it("downloads conversation output", async () => {
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Download",
			messages: [],
			model: "test-model",
			preprompt: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await app.handle(
			new Request(`http://localhost/conversations/${conversationId.toString()}/output/filehash`, {
				method: "GET",
			})
		);

		expect(response.status).toBe(200);
		expect(downloadFileMock).toHaveBeenCalledWith("filehash", conversationId);
		const buffer = Buffer.from(await response.arrayBuffer());
		expect(buffer.toString()).toBe("hello world");
		expect(response.headers.get("content-type")).toBe("text/plain");
	});

	it("downloads shared conversation output", async () => {
		await collections.sharedConversations.insertOne({
			_id: "share01",
			title: "Shared",
			messages: [],
			model: "test-model",
			preprompt: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		downloadFileMock.mockResolvedValueOnce({
			type: "base64",
			name: "shared",
			value: Buffer.from("shared file").toString("base64"),
			mime: "application/octet-stream",
		});

		const response = await app.handle(
			new Request("http://localhost/conversations/share01/output/filehash", {
				method: "GET",
			})
		);

		expect(response.status).toBe(200);
		expect(downloadFileMock).toHaveBeenCalledWith("filehash", "share01");
		const buffer = Buffer.from(await response.arrayBuffer());
		expect(buffer.toString()).toBe("shared file");
	});

	it("exports prompt data for a conversation message", async () => {
		const conversationId = new ObjectId();
		const now = new Date();
		const messages: Message[] = [
			{
				id: "root",
				from: "system",
				content: "system preprompt",
				createdAt: now,
				updatedAt: now,
				children: ["user"],
				ancestors: [],
			},
			{
				id: "user",
				from: "user",
				content: "Hello",
				createdAt: now,
				updatedAt: now,
				children: [],
				ancestors: ["root"],
			},
		];

		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Prompt",
			messages,
			model: "test-model",
			preprompt: "system preprompt",
			rootMessageId: "root",
			createdAt: now,
			updatedAt: now,
		});

		const response = await app.handle(
			new Request(`http://localhost/conversations/${conversationId.toString()}/prompt/user`, {
				method: "GET",
			})
		);

		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.prompt).toBe("PROMPT");
		expect(payload.model).toBe("test-model");
		expect(payload.parameters).toMatchObject({ return_full_text: false });
		expect(payload.messages).toHaveLength(2);
		expect(buildPromptMock).toHaveBeenCalled();
	});

	it("returns 404 when prompt message is missing", async () => {
		const conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: testUserId,
			title: "Prompt",
			messages: [],
			model: "test-model",
			preprompt: "",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await app.handle(
			new Request(`http://localhost/conversations/${conversationId.toString()}/prompt/missing`, {
				method: "GET",
			})
		);

		expect(response.status).toBe(404);
	});
});
