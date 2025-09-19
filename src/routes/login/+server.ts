import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";

export async function GET({ url }) {
	throw redirect(307, `${base}/api/v2/login${url.search}`);
}
