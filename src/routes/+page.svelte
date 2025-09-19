<script lang="ts">
	import { goto } from "$app/navigation";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import type { Treaty } from "@elysiajs/eden";
	import { parseTreatyError } from "$lib/utils/apiError";

	const publicConfig = usePublicConfig();

	import ChatWindow from "$lib/components/chat/ChatWindow.svelte";
	import { ERROR_MESSAGES, error } from "$lib/stores/errors";
	import { pendingMessage } from "$lib/stores/pendingMessage";
	import { useSettingsStore } from "$lib/stores/settings.js";
	import { findCurrentModel } from "$lib/utils/models";
	import { onMount } from "svelte";

	let { data } = $props();

	const client = useAPIClient();

	let hasModels = $derived(Boolean(data.models?.length));
	let loading = $state(false);
	let files: File[] = $state([]);

	const settings = useSettingsStore();

	function getErrorMessage(error: unknown) {
		return parseTreatyError(error, ERROR_MESSAGES.default);
	}

	async function createConversation(message: string) {
		try {
			loading = true;

			// check if $settings.activeModel is a valid model
			// else check if it's an assistant, and use that model
			// else use the first model

			const validModels = data.models.map((model) => model.id);

			let model;
			if (validModels.includes($settings.activeModel)) {
				model = $settings.activeModel;
			} else {
				model = data.models[0].id;
			}
			const response = await client.conversations.post({
				model,
				preprompt: $settings.customPrompts[$settings.activeModel],
			});

			const { conversationId } = handleResponse<{ 200: { conversationId: string } }>(
				response as Treaty.TreatyResponse<{ 200: { conversationId: string } }>
			);

			// Ugly hack to use a store as temp storage, feel free to improve ^^
			pendingMessage.set({
				content: message,
				files,
			});

			// invalidateAll to update list of conversations
			await goto(`${base}/conversation/${conversationId}`, { invalidateAll: true });
		} catch (err) {
			const message = getErrorMessage(err);
			error.set(message);
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
		findCurrentModel([...data.models, ...data.oldModels], $settings.activeModel)
	);
</script>

<svelte:head>
	<title>{publicConfig.PUBLIC_APP_NAME}</title>
</svelte:head>

{#if hasModels}
	<ChatWindow
		onmessage={(message) => createConversation(message)}
		{loading}
		{currentModel}
		models={data.models}
		bind:files
	/>
{:else}
	<div class="mx-auto my-20 max-w-xl rounded-xl border p-6 text-center dark:border-gray-700">
		<h2 class="mb-2 text-xl font-semibold">No models available</h2>
		<p class="text-gray-600 dark:text-gray-300">
			No chat models are configured. Set `OPENAI_BASE_URL` and ensure the server can reach the
			endpoint, then reload. If unset, the app defaults to the Hugging Face router.
		</p>
	</div>
{/if}
