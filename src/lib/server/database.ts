import { MONGODB_URL, MONGODB_DB_NAME } from "$env/static/private";
import { MongoClient } from "mongodb";
import type { Conversation } from "$lib/types/Conversation";
import type { SharedConversation } from "$lib/types/SharedConversation";
import type { AbortedGeneration } from "$lib/types/AbortedGeneration";
import type { Settings } from "$lib/types/Settings";

const client = new MongoClient(MONGODB_URL, {
	// directConnection: true
});

export const connectPromise = client.connect().catch(console.error);

const db = client.db(MONGODB_DB_NAME);

const conversations = db.collection<Conversation>("conversations");
const sharedConversations = db.collection<SharedConversation>("sharedConversations");
const abortedGenerations = db.collection<AbortedGeneration>("abortedGenerations");
const settings = db.collection<Settings>("settings");

export { client, db };
export const collections = { conversations, sharedConversations, abortedGenerations, settings };

client.on("open", () => {
	conversations.createIndex({ sessionId: 1, updatedAt: -1 });
	abortedGenerations.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 30 });
	abortedGenerations.createIndex({ conversationId: 1 }, { unique: true });
	sharedConversations.createIndex({ hash: 1 }, { unique: true });
	// Sparse so that we can have settings on userId later
	settings.createIndex({ sessionId: 1 }, { unique: true, sparse: true });
});
