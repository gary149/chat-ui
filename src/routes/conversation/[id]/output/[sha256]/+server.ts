import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => {
	error(410, "Deprecated. Use GET /api/v2/conversations/:id/output/:sha256 instead.");
};
