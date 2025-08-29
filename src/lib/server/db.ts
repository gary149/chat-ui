import { ObjectId } from "mongodb";
import { collections, getCollectionsEarly } from "$lib/server/database";
export { CONVERSATION_STATS_COLLECTION } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { SharedConversation } from "$lib/types/SharedConversation";
import type { MessageEvent } from "$lib/types/MessageEvent";
import type { Settings } from "$lib/types/Settings";
import type { User } from "$lib/types/User";
import type { Session } from "$lib/types/Session";
import type { TokenCache } from "$lib/types/TokenCache";
import type { ConfigKey } from "$lib/types/ConfigKey";
import { authCondition } from "$lib/server/auth";

// Convenience helpers to standardize DB access across the app.
// This file provides a single service entry point while keeping the legacy
// `collections` export working unchanged for compatibility.

export function toObjectId(id: string | ObjectId): ObjectId {
  return typeof id === "string" ? new ObjectId(id) : id;
}

export const asCollections = collections;

export const db = {
  // Low-level: direct access to typed collections if absolutely needed
  async raw() {
    await getCollectionsEarly();
    return collections;
  },

  conversations: {
    async countForLocals(locals: App.Locals): Promise<number> {
      return collections.conversations.countDocuments(authCondition(locals));
    },
    async countByLocals(locals: App.Locals): Promise<number> {
      return collections.conversations.countDocuments(authCondition(locals));
    },

    async findByIdForLocals(locals: App.Locals, id: string | ObjectId) {
      return collections.conversations.findOne({
        _id: toObjectId(id),
        ...authCondition(locals),
      });
    },

    async insert(doc: Omit<Conversation, "_id"> & Partial<Pick<Conversation, "_id">>) {
      const withId = {
        _id: doc._id ?? new ObjectId(),
        ...doc,
      } as Conversation;
      const res = await collections.conversations.insertOne(withId);
      return { ...withId, _id: res.insertedId } satisfies Conversation;
    },

    async updateFields(
      id: string | ObjectId,
      fields: Partial<Pick<Conversation, "title" | "messages" | "model" | "preprompt" | "rootMessageId" | "meta" | "userAgent">>
    ) {
      await collections.conversations.updateOne(
        { _id: toObjectId(id) },
        { $set: { ...fields, updatedAt: new Date() } }
      );
    },

    async deleteByIdForLocals(locals: App.Locals, id: string | ObjectId) {
      const conv = await this.findByIdForLocals(locals, id);
      if (!conv) return { deletedCount: 0 } as const;
      const res = await collections.conversations.deleteOne({ _id: conv._id });
      return { deletedCount: res.deletedCount } as const;
    },

    async findProjectionByIdForLocals<T extends Partial<Conversation>>(
      locals: App.Locals,
      id: string | ObjectId,
      projection: Record<string, 1 | 0>
    ): Promise<T | null> {
      return collections.conversations.findOne(
        { _id: toObjectId(id), ...authCondition(locals) },
        { projection }
      ) as Promise<T | null>;
    },

    async listSummariesForLocals(
      locals: App.Locals,
      page: number,
      pageSize: number
    ): Promise<Array<Pick<Conversation, "_id" | "title" | "updatedAt" | "model">>> {
      return collections.conversations
        .find(authCondition(locals))
        .project<Pick<Conversation, "_id" | "title" | "updatedAt" | "model">>({
          title: 1,
          updatedAt: 1,
          model: 1,
        })
        .sort({ updatedAt: -1 })
        .skip(page * pageSize)
        .limit(pageSize)
        .toArray();
    },

    async deleteManyForLocals(locals: App.Locals) {
      return collections.conversations.deleteMany({ ...authCondition(locals) });
    },

    async existsById(id: string | ObjectId): Promise<boolean> {
      return (await collections.conversations.countDocuments({ _id: toObjectId(id) })) > 0;
    },

    async updateMessagesForLocals(
      locals: App.Locals,
      id: string | ObjectId,
      messages: Conversation["messages"],
      title?: string
    ) {
      const $set: any = { messages, updatedAt: new Date() };
      if (title !== undefined) $set.title = title;
      await collections.conversations.updateOne({ _id: toObjectId(id), ...authCondition(locals) }, { $set });
    },

    async updateMessageScoreForLocals(
      locals: App.Locals,
      id: string | ObjectId,
      messageId: string,
      score: number | 0
    ) {
      const update: any =
        score !== 0 ? { $set: { "messages.$.score": score } } : { $unset: { "messages.$.score": "" } };
      return collections.conversations.updateOne(
        { _id: toObjectId(id), ...authCondition(locals), "messages.id": messageId },
        update
      );
    },

    async countAssistantMessagesForLocals(locals: App.Locals, limit: number): Promise<number> {
      const res = await collections.conversations
        .aggregate<{ messages: number }>([
          { $match: { ...authCondition(locals), "messages.from": "assistant" } },
          { $project: { messages: 1 } },
          { $limit: limit + 1 },
          { $unwind: "$messages" },
          { $match: { "messages.from": "assistant" } },
          { $count: "messages" },
        ])
        .toArray();
      return res[0]?.messages ?? 0;
    },
    async promoteSessionToUser(previousSessionId: string, userId: ObjectId) {
      await collections.conversations.updateMany(
        { sessionId: previousSessionId },
        { $set: { userId }, $unset: { sessionId: "" } }
      );
    },
  },

  shared: {
    async findById(id: string) {
      return collections.sharedConversations.findOne({ _id: id });
    },
    async findByHash(hash: string) {
      return collections.sharedConversations.findOne({ hash });
    },
    async insert(doc: SharedConversation) {
      await collections.sharedConversations.insertOne(doc);
      return doc;
    },
    async copyFilesFromConversationToShare(conversationId: ObjectId, shareId: string) {
      const prefix = `${conversationId}-`;
      const newPrefix = `${shareId}-`;
      const files = await collections.bucket
        .find({ filename: { $regex: prefix } })
        .toArray();

      await Promise.all(
        files.map(async (file) => {
          const newFilename = file.filename.replace(prefix, newPrefix);
          const downloadStream = collections.bucket.openDownloadStream(file._id);
          const uploadStream = collections.bucket.openUploadStream(newFilename, {
            metadata: { ...file.metadata, conversation: shareId },
          });
          downloadStream.pipe(uploadStream);
        })
      );
    },
  },

  messageEvents: {
    async insert(event: Omit<MessageEvent, "createdAt"> & Partial<Pick<MessageEvent, "createdAt">>) {
      await collections.messageEvents.insertOne({
        ...event,
        createdAt: event.createdAt ?? new Date(),
      });
    },
    async countRecentMessages({ userId, ip }: { userId?: User["_id"] | Session["sessionId"]; ip?: string }) {
      const now = new Date();
      // We assume TTL index on expiresAt; count unexpired recent message events
      const [byUser, byIp] = await Promise.all([
        userId
          ? collections.messageEvents.countDocuments({ userId, type: "message", expiresAt: { $gt: now } })
          : Promise.resolve(0),
        ip
          ? collections.messageEvents.countDocuments({ ip, type: "message", expiresAt: { $gt: now } })
          : Promise.resolve(0),
      ]);
      return Math.max(byUser, byIp);
    },
    async insertExportEvent(userId: User["_id"]) {
      await collections.messageEvents.insertOne({
        userId,
        type: "export",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    },
    async countUnexpiredByUserAndType(userId: User["_id"], type: MessageEvent["type"]) {
      return collections.messageEvents.countDocuments({ userId, type, expiresAt: { $gt: new Date() } });
    },
  },

  settings: {
    async findForLocals(locals: App.Locals) {
      return collections.settings.findOne(authCondition(locals));
    },
    async upsertForUserOrSession(locals: App.Locals, values: Partial<Settings>) {
      const filter = authCondition(locals);
      const res = await collections.settings.updateOne(filter, { $set: values }, { upsert: true });
      return res;
    },
    aggregate<T>(pipeline: any[]) {
      return collections.settings.aggregate(pipeline) as any as AsyncIterable<T> & { toArray(): Promise<T[]> };
    },
    async hasAcceptedEthicsModal(sessionId: string) {
      const count = await collections.settings.countDocuments({
        sessionId,
        ethicsModalAcceptedAt: { $exists: true },
      });
      return count > 0;
    },
    async promoteSessionToUser(previousSessionId: string, userId: ObjectId) {
      const res = await collections.settings.updateOne(
        { sessionId: previousSessionId },
        { $set: { userId, updatedAt: new Date() }, $unset: { sessionId: "" } }
      );
      return res.matchedCount;
    },
  },

  users: {
    async findByHfUserId(hfUserId: string) {
      return collections.users.findOne({ hfUserId });
    },
    async findById(id: ObjectId) {
      return collections.users.findOne({ _id: id });
    },
    async insert(doc: Omit<User, "_id"> & Partial<Pick<User, "_id">>) {
      const withId = { _id: doc._id ?? new ObjectId(), ...doc } as User;
      const res = await collections.users.insertOne(withId);
      return { ...withId, _id: res.insertedId } satisfies User;
    },
    async updateById(id: ObjectId, $set: Partial<User>) {
      await collections.users.updateOne({ _id: id }, { $set });
    },
  },

  sessions: {
    async findBySessionId(sessionId: string) {
      return collections.sessions.findOne({ sessionId });
    },
    async insert(doc: Session) {
      await collections.sessions.insertOne(doc);
    },
    async deleteBySessionId(sessionId: string) {
      await collections.sessions.deleteOne({ sessionId });
    },
    async updateBySessionId(sessionId: string, update: Partial<Session>) {
      await collections.sessions.updateOne({ sessionId }, { $set: update });
    },
  },

  tokenCache: {
    async findByHash(tokenHash: string) {
      return collections.tokenCaches.findOne({ tokenHash });
    },
    async insert(cache: TokenCache) {
      await collections.tokenCaches.insertOne(cache);
    },
  },

  config: {
    async get(key: ConfigKey["key"]) {
      return collections.config.findOne({ key });
    },
    async set(key: ConfigKey["key"], value: ConfigKey["value"]) {
      await collections.config.updateOne(
        { key },
        { $set: { key, value } },
        { upsert: true }
      );
    },
  },

  reports: {
    async findByCreator(creator: User["_id"] | Session["sessionId"]) {
      return collections.reports.find({ createdBy: creator }).toArray();
    },
  },

  assistants: {
    async findByCreatorId(userId: User["_id"]) {
      return collections.assistants.find({ createdById: userId }).toArray();
    },
    async findProjectionById<T extends Partial<import("$lib/types/Assistant").Assistant>>(
      id: ObjectId | undefined,
      projection: Record<string, 1 | 0>
    ): Promise<T | null> {
      if (!id) return null;
      return collections.assistants.findOne({ _id: id }, { projection }) as Promise<T | null>;
    },
  },

  files: {
    async downloadFile(sha256: string, convId: Conversation["_id"] | SharedConversation["_id"]) {
      const fileId = collections.bucket.find({ filename: `${convId.toString()}-${sha256}` });
      const file = await fileId.next();
      if (!file) throw new Error("File not found");
      if (file.metadata?.conversation !== convId.toString()) {
        throw new Error("You don't have access to this file.");
      }
      const mime = file.metadata?.mime;
      const name = file.filename;
      const fileStream = collections.bucket.openDownloadStream(file._id);
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        fileStream.on("data", (chunk) => chunks.push(chunk));
        fileStream.on("error", reject);
        fileStream.on("end", () => resolve(Buffer.concat(chunks)));
      });
      return { buffer, mime, name };
    },

    openUploadStream(filename: string, metadata: Record<string, any>) {
      return collections.bucket.openUploadStream(filename, { metadata });
    },

    async getAssistantAvatarBuffer(assistantId: ObjectId) {
      const cursor = collections.bucket.find({ filename: assistantId.toString() });
      const file = await cursor.next();
      if (!file?._id) return null;
      const fileStream = collections.bucket.openDownloadStream(file._id);
      const fileBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        fileStream.on("data", (chunk) => chunks.push(chunk));
        fileStream.on("error", reject);
        fileStream.on("end", () => resolve(Buffer.concat(chunks)));
      });
      return fileBuffer;
    },
  },

  abortedGenerations: {
    async touch(conversationId: ObjectId) {
      await collections.abortedGenerations.updateOne(
        { conversationId },
        { $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    },
  },
};

export type DBService = typeof db;
