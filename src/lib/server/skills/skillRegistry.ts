import type {
	Skill,
	SkillManifestEntry,
	SkillSettings,
	SkillActivationContext,
	SkillActivationResult,
} from "$lib/types/Skill";
import { loadSkillsFromDirectory, fetchSkillFromUrl, validateSkill } from "./skillLoader";
import { config } from "../config";
import { logger } from "../logger";
import * as path from "path";

/**
 * Singleton registry for managing all available skills
 */
class SkillRegistry {
	private skills: Map<string, Skill> = new Map();
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	/**
	 * Initialize the registry by loading built-in skills
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = this.doInitialize();
		await this.initPromise;
	}

	private async doInitialize(): Promise<void> {
		try {
			// Load built-in skills from the skills directory
			const skillsPath = config.SKILLS_PATH || path.join(process.cwd(), "skills");

			try {
				const builtinSkills = await loadSkillsFromDirectory(skillsPath, "builtin");
				for (const skill of builtinSkills) {
					this.skills.set(skill.id, skill);
				}
				logger.info(`Loaded ${builtinSkills.length} built-in skills`);
			} catch (error) {
				logger.warn(`No built-in skills directory found at ${skillsPath}`);
			}

			// Load skills from configured repositories
			const repoUrls = config.SKILLS_REPOSITORIES?.split(",").filter(Boolean) ?? [];
			for (const url of repoUrls) {
				try {
					const skill = await fetchSkillFromUrl(url.trim());
					this.skills.set(skill.id, skill);
					logger.info(`Loaded remote skill: ${skill.name}`);
				} catch (error) {
					logger.error(`Failed to load skill from ${url}:`, error);
				}
			}

			this.initialized = true;
			logger.info(`Skill registry initialized with ${this.skills.size} skills`);
		} catch (error) {
			logger.error("Failed to initialize skill registry:", error);
			this.initialized = true; // Mark as initialized even on error to prevent retry loops
		}
	}

	/**
	 * Get all available skills
	 */
	getAllSkills(): Skill[] {
		return Array.from(this.skills.values());
	}

	/**
	 * Get all enabled skills
	 */
	getEnabledSkills(): Skill[] {
		return this.getAllSkills().filter((s) => s.enabled);
	}

	/**
	 * Get a skill by ID
	 */
	getSkill(id: string): Skill | undefined {
		return this.skills.get(id);
	}

	/**
	 * Get the manifest (minimal info for progressive disclosure)
	 * This is what gets shown to the model initially
	 */
	getManifest(): SkillManifestEntry[] {
		return this.getEnabledSkills().map((skill) => ({
			id: skill.id,
			name: skill.name,
			description: skill.description,
			tags: skill.tags,
		}));
	}

	/**
	 * Register a new skill
	 */
	registerSkill(skill: Skill): void {
		if (!validateSkill(skill)) {
			throw new Error("Invalid skill format");
		}
		this.skills.set(skill.id, skill);
		logger.info(`Registered skill: ${skill.name}`);
	}

	/**
	 * Remove a skill
	 */
	removeSkill(id: string): boolean {
		const removed = this.skills.delete(id);
		if (removed) {
			logger.info(`Removed skill: ${id}`);
		}
		return removed;
	}

	/**
	 * Enable/disable a skill
	 */
	setSkillEnabled(id: string, enabled: boolean): void {
		const skill = this.skills.get(id);
		if (skill) {
			skill.enabled = enabled;
			logger.info(`Skill ${id} ${enabled ? "enabled" : "disabled"}`);
		}
	}

	/**
	 * Get skills by IDs
	 */
	getSkillsByIds(ids: string[]): Skill[] {
		return ids.map((id) => this.skills.get(id)).filter((s): s is Skill => s !== undefined);
	}

	/**
	 * Get skills matching any of the given tags
	 */
	getSkillsByTags(tags: string[]): Skill[] {
		return this.getEnabledSkills().filter(
			(skill) => skill.tags?.some((t) => tags.includes(t)) ?? false
		);
	}

	/**
	 * Search skills by name or description
	 */
	searchSkills(query: string): Skill[] {
		const lowerQuery = query.toLowerCase();
		return this.getEnabledSkills().filter(
			(skill) =>
				skill.name.toLowerCase().includes(lowerQuery) ||
				skill.description.toLowerCase().includes(lowerQuery)
		);
	}

