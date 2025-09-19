import { base } from "$app/paths";
import { page } from "$app/state";
import { handleResponse, useAPIClient } from "$lib/APIClient";
import type { Treaty } from "@elysiajs/eden";
import { parseTreatyError } from "$lib/utils/apiError";

// Returns a public share URL for a conversation id.
// If `id` is already a 7-char share id, no network call is made.
export async function createShareLink(id: string): Promise<string> {
	const prefix =
		page.data.publicConfig.PUBLIC_SHARE_PREFIX ||
		`${page.data.publicConfig.PUBLIC_ORIGIN || page.url.origin}${base}`;

	const client = useAPIClient();

	function getErrorMessage(error: unknown) {
		return parseTreatyError(error, "Failed to create share link");
	}

	if (id.length === 7) {
		return `${prefix}/r/${id}`;
	}

	try {
		const response = await client.conversations({ id }).share.post();
		const { shareId } = handleResponse<{ 200: { shareId: string } }>(
			response as Treaty.TreatyResponse<{ 200: { shareId: string } }>
		);

		return `${prefix}/r/${shareId}`;
	} catch (err) {
		throw new Error(getErrorMessage(err));
	}
}
