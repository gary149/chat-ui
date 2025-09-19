import { Elysia, error } from "elysia";
import { authPlugin } from "$api/authPlugin";
import { defaultModel, models, validateModel } from "$lib/server/models";
import { collections } from "$lib/server/database";
import {
	authCondition,
	getOIDCAuthorizationUrl,
	getOIDCUserData,
	requiresUser,
	serializeSessionCookie,
	serializeSessionDeletionCookie,
	validateAndParseCsrfToken,
} from "$lib/server/auth";
import { DEFAULT_SETTINGS, type SettingsEditable } from "$lib/types/Settings";
import { z } from "zod";
import { updateUser } from "$lib/server/oidc/updateUser";
import {
	allowedUserDomains,
	allowedUserEmails,
	alternativeRedirectUrls,
} from "$lib/server/oidc/policy";
import { base } from "$app/paths";
import { getRequestIp } from "$api/utils/ip";
import type { HttpError } from "@sveltejs/kit";
import { adminTokenManager } from "$lib/server/adminToken";

export const userGroup = new Elysia()
	.use(authPlugin)
	.get("/login", async ({ request, locals }) => {
		if (!requiresUser) {
			throw error(404, "OAuth login is not configured");
		}

		const url = new URL(request.url);
		const referer = request.headers.get("referer");
		let origin = url.origin;
		if (referer) {
			try {
				origin = new URL(referer).origin;
			} catch {
				origin = url.origin;
			}
		}

		const basePath = base ?? "";
		let redirectURI = `${origin}${basePath}/api/v2/login/callback`;
		const callback = url.searchParams.get("callback");
		if (callback && alternativeRedirectUrls.includes(callback)) {
			redirectURI = callback;
		}

		if (!locals.sessionId) {
			throw error(500, "Session not initialized");
		}

		const authorizationUrl = await getOIDCAuthorizationUrl(
			{ redirectURI },
			{ sessionId: locals.sessionId }
		);

		return new Response(null, {
			status: 302,
			headers: {
				Location: authorizationUrl,
			},
		});
	})
	.get("/login/callback", async ({ request, locals }) => {
		if (!requiresUser) {
			throw error(404, "OAuth login is not configured");
		}

		if (!locals.sessionId) {
			throw error(403, "Missing session");
		}

		const url = new URL(request.url);
		const entries = Object.fromEntries(url.searchParams.entries());

		const { error: errorName, error_description: errorDescription } = z
			.object({
				error: z.string().optional(),
				error_description: z.string().optional(),
			})
			.parse(entries);

		if (errorName) {
			throw error(400, errorName + (errorDescription ? `: ${errorDescription}` : ""));
		}

		const { code, state, iss } = z
			.object({
				code: z.string(),
				state: z.string(),
				iss: z.string().optional(),
			})
			.parse(entries);

		const csrfToken = Buffer.from(state, "base64").toString("utf-8");
		const validatedToken = await validateAndParseCsrfToken(csrfToken, locals.sessionId);

		if (!validatedToken) {
			throw error(403, "Invalid or expired CSRF token");
		}

		const { userData } = await getOIDCUserData(
			{ redirectURI: validatedToken.redirectUrl },
			code,
			iss
		);

		if (allowedUserEmails.length > 0 || allowedUserDomains.length > 0) {
			const userEmail = userData.email;
			if (!userEmail) {
				throw error(403, "User not allowed: email not returned");
			}

			const emailVerified = userData.email_verified ?? true;
			if (!emailVerified) {
				throw error(403, "User not allowed: email not verified");
			}

			const emailDomain = userEmail.split("@")[1];
			const isEmailAllowed = allowedUserEmails.includes(userEmail);
			const isDomainAllowed = emailDomain ? allowedUserDomains.includes(emailDomain) : false;

			if (!isEmailAllowed && !isDomainAllowed) {
				throw error(403, "User not allowed");
			}
		}

		let sessionCookie: string | undefined;
		try {
			await updateUser({
				userData,
				locals,
				setSessionCookie: (sessionSecret) => {
					sessionCookie = serializeSessionCookie(sessionSecret);
				},
				userAgent: request.headers.get("user-agent") ?? undefined,
				ip: getRequestIp(request),
			});
		} catch (err) {
			if (err && typeof err === "object" && "status" in err) {
				const httpErr = err as HttpError;
				throw error(httpErr.status, httpErr.body?.message ?? httpErr.message ?? "Login failed");
			}
			throw err;
		}

		const headers: Record<string, string> = { Location: `${base}/` };
		if (sessionCookie) {
			headers["Set-Cookie"] = sessionCookie;
		}

		return new Response(null, {
			status: 302,
			headers,
		});
	})
	.post("/logout", async ({ locals }) => {
		if (locals.sessionId) {
			await collections.sessions.deleteOne({ sessionId: locals.sessionId });
		}

		return new Response(null, {
			status: 204,
			headers: {
				"Set-Cookie": serializeSessionDeletionCookie(),
			},
		});
	})
	.group("/user", (app) => {
		const serializeSettings = async (locals: Parameters<typeof authCondition>[0]) => {
			const filter = authCondition(locals);
			const original = await collections.settings.findOne(filter);

			let settings = original ? { ...original } : undefined;

			if (settings && !validateModel(models).safeParse(settings.activeModel).success) {
				settings.activeModel = defaultModel.id;
				await collections.settings.updateOne(filter, {
					$set: { activeModel: defaultModel.id, updatedAt: new Date() },
				});
			}

			if (
				settings?.activeModel &&
				models.find((m) => m.id === settings.activeModel)?.unlisted === true
			) {
				settings.activeModel = defaultModel.id;
				await collections.settings.updateOne(filter, {
					$set: { activeModel: defaultModel.id, updatedAt: new Date() },
				});
			}

			return {
				welcomeModalSeen: !!settings?.welcomeModalSeenAt,
				welcomeModalSeenAt: settings?.welcomeModalSeenAt ?? null,
				activeModel: settings?.activeModel ?? DEFAULT_SETTINGS.activeModel,
				disableStream: settings?.disableStream ?? DEFAULT_SETTINGS.disableStream,
				directPaste: settings?.directPaste ?? DEFAULT_SETTINGS.directPaste,
				hidePromptExamples: settings?.hidePromptExamples ?? DEFAULT_SETTINGS.hidePromptExamples,
				shareConversationsWithModelAuthors:
					settings?.shareConversationsWithModelAuthors ??
					DEFAULT_SETTINGS.shareConversationsWithModelAuthors,
				customPrompts: settings?.customPrompts ?? {},
				multimodalOverrides: settings?.multimodalOverrides ?? {},
			};
		};

		return app
			.get("/", ({ locals }) => {
				return locals.user
					? {
							id: locals.user._id.toString(),
							username: locals.user.username,
							avatarUrl: locals.user.avatarUrl,
							email: locals.user.email,
							logoutDisabled: locals.user.logoutDisabled,
							isAdmin: locals.user.isAdmin ?? false,
							isEarlyAccess: locals.user.isEarlyAccess ?? false,
						}
					: null;
			})
			.get("/settings", async ({ locals }) => serializeSettings(locals))
			.post("/settings", async ({ locals, request }) => {
				const body = await request.json();

				const { welcomeModalSeen, ...settings } = z
					.object({
						shareConversationsWithModelAuthors: z
							.boolean()
							.default(DEFAULT_SETTINGS.shareConversationsWithModelAuthors),
						welcomeModalSeen: z.boolean().optional(),
						activeModel: z.string().default(DEFAULT_SETTINGS.activeModel),
						customPrompts: z.record(z.string()).default({}),
						multimodalOverrides: z.record(z.boolean()).default({}),
						disableStream: z.boolean().default(false),
						directPaste: z.boolean().default(false),
						hidePromptExamples: z.record(z.boolean()).default({}),
					})
					.parse(body) satisfies SettingsEditable;

				// Tools removed: ignore tools updates

				await collections.settings.updateOne(
					authCondition(locals),
					{
						$set: {
							...settings,
							...(welcomeModalSeen && { welcomeModalSeenAt: new Date() }),
							updatedAt: new Date(),
						},
						$setOnInsert: {
							createdAt: new Date(),
						},
					},
					{
						upsert: true,
					}
				);
				return Response.json(await serializeSettings(locals));
			})
			.post("/validate-token", async ({ locals, request }) => {
				const body = await request.json();
				const parsed = z.object({ token: z.string() }).safeParse(body);
				if (!parsed.success) {
					throw error(400, "Invalid token");
				}

				if (!locals.sessionId) {
					throw error(401, "Missing session");
				}

				const valid = adminTokenManager.checkToken(parsed.data.token, locals.sessionId);
				return { valid };
			})
			.get("/reports", async ({ locals }) => {
				if (!locals.user || !locals.sessionId) {
					return [];
				}

				const reports = await collections.reports
					.find({
						createdBy: locals.user?._id ?? locals.sessionId,
					})
					.toArray();
				return reports;
			});
	});
