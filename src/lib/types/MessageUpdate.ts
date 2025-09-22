import type { ToolCall, ToolResult } from "$lib/types/Tool";

export type MessageUpdate =
	| MessageStatusUpdate
	| MessageTitleUpdate
	| MessageToolUpdate
	| MessageStreamUpdate
	| MessageFileUpdate
	| MessageFinalAnswerUpdate
	| MessageReasoningUpdate
	| MessageRouterMetadataUpdate;

export enum MessageUpdateType {
	Status = "status",
	Title = "title",
	Tool = "tool",
	Stream = "stream",
	File = "file",
	FinalAnswer = "finalAnswer",
	Reasoning = "reasoning",
	RouterMetadata = "routerMetadata",
}

// Status
export enum MessageUpdateStatus {
	Started = "started",
	Error = "error",
	Finished = "finished",
	KeepAlive = "keepAlive",
}
export interface MessageStatusUpdate {
	type: MessageUpdateType.Status;
	status: MessageUpdateStatus;
	message?: string;
}

// Everything else
export interface MessageTitleUpdate {
	type: MessageUpdateType.Title;
	title: string;
}
export interface MessageStreamUpdate {
	type: MessageUpdateType.Stream;
	token: string;
}

// Tool updates
export enum MessageToolUpdateType {
	Call = "call",
	Result = "result",
	Error = "error",
	ETA = "eta",
}

interface MessageToolBaseUpdate<TSubType extends MessageToolUpdateType> {
	type: MessageUpdateType.Tool;
	subtype: TSubType;
	uuid: string;
}

export interface MessageToolCallUpdate extends MessageToolBaseUpdate<MessageToolUpdateType.Call> {
	call: ToolCall;
}

export interface MessageToolResultUpdate
	extends MessageToolBaseUpdate<MessageToolUpdateType.Result> {
	result: ToolResult;
}

export interface MessageToolErrorUpdate extends MessageToolBaseUpdate<MessageToolUpdateType.Error> {
	message: string;
}

export interface MessageToolETAUpdate extends MessageToolBaseUpdate<MessageToolUpdateType.ETA> {
	eta: number;
}

export type MessageToolUpdate =
	| MessageToolCallUpdate
	| MessageToolResultUpdate
	| MessageToolErrorUpdate
	| MessageToolETAUpdate;

export enum MessageReasoningUpdateType {
	Stream = "stream",
	Status = "status",
}

export type MessageReasoningUpdate = MessageReasoningStreamUpdate | MessageReasoningStatusUpdate;

export interface MessageReasoningStreamUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Stream;
	token: string;
}
export interface MessageReasoningStatusUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Status;
	status: string;
}

export interface MessageFileUpdate {
	type: MessageUpdateType.File;
	name: string;
	sha: string;
	mime: string;
}
export interface MessageFinalAnswerUpdate {
	type: MessageUpdateType.FinalAnswer;
	text: string;
	interrupted: boolean;
}
export interface MessageRouterMetadataUpdate {
	type: MessageUpdateType.RouterMetadata;
	route: string;
	model: string;
}
