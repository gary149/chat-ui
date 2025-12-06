import { config } from "../config";
import { collections } from "../database";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import type { SkillSettings, Skill, SkillActivationContext } from "$lib/types/Skill";
import { DEFAULT_SKILL_SETTINGS } from "$lib/types/Skill";
import { getSkillRegistry, detectSkillsForActivation, buildSkillsPrompt } from "./skillRegistry";
import { logger } from "../logger";
import { ObjectId } from "mongodb";

/**
 * Get skill settings for a user/session
 */
export async function getSkillSettings(
	userId?: string,
	sessionId?: string
): Promise<SkillSettings> {
	if (!userId && !sessionId) {
		return { ...DEFAULT_SKILL_SETTINGS };
	}

	const query = userId ? { userId: new ObjectId(userId) } : { sessionId };

	try {
		const settings = await collections.skillSettings?.findOne(query);
		if (settings) {
			return settings as SkillSettings;
		}
	} catch (error) {
		logger.error("Failed to fetch skill settings:", error);
	}

	return { ...DEFAULT_SKILL_SETTINGS };
}

/**
 * Save skill settings for a user/session
 */
export async function saveSkillSettings(
	settings: SkillSettings,
	userId?: string,
	sessionId?: string
): Promise<void> {
	if (!userId && !sessionId) {
		throw new Error("Either userId or sessionId is required");
	}

	const query = userId ? { userId: new ObjectId(userId) } : { sessionId };

	try {
		await collections.skillSettings?.updateOne(
			query,
			{
				$set: {
					...settings,
					userId: userId ? new ObjectId(userId) : undefined,
					sessionId,
					updatedAt: new Date(),
				},
				$setOnInsert: {
					createdAt: new Date(),
				},
			},
			{ upsert: true }
		);
	} catch (error) {
		logger.error("Failed to save skill settings:", error);
		throw error;
	}
}

/**
 * Get previously activated skills from conversation messages
 */
function getPreviouslyActivatedSkills(messages: Message[]): string[] {
	const activatedSkills = new Set<string>();

	for (const message of messages) {
		// Check if message has skill activation metadata
		const skillMeta = (message as Message & { activatedSkills?: string[] }).activatedSkills;
		if (skillMeta) {
			for (const skillId of skillMeta) {
				activatedSkills.add(skillId);
			}
		}
	}

	return Array.from(activatedSkills);
}

/**
 * Enhance preprompt with skill instructions
 * This is the main integration point for skills in text generation
 */
export async function enhancePrepromptWithSkills(
	preprompt: string | undefined,
	conv: Conversation,
	messages: Message[],
	userId?: string,
	sessionId?: string
): Promise<{
	enhancedPreprompt: string;
	activatedSkills: Skill[];
}> {
	// Check if skills are enabled
	if (config.ENABLE_SKILLS !== "true") {
		return {
			enhancedPreprompt: preprompt ?? "",
			activatedSkills: [],
		};
	}

	const registry = getSkillRegistry();

	// Make sure registry is initialized
	if (!registry.isInitialized) {
		return {
			enhancedPreprompt: preprompt ?? "",
			activatedSkills: [],
		};
	}

	// Get user's skill settings
	const skillSettings = await getSkillSettings(userId, sessionId);

	// If no skills are enabled for the user, return original preprompt
	if (skillSettings.enabledSkills.length === 0) {
		return {
			enhancedPreprompt: preprompt ?? "",
			activatedSkills: [],
		};
	}

	// Get the last user message for context
	const lastUserMessage = messages
		.slice()
		.reverse()
		.find((m) => m.from === "user");

	if (!lastUserMessage) {
		return {
			enhancedPreprompt: preprompt ?? "",
			activatedSkills: [],
		};
	}

	// Build activation context
	const activationContext: SkillActivationContext = {
		messageContent: lastUserMessage.content,
		conversationId: conv._id.toString(),
		modelId: conv.model,
		previouslyActivatedSkills: getPreviouslyActivatedSkills(messages),
	};

	// Detect which skills should be activated
	const activationResult = detectSkillsForActivation(activationContext, skillSettings);

	// Get skill manifest for progressive disclosure
	const manifest = registry.getManifest().filter((m) => skillSettings.enabledSkills.includes(m.id));

	// Build the skills prompt section
	const skillsPrompt = buildSkillsPrompt(activationResult.activatedSkills, manifest);

	// Log activation for debugging
	if (activationResult.activatedSkills.length > 0) {
		logger.info(
			`Activated skills: ${activationResult.activatedSkills.map((s) => s.name).join(", ")}`
		);
		logger.debug("Activation reasons:", activationResult.activationReasons);
	}

	// Combine preprompt with skills
	const enhancedPreprompt = (preprompt ?? "") + skillsPrompt;

	return {
		enhancedPreprompt,
		activatedSkills: activationResult.activatedSkills,
	};
}

/**
 * Enable a skill for a user/session
 */
export async function enableSkill(
	skillId: string,
	userId?: string,
	sessionId?: string
): Promise<void> {
	const settings = await getSkillSettings(userId, sessionId);

	if (!settings.enabledSkills.includes(skillId)) {
		settings.enabledSkills.push(skillId);
		await saveSkillSettings(settings, userId, sessionId);
	}
}

/**
 * Disable a skill for a user/session
 */
export async function disableSkill(
	skillId: string,
	userId?: string,
	sessionId?: string
): Promise<void> {
	const settings = await getSkillSettings(userId, sessionId);

	settings.enabledSkills = settings.enabledSkills.filter((id) => id !== skillId);
	await saveSkillSettings(settings, userId, sessionId);
}

/**
 * Get all available skills with their enabled status for a user
 */
export async function getSkillsWithStatus(
	userId?: string,
	sessionId?: string
): Promise<Array<Skill & { isEnabled: boolean }>> {
	const registry = getSkillRegistry();
	const settings = await getSkillSettings(userId, sessionId);

	return registry.getAllSkills().map((skill) => ({
		...skill,
		isEnabled: settings.enabledSkills.includes(skill.id),
	}));
}
