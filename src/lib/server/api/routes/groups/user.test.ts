import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Elysia } from "elysia";
import { z } from "zod";
import { base } from "$app/paths";
import { collections, ready } from "$lib/server/database";

const COOKIE_NAME = "hf-chat-session";
const authorizationUrl = "https://auth.example/authorize";
const sessionCookieValue = `${COOKIE_NAME}=session-secret; Path=/; HttpOnly`;
const deletionCookieValue = `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly`;

const getOIDCAuthorizationUrlMock = vi.fn(async () => authorizationUrl);
const validateAndParseCsrfTokenMock = vi.fn(async () => ({
	redirectUrl: "https://app.example/api/v2/login/callback",
}));
const getOIDCUserDataMock = vi.fn(async () => ({
	userData: {
		email: "tester@example.com",
		email_verified: true,
	},
}));
const checkTokenMock = vi.fn(() => false);

const updateUserMock = vi.fn(
	async ({ setSessionCookie }: { setSessionCookie: (secret: string) => void }) => {
		setSessionCookie("session-secret");
	}
);

vi.mock("$api/authPlugin", () => {
	const plugin = new Elysia({ name: "test-auth" }).derive({ as: "scoped" }, () => ({
		locals: {
			user: { _id: "user-id" },
			sessionId: "test-session",
			isAdmin: false,
		},
	}));
	return { authPlugin: plugin };
});

vi.mock("$lib/server/database", () => {
	const sessions = new Map<string, any>();
	return {
		collections: {
			sessions: {
				async insertOne(doc: any) {
					sessions.set(doc.sessionId, doc);
					return { insertedId: doc.sessionId };
				},
				async deleteOne(filter: { sessionId: string }) {
					const deleted = sessions.delete(filter.sessionId);
					return { deletedCount: deleted ? 1 : 0 };
				},
				async deleteMany(filter?: { sessionId?: string }) {
					if (!filter?.sessionId) {
						const count = sessions.size;
						sessions.clear();
						return { deletedCount: count };
					}
					const deleted = sessions.delete(filter.sessionId);
					return { deletedCount: deleted ? 1 : 0 };
				},
				async countDocuments(filter: { sessionId: string }) {
					return sessions.has(filter.sessionId) ? 1 : 0;
				},
			},
			settings: {
				async findOne() {
					return null;
				},
				async updateOne() {
					return { matchedCount: 0 };
				},
			},
			reports: {
				find: () => ({ toArray: async () => [] }),
			},
		},
		ready: Promise.resolve(),
	};
});

vi.mock("$lib/server/auth", () => ({
	authCondition: vi.fn(() => ({ userId: "user-id" })),
	getOIDCAuthorizationUrl: getOIDCAuthorizationUrlMock,
	getOIDCUserData: getOIDCUserDataMock,
	requiresUser: true,
	serializeSessionCookie: vi.fn(() => sessionCookieValue),
	serializeSessionDeletionCookie: vi.fn(() => deletionCookieValue),
	validateAndParseCsrfToken: validateAndParseCsrfTokenMock,
}));

vi.mock("$lib/server/oidc/updateUser", () => ({
	updateUser: updateUserMock,
}));

vi.mock("$lib/server/adminToken", () => ({
	adminTokenManager: {
		enabled: true,
		checkToken: checkTokenMock,
		isAdmin: vi.fn(() => false),
		removeSession: vi.fn(),
		displayToken: vi.fn(),
	},
}));

vi.mock("$lib/server/models", () => ({
	defaultModel: { id: "test-model" },
	models: [{ id: "test-model", unlisted: false }],
	validateModel: () => z.enum(["test-model"] as [string]),
}));

vi.mock("$lib/server/oidc/policy", () => ({
	allowedUserDomains: [] as string[],
	allowedUserEmails: [] as string[],
	alternativeRedirectUrls: [] as string[],
}));

const { userGroup } = await import("$lib/server/api/routes/groups/user");

const app = new Elysia().use(userGroup);

describe("userGroup auth endpoints", () => {
	beforeAll(async () => {
		await ready;
	});

	beforeEach(async () => {
		getOIDCAuthorizationUrlMock.mockClear();
		validateAndParseCsrfTokenMock.mockClear();
		getOIDCUserDataMock.mockClear();
		updateUserMock.mockClear();
		checkTokenMock.mockReset();
		await collections.sessions.deleteMany({ sessionId: "test-session" });
	});

	it("redirects to provider on /login", async () => {
		const response = await app.handle(new Request("http://localhost/login"));

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(authorizationUrl);
		expect(getOIDCAuthorizationUrlMock).toHaveBeenCalledTimes(1);
		const [[settings]] = getOIDCAuthorizationUrlMock.mock.calls;
		expect(settings.redirectURI).toContain("/api/v2/login/callback");
	});

	it("processes callback and sets session cookie", async () => {
		const params = new URLSearchParams({
			code: "abc",
			state: Buffer.from("csrf").toString("base64"),
		});
		const response = await app.handle(
			new Request(`http://localhost/login/callback?${params}`, {
				headers: {
					cookie: `${COOKIE_NAME}=session-secret`,
				},
			})
		);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(`${base}/`);
		expect(response.headers.get("Set-Cookie")).toBe(sessionCookieValue);
		expect(validateAndParseCsrfTokenMock).toHaveBeenCalledTimes(1);
		expect(getOIDCUserDataMock).toHaveBeenCalledTimes(1);
		expect(updateUserMock).toHaveBeenCalledTimes(1);
	});

	it("logs out and clears session", async () => {
		await collections.sessions.insertOne({
			sessionId: "test-session",
			createdAt: new Date(),
			updatedAt: new Date(),
			expiresAt: new Date(),
		});

		const response = await app.handle(
			new Request("http://localhost/logout", {
				method: "POST",
			})
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("Set-Cookie")).toBe(deletionCookieValue);
		const remaining = await collections.sessions.countDocuments({ sessionId: "test-session" });
		expect(remaining).toBe(0);
	});

	it("validates admin token", async () => {
		checkTokenMock.mockReturnValueOnce(true);

		const response = await app.handle(
			new Request("http://localhost/user/validate-token", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "secret" }),
			})
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ valid: true });
		expect(checkTokenMock).toHaveBeenCalledWith("secret", "test-session");
	});

	it("rejects invalid validate-token payload", async () => {
		const response = await app.handle(
			new Request("http://localhost/user/validate-token", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			})
		);

		expect(response.status).toBe(400);
	});
});