	/**
	 * Get count of registered skills
	 */
	get count(): number {
		return this.skills.size;
	}

	/**
	 * Check if registry is initialized
	 */
	get isInitialized(): boolean {
		return this.initialized;
	}
}

// Singleton instance
let registryInstance: SkillRegistry | null = null;

/**
 * Get the skill registry singleton
 */
export function getSkillRegistry(): SkillRegistry {
	if (!registryInstance) {
		registryInstance = new SkillRegistry();
	}
	return registryInstance;
}

/**
 * Initialize the skill registry (call on server startup)
 */
export async function initializeSkillRegistry(): Promise<SkillRegistry> {
	const registry = getSkillRegistry();
	await registry.initialize();
	return registry;
}

/**
 * Detect which skills should be activated based on context
 * This implements the "progressive disclosure" pattern
 */
export function detectSkillsForActivation(
	context: SkillActivationContext,
	settings: SkillSettings
): SkillActivationResult {
	const registry = getSkillRegistry();
	const activatedSkills: Skill[] = [];
	const activationReasons: Record<string, string> = {};

	// Get skills enabled for this user
	const userEnabledSkillIds = settings.enabledSkills;

	// Check conversation-specific overrides
	const conversationSkillIds = context.conversationId
		? settings.conversationSkillOverrides?.[context.conversationId]
		: undefined;

	const relevantSkillIds = conversationSkillIds ?? userEnabledSkillIds;

	// Get all candidate skills
	const candidateSkills = registry.getSkillsByIds(relevantSkillIds);

	// Simple keyword-based activation for now
	// In production, this could use embeddings or LLM-based matching
	const messageWords = context.messageContent.toLowerCase().split(/\s+/);

	for (const skill of candidateSkills) {
		// Check if the skill's description or name matches message keywords
		const skillKeywords = [
			...skill.name.toLowerCase().split("-"),
			...skill.description.toLowerCase().split(/\s+/),
			...(skill.tags?.map((t) => t.toLowerCase()) ?? []),
		];

		// Look for keyword matches
		const matchedKeywords = messageWords.filter((word) =>
			skillKeywords.some((keyword) => keyword.includes(word) || word.includes(keyword))
		);

		if (matchedKeywords.length > 0) {
			activatedSkills.push(skill);
			activationReasons[skill.id] = `Matched keywords: ${matchedKeywords.join(", ")}`;
		}

		// Check for explicit skill mentions
		if (context.messageContent.toLowerCase().includes(skill.name.replace(/-/g, " "))) {
			if (!activatedSkills.includes(skill)) {
				activatedSkills.push(skill);
				activationReasons[skill.id] = "Explicitly mentioned in message";
			}
		}
	}

	// Also check if skill was previously activated in conversation
	if (context.previouslyActivatedSkills) {
		for (const skillId of context.previouslyActivatedSkills) {
			const skill = registry.getSkill(skillId);
			if (skill && !activatedSkills.includes(skill)) {
				activatedSkills.push(skill);
				activationReasons[skill.id] = "Previously activated in conversation";
			}
		}
	}

	return {
		activatedSkills,
		activationReasons,
	};
}

/**
 * Build the skills prompt section for injection into preprompt
 */
export function buildSkillsPrompt(
	activatedSkills: Skill[],
	allSkillsManifest: SkillManifestEntry[]
): string {
	if (activatedSkills.length === 0 && allSkillsManifest.length === 0) {
		return "";
	}

	let prompt = "\n\n# Available Skills\n\n";

	// Show manifest of all available skills (progressive disclosure)
	if (allSkillsManifest.length > 0) {
		prompt += "The following skills are available to enhance your responses:\n\n";
		for (const entry of allSkillsManifest) {
			prompt += `- **${entry.name}**: ${entry.description}\n`;
		}
		prompt += "\n";
	}

	// Include full instructions for activated skills
	if (activatedSkills.length > 0) {
		prompt += "## Active Skills\n\n";
		prompt += "The following skills have been activated for this conversation:\n\n";

		for (const skill of activatedSkills) {
			prompt += `### ${skill.name}\n\n`;
			prompt += skill.instructions;
			prompt += "\n\n";
		}
	}

	return prompt;
}
