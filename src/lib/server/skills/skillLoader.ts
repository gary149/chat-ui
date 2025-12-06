import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import type { Skill, SkillFrontmatter } from "$lib/types/Skill";
import { logger } from "../logger";

/**
 * Zod schema for validating skill frontmatter
 */
const skillFrontmatterSchema = z.object({
	name: z
		.string()
		.min(1)
		.regex(/^[a-z0-9-]+$/, "Name must be lowercase with hyphens"),
	description: z.string().min(1),
	license: z.string().optional(),
	version: z.string().optional(),
	author: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

/**
 * Parse YAML frontmatter from a markdown string
 * Format:
 * ---
 * key: value
 * ---
 * markdown content
 */
export function parseSkillMarkdown(content: string): {
	frontmatter: SkillFrontmatter;
	instructions: string;
} {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		throw new Error("Invalid SKILL.md format: missing YAML frontmatter");
	}

	const [, yamlContent, markdownContent] = match;

	// Parse YAML manually (simple key: value format)
	const frontmatter: Record<string, unknown> = {};
	const lines = yamlContent.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Handle arrays (tags: ["tag1", "tag2"] or tags: [tag1, tag2])
		const arrayMatch = trimmed.match(/^(\w+):\s*\[(.*)\]$/);
		if (arrayMatch) {
			const [, key, values] = arrayMatch;
			frontmatter[key] = values
				.split(",")
				.map((v) => v.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			continue;
		}

		// Handle quoted strings
		const quotedMatch = trimmed.match(/^(\w+):\s*["'](.*)["']$/);
		if (quotedMatch) {
			const [, key, value] = quotedMatch;
			frontmatter[key] = value;
			continue;
		}

		// Handle simple key: value
		const simpleMatch = trimmed.match(/^(\w+):\s*(.*)$/);
		if (simpleMatch) {
			const [, key, value] = simpleMatch;
			frontmatter[key] = value;
		}
	}

	// Validate frontmatter
	const validated = skillFrontmatterSchema.parse(frontmatter);

	return {
		frontmatter: validated,
		instructions: markdownContent.trim(),
	};
}

/**
 * Load a skill from a directory containing SKILL.md
 */
export async function loadSkillFromDirectory(
	dirPath: string,
	source: Skill["source"] = "builtin"
): Promise<Skill> {
	const skillMdPath = path.join(dirPath, "SKILL.md");

	try {
		const content = await fs.readFile(skillMdPath, "utf-8");
		const { frontmatter, instructions } = parseSkillMarkdown(content);

		// Get list of additional resources
		const files = await fs.readdir(dirPath);
		const resources = files.filter(
			(f) => f !== "SKILL.md" && !f.startsWith(".") && !f.endsWith(".ts")
		);

		const skill: Skill = {
			id: frontmatter.name,
			...frontmatter,
			instructions,
			source,
			resourcesPath: dirPath,
			resources,
			enabled: true,
		};

		return skill;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(`SKILL.md not found in ${dirPath}`);
		}
		throw error;
	}
}

/**
 * Load all skills from a directory containing skill folders
 */
export async function loadSkillsFromDirectory(
	basePath: string,
	source: Skill["source"] = "builtin"
): Promise<Skill[]> {
	const skills: Skill[] = [];

	try {
		const entries = await fs.readdir(basePath, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const skillPath = path.join(basePath, entry.name);
			const skillMdPath = path.join(skillPath, "SKILL.md");

			// Check if SKILL.md exists
			try {
				await fs.access(skillMdPath);
				const skill = await loadSkillFromDirectory(skillPath, source);
				skills.push(skill);
				logger.info(`Loaded skill: ${skill.name}`);
			} catch {
				// Skip directories without SKILL.md
				continue;
			}
		}
	} catch (error) {
		logger.error(`Failed to load skills from ${basePath}:`, error);
	}

	return skills;
}

/**
 * Parse a skill from raw markdown content (for user uploads or API)
 */
export function parseSkillFromContent(
	content: string,
	id?: string,
	source: Skill["source"] = "user"
): Skill {
	const { frontmatter, instructions } = parseSkillMarkdown(content);

	return {
		id: id ?? frontmatter.name,
		...frontmatter,
		instructions,
		source,
		enabled: true,
	};
}

/**
 * Fetch a skill from a remote URL (e.g., GitHub raw URL)
 */
export async function fetchSkillFromUrl(
	url: string,
	source: Skill["source"] = "repository"
): Promise<Skill> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch skill: ${response.status} ${response.statusText}`);
		}

		const content = await response.text();
		const skill = parseSkillFromContent(content, undefined, source);
		skill.repositoryUrl = url;

		return skill;
	} catch (error) {
		logger.error(`Failed to fetch skill from ${url}:`, error);
		throw error;
	}
}

/**
 * Validate a skill object
 */
export function validateSkill(skill: unknown): skill is Skill {
	try {
		const schema = z.object({
			id: z.string().min(1),
			name: z.string().min(1),
			description: z.string().min(1),
			instructions: z.string().min(1),
			source: z.enum(["builtin", "user", "repository"]),
			enabled: z.boolean(),
			license: z.string().optional(),
			version: z.string().optional(),
			author: z.string().optional(),
			tags: z.array(z.string()).optional(),
			repositoryUrl: z.string().optional(),
			resourcesPath: z.string().optional(),
			resources: z.array(z.string()).optional(),
		});

		schema.parse(skill);
		return true;
	} catch {
		return false;
	}
}
