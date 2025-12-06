import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";

/**
 * YAML frontmatter from SKILL.md files
 */
export interface SkillFrontmatter {
	name: string;
	description: string;
	license?: string;
	version?: string;
	author?: string;
	tags?: string[];
}

/**
 * A parsed skill loaded from a SKILL.md file
 */
export interface Skill extends SkillFrontmatter {
	/** Unique identifier (derived from folder name or generated) */
	id: string;
	/** Full markdown instructions (body after frontmatter) */
	instructions: string;
	/** Source of the skill: built-in, user-uploaded, or from repository */
	source: "builtin" | "user" | "repository";
	/** Repository URL if from external source */
	repositoryUrl?: string;
	/** Directory containing additional skill resources */
	resourcesPath?: string;
	/** List of additional resource files */
	resources?: string[];
	/** Whether the skill is currently enabled */
	enabled: boolean;
}

/**
 * Minimal skill representation for UI display (progressive disclosure)
 * Only name and description are shown initially to save tokens
 */
export interface SkillManifestEntry {
	id: string;
	name: string;
	description: string;
	tags?: string[];
}

/**
 * Skills configuration stored per user/session in database
 */
export interface SkillSettings extends Partial<Timestamps> {
	_id?: ObjectId;
	userId?: ObjectId;
	sessionId?: string;
	/** IDs of skills enabled for this user */
	enabledSkills: string[];
	/** Custom user-uploaded skills */
	customSkills?: Skill[];
	/** Per-conversation skill overrides */
	conversationSkillOverrides?: Record<string, string[]>;
}

/**
 * Skill activation context - determines which skills to load for a message
 */
export interface SkillActivationContext {
	/** The user's message content */
	messageContent: string;
	/** Current conversation context */
	conversationId?: string;
	/** Active model ID */
	modelId: string;
	/** Previously activated skills in this conversation */
	previouslyActivatedSkills?: string[];
}

/**
 * Result of skill detection/matching
 */
export interface SkillActivationResult {
	/** Skills that should be fully loaded */
	activatedSkills: Skill[];
	/** Reason for activation (for debugging/logging) */
	activationReasons: Record<string, string>;
}

/**
 * Skill with activation state for a specific conversation
 */
export interface ConversationSkillState {
	skill: Skill;
	/** Whether the skill is currently active in this conversation */
	isActive: boolean;
	/** When the skill was last activated */
	lastActivatedAt?: Date;
	/** Number of times activated in this conversation */
	activationCount: number;
}

/**
 * Default skill settings
 */
export const DEFAULT_SKILL_SETTINGS: Omit<SkillSettings, "_id"> = {
	enabledSkills: [],
	customSkills: [],
	conversationSkillOverrides: {},
};
