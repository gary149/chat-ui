import type { ObjectId } from "mongodb";
import type { Message } from "./Message";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface Conversation extends Timestamps {
	_id: ObjectId;

	sessionId?: string;
	userId?: User["_id"];

	model: string;
	embeddingModel: string;

	title: string;
	rootMessageId?: Message["id"];
	messages: Message[];

	meta?: {
		fromShareId?: string;
	};

	preprompt?: string;

	userAgent?: string;
}
