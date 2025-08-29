import { authCondition } from "$lib/server/auth";
import { db } from "$lib/server/db";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

export async function POST({ params, request, locals }) {
	const { score } = z
		.object({
			score: z.number().int().min(-1).max(1),
		})
		.parse(await request.json());
	const conversationId = new ObjectId(params.id);
	const messageId = params.messageId;

	// aggregate votes per model in order to detect model performance degradation
	const model = await db.conversations
		.findProjectionByIdForLocals<{ model: string }>(locals, conversationId, { model: 1 })
		.then((c) => c?.model);

	const document = await db.conversations.updateMessageScoreForLocals(
		locals,
		conversationId,
		messageId,
		score
	);

	if (!document.matchedCount) {
		error(404, "Message not found");
	}

	return new Response();
}
