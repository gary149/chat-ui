import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = () => {
	error(410, "Deprecated. Use POST /api/v2/conversations/:id/stop-generating instead.");
};
