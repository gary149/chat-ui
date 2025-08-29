import { authCondition } from "$lib/server/auth";
import { db } from "$lib/server/db";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";

export async function DELETE({ locals, params }) {
	const messageId = params.messageId;

	if (!messageId || typeof messageId !== "string") {
		error(400, "Invalid message id");
	}

	const conversation = await db.conversations.findByIdForLocals(locals, new ObjectId(params.id));

	if (!conversation) {
		error(404, "Conversation not found");
	}

	const filteredMessages = conversation.messages
		.filter(
			(message) =>
				// not the message AND the message is not in ancestors
				!(message.id === messageId) && message.ancestors && !message.ancestors.includes(messageId)
		)
		.map((message) => {
			// remove the message from children if it's there
			if (message.children && message.children.includes(messageId)) {
				message.children = message.children.filter((child) => child !== messageId);
			}
			return message;
		});

	await db.conversations.updateMessagesForLocals(locals, conversation._id, filteredMessages);

	return new Response();
}
