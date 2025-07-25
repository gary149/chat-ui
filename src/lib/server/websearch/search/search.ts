import type { WebSearchSource } from "$lib/types/WebSearch";
import type { Message } from "$lib/types/Message";
import { getWebSearchProvider, searchWeb } from "./endpoints";
import { generateQuery } from "./generateQuery";
import { isURLStringLocal } from "$lib/server/isURLLocal";
import { isURL } from "$lib/utils/isUrl";

import z from "zod";
import JSON5 from "json5";
import { config } from "$lib/server/config";
import { makeGeneralUpdate } from "../update";
import type { MessageWebSearchUpdate } from "$lib/types/MessageUpdate";

const listSchema = z.array(z.string()).default([]);
const allowList = listSchema.parse(JSON5.parse(config.WEBSEARCH_ALLOWLIST));
const blockList = listSchema.parse(JSON5.parse(config.WEBSEARCH_BLOCKLIST));

export async function* search(
	messages: Message[],
	query?: string
): AsyncGenerator<
	MessageWebSearchUpdate,
	{ searchQuery: string; pages: WebSearchSource[] },
	undefined
> {
	const searchQuery = query ?? (await generateQuery(messages));
	yield makeGeneralUpdate({ message: `Searching ${getWebSearchProvider()}`, args: [searchQuery] });

	// handle the global lists
	const filters = buildQueryFromSiteFilters(
		allowList,
		blockList
	);

	const searchQueryWithFilters = `${filters} ${searchQuery}`;
	const searchResults = await searchWeb(searchQueryWithFilters).then(filterByBlockList);

	return {
		searchQuery: searchQueryWithFilters,
		pages: searchResults,
	};
}

// ----------
// Utils
function filterByBlockList(results: WebSearchSource[]): WebSearchSource[] {
	return results.filter((result) => !blockList.some((blocked) => result.link.includes(blocked)));
}

function buildQueryFromSiteFilters(allow: string[], block: string[]) {
	return (
		allow.map((item) => "site:" + item).join(" OR ") +
		" " +
		block.map((item) => "-site:" + item).join(" ")
	);
}

async function directLinksToSource(links: string[]): Promise<WebSearchSource[]> {
	if (config.ENABLE_LOCAL_FETCH !== "true") {
		const localLinks = await Promise.all(links.map(isURLStringLocal));
		links = links.filter((_, index) => !localLinks[index]);
	}

	return links.filter(isURL).map((link) => ({
		link,
		title: "",
		text: [""],
	}));
}