import { config } from "$lib/server/config";
import JSON5 from "json5";
import { z } from "zod";

export const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};

export const allowedUserEmails = z
	.array(z.string().email())
	.optional()
	.default([])
	.parse(JSON5.parse(sanitizeJSONEnv(config.ALLOWED_USER_EMAILS, "[]")));

export const allowedUserDomains = z
	.array(z.string().regex(/\.\w+$/))
	.optional()
	.default([])
	.parse(JSON5.parse(sanitizeJSONEnv(config.ALLOWED_USER_DOMAINS, "[]")));

export const alternativeRedirectUrls = z
	.array(z.string())
	.optional()
	.default([])
	.parse(JSON5.parse(sanitizeJSONEnv(config.ALTERNATIVE_REDIRECT_URLS, "[]")));
