import { authCondition } from "$lib/server/auth";
import { db } from "$lib/server/db";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";

/**
 * Ideally, we'd be able to detect the client-side abort, see https://github.com/huggingface/chat-ui/pull/88#issuecomment-1523173850
 */
export async function POST({ params, locals }) {
	const conversationId = new ObjectId(params.id);

	const conversation = await db.conversations.findByIdForLocals(locals, conversationId);

	if (!conversation) {
		error(404, "Conversation not found");
	}

	await db.abortedGenerations.touch(conversationId);

	return new Response();
}
