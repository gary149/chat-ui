import { error } from "@sveltejs/kit";
import { db } from "$lib/server/db";
import type { Conversation } from "$lib/types/Conversation";
import type { SharedConversation } from "$lib/types/SharedConversation";
import type { MessageFile } from "$lib/types/Message";

export async function downloadFile(
	sha256: string,
	convId: Conversation["_id"] | SharedConversation["_id"]
): Promise<MessageFile & { type: "base64" }> {
	try {
		const { buffer, mime, name } = await db.files.downloadFile(sha256, convId);
		return { type: "base64", name, value: buffer.toString("base64"), mime };
	} catch (e) {
		const msg = (e as Error).message;
		if (msg.includes("not found")) error(404, "File not found");
		if (msg.includes("access")) error(403, "You don't have access to this file.");
		throw e;
	}
}
