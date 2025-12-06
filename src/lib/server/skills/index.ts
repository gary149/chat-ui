/**
 * Skills module - Anthropic Skills support for chat-ui
 *
 * Skills are self-contained instruction sets that enhance Claude's capabilities
 * for specific tasks. Each skill is defined by a SKILL.md file with YAML frontmatter
 * containing name and description, followed by markdown instructions.
 *
 * Features:
 * - Progressive disclosure: Only skill names/descriptions shown initially
 * - Dynamic activation: Skills loaded when relevant to the conversation
 * - Token efficient: Full instructions only injected when needed
 * - Extensible: Support for built-in, user-uploaded, and repository skills
 */

export {
	loadSkillFromDirectory,
	loadSkillsFromDirectory,
	parseSkillFromContent,
	parseSkillMarkdown,
	fetchSkillFromUrl,
	validateSkill,
} from "./skillLoader";

export {
	getSkillRegistry,
	initializeSkillRegistry,
	detectSkillsForActivation,
	buildSkillsPrompt,
} from "./skillRegistry";

export {
	enhancePrepromptWithSkills,
	getSkillSettings,
	saveSkillSettings,
	enableSkill,
	disableSkill,
	getSkillsWithStatus,
} from "./skillIntegration";

export type {
	Skill,
	SkillFrontmatter,
	SkillManifestEntry,
	SkillSettings,
	SkillActivationContext,
	SkillActivationResult,
	ConversationSkillState,
} from "$lib/types/Skill";

export { DEFAULT_SKILL_SETTINGS } from "$lib/types/Skill";
