import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";

export async function POST({ url }) {
	throw redirect(307, `${base}/api/v2/logout${url.search}`);
}
