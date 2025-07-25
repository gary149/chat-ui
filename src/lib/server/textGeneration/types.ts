import type { ProcessedModel } from "../models";
import type { Endpoint } from "../endpoints/endpoints";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";

export interface TextGenerationContext {
	model: ProcessedModel;
	endpoint: Endpoint;
	conv: Conversation;
	messages: Message[];
	isContinue: boolean;
	webSearch: boolean;
	toolsPreference: Array<string>;
	promptedAt: Date;
	ip: string;
	username?: string;
}
