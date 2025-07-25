<script lang="ts">
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	import ChatWindow from "$lib/components/chat/ChatWindow.svelte";
	import { ERROR_MESSAGES, error } from "$lib/stores/errors";
	import { pendingMessage } from "$lib/stores/pendingMessage";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { findCurrentModel } from "$lib/utils/models";
	import { onMount } from "svelte";

	let { data } = $props();
	let loading = $state(false);
	let files: File[] = $state([]);

	const settings = useSettingsStore();

	async function createConversation(message: string) {
		try {
			loading = true;

			// check if $settings.activeModel is a valid model
			// else use the first model

			const validModels = data.models.map((model) => model.id);

			let model;
			if (validModels.includes($settings.activeModel)) {
				model = $settings.activeModel;
			} else {
				model = data.models[0].id;
			}
			const res = await fetch(`${base}/conversation`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					preprompt: $settings.customPrompts[$settings.activeModel],
				}),
			});

			if (!res.ok) {
				const errorMessage = (await res.json()).message || ERROR_MESSAGES.default;
				error.set(errorMessage);
				console.error("Error while creating conversation: ", errorMessage);
				return;
			}

			const { conversationId } = await res.json();

			// Ugly hack to use a store as temp storage, feel free to improve ^^
			pendingMessage.set({
				content: message,
				files,
			});

			// invalidateAll to update list of conversations
			await goto(`${base}/conversation/${conversationId}`, { invalidateAll: true });
		} catch (err) {
			error.set((err as Error).message || ERROR_MESSAGES.default);
			console.error(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// check if there's a ?q query param with a message
		const query = page.url.searchParams.get("q");
		if (query) createConversation(query);
	});

	let currentModel = $derived(
		findCurrentModel(
			[...data.models, ...data.oldModels],
			$settings.activeModel
		)
	);
</script>

<svelte:head>
	<title>{publicConfig.PUBLIC_APP_NAME}</title>
</svelte:head>

<ChatWindow
	on:message={(ev) => createConversation(ev.detail)}
	{loading}
	{currentModel}
	models={data.models}
	bind:files
/>
