import { browser } from "$app/environment";
import { invalidate } from "$app/navigation";
import { UrlDependency } from "$lib/types/UrlDependency";
import { handleResponse, useAPIClient } from "$lib/APIClient";
import type { Treaty } from "@elysiajs/eden";
import { parseTreatyError } from "$lib/utils/apiError";
import { getContext, setContext } from "svelte";
import { type Writable, writable, get } from "svelte/store";

type SettingsStore = {
	shareConversationsWithModelAuthors: boolean;
	welcomeModalSeen: boolean;
	welcomeModalSeenAt: Date | null;
	activeModel: string;
	customPrompts: Record<string, string>;
	multimodalOverrides: Record<string, boolean>;
	recentlySaved: boolean;
	disableStream: boolean;
	directPaste: boolean;
	hidePromptExamples: Record<string, boolean>;
};

type SettingsStoreWritable = Writable<SettingsStore> & {
	instantSet: (settings: Partial<SettingsStore>) => Promise<void>;
};

export function useSettingsStore() {
	return getContext<SettingsStoreWritable>("settings");
}

export function createSettingsStore(initialValue: Omit<SettingsStore, "recentlySaved">) {
	const baseStore = writable({ ...initialValue, recentlySaved: false });

	let timeoutId: NodeJS.Timeout;
	const client = useAPIClient();

	type SettingsAPIResponse = {
		shareConversationsWithModelAuthors: boolean;
		welcomeModalSeen: boolean;
		welcomeModalSeenAt: string | null;
		activeModel: string;
		customPrompts: Record<string, string>;
		multimodalOverrides: Record<string, boolean>;
		disableStream: boolean;
		directPaste: boolean;
		hidePromptExamples: Record<string, boolean>;
	};

	const normalizeResponse = (data: SettingsAPIResponse): Omit<SettingsStore, "recentlySaved"> => ({
		shareConversationsWithModelAuthors: data.shareConversationsWithModelAuthors,
		welcomeModalSeen: data.welcomeModalSeen,
		welcomeModalSeenAt: data.welcomeModalSeenAt ? new Date(data.welcomeModalSeenAt) : null,
		activeModel: data.activeModel,
		customPrompts: data.customPrompts,
		multimodalOverrides: data.multimodalOverrides,
		disableStream: data.disableStream,
		directPaste: data.directPaste,
		hidePromptExamples: data.hidePromptExamples,
	});

	async function persistCurrent(): Promise<Omit<SettingsStore, "recentlySaved"> | null> {
		const snapshot = { ...get(baseStore) };
		const { recentlySaved: _recentlySaved, welcomeModalSeenAt: _ignored, ...payload } = snapshot;

		try {
			const response = await client.user.settings.post(payload);
			const normalized = normalizeResponse(
				handleResponse<{ 200: SettingsAPIResponse }>(
					response as Treaty.TreatyResponse<{ 200: SettingsAPIResponse }>
				)
			);
			invalidate(UrlDependency.ConversationList);
			return normalized;
		} catch (error) {
			const message = parseTreatyError(error, "Failed to save settings");
			console.error(message, error);
			return null;
		}
	}

	async function setSettings(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(async () => {
				const persisted = await persistCurrent();
				if (persisted) {
					baseStore.set({ ...persisted, recentlySaved: true });
					setTimeout(() => {
						baseStore.update((s) => ({
							...s,
							recentlySaved: false,
						}));
					}, 3000);
				}
			}, 300);
			// debounce server calls by 300ms
		}
	}
	async function instantSet(settings: Partial<SettingsStore>) {
		baseStore.update((s) => ({
			...s,
			...settings,
		}));

		if (browser) {
			const persisted = await persistCurrent();
			if (persisted) {
				const current = get(baseStore);
				baseStore.set({ ...persisted, recentlySaved: current.recentlySaved });
			}
		}
	}

	const newStore = {
		subscribe: baseStore.subscribe,
		set: setSettings,
		instantSet,
		update: (fn: (s: SettingsStore) => SettingsStore) => {
			setSettings(fn(get(baseStore)));
		},
	} satisfies SettingsStoreWritable;

	setContext("settings", newStore);

	return newStore;
}
