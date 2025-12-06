import { Elysia } from "elysia";
import { authPlugin } from "$api/authPlugin";
import { config } from "$lib/server/config";
import {
	getSkillRegistry,
	getSkillsWithStatus,
	enableSkill,
	disableSkill,
	parseSkillFromContent,
	getSkillSettings,
	saveSkillSettings,
} from "$lib/server/skills";
import { z } from "zod";

export const skillsGroup = new Elysia().use(authPlugin).group("/skills", (app) => {
	return app
		.get("/", async ({ locals, set }) => {
			// Check if skills are enabled
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			const skills = await getSkillsWithStatus(userId, sessionId);

			return skills.map((skill) => ({
				id: skill.id,
				name: skill.name,
				description: skill.description,
				tags: skill.tags,
				source: skill.source,
				version: skill.version,
				author: skill.author,
				isEnabled: skill.isEnabled,
			}));
		})
		.get("/:skillId", async ({ params, locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const registry = getSkillRegistry();
			const skill = registry.getSkill(params.skillId);

			if (!skill) {
				set.status = 404;
				return { error: "Skill not found" };
			}

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;
			const settings = await getSkillSettings(userId, sessionId);

			return {
				id: skill.id,
				name: skill.name,
				description: skill.description,
				instructions: skill.instructions,
				tags: skill.tags,
				source: skill.source,
				version: skill.version,
				author: skill.author,
				license: skill.license,
				isEnabled: settings.enabledSkills.includes(skill.id),
			};
		})
		.patch("/:skillId", async ({ params, request, locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const body = await request.json();
			const { enabled } = z.object({ enabled: z.boolean() }).parse(body);

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			if (!userId && !sessionId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const registry = getSkillRegistry();
			const skill = registry.getSkill(params.skillId);

			if (!skill) {
				set.status = 404;
				return { error: "Skill not found" };
			}

			if (enabled) {
				await enableSkill(params.skillId, userId, sessionId);
			} else {
				await disableSkill(params.skillId, userId, sessionId);
			}

			return { success: true };
		})
		.get("/settings", async ({ locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			const settings = await getSkillSettings(userId, sessionId);

			return {
				enabledSkills: settings.enabledSkills,
				conversationSkillOverrides: settings.conversationSkillOverrides ?? {},
			};
		})
		.post("/settings", async ({ request, locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const body = await request.json();
			const validatedBody = z
				.object({
					enabledSkills: z.array(z.string()).optional(),
					conversationSkillOverrides: z.record(z.array(z.string())).optional(),
				})
				.parse(body);

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			if (!userId && !sessionId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const currentSettings = await getSkillSettings(userId, sessionId);

			await saveSkillSettings(
				{
					...currentSettings,
					enabledSkills: validatedBody.enabledSkills ?? currentSettings.enabledSkills,
					conversationSkillOverrides:
						validatedBody.conversationSkillOverrides ?? currentSettings.conversationSkillOverrides,
				},
				userId,
				sessionId
			);

			return { success: true };
		})
		.post("/custom", async ({ request, locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			if (!userId && !sessionId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const body = await request.json();
			const { content } = z
				.object({
					content: z.string().min(1),
				})
				.parse(body);

			try {
				const skill = parseSkillFromContent(content, undefined, "user");

				// Add to user's custom skills
				const settings = await getSkillSettings(userId, sessionId);
				settings.customSkills = [...(settings.customSkills ?? []), skill];
				settings.enabledSkills.push(skill.id);
				await saveSkillSettings(settings, userId, sessionId);

				return {
					id: skill.id,
					name: skill.name,
					description: skill.description,
				};
			} catch (error) {
				set.status = 400;
				return {
					error: error instanceof Error ? error.message : "Invalid skill format",
				};
			}
		})
		.delete("/custom/:skillId", async ({ params, locals, set }) => {
			if (config.ENABLE_SKILLS !== "true") {
				set.status = 404;
				return { error: "Skills are not enabled" };
			}

			const userId = locals.user?._id?.toString();
			const sessionId = locals.sessionId;

			if (!userId && !sessionId) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const settings = await getSkillSettings(userId, sessionId);

			// Remove from custom skills
			settings.customSkills = (settings.customSkills ?? []).filter((s) => s.id !== params.skillId);

			// Remove from enabled skills
			settings.enabledSkills = settings.enabledSkills.filter((id) => id !== params.skillId);

			await saveSkillSettings(settings, userId, sessionId);

			return { success: true };
		});
});
