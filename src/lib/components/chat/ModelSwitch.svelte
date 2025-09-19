<script lang="ts">
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import type { Model } from "$lib/types/Model";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import { parseTreatyError } from "$lib/utils/apiError";

	interface Props {
		models: Model[];
		currentModel: Model;
	}

	let { models, currentModel }: Props = $props();

	let selectedModelId = $state(
		models.map((m) => m.id).includes(currentModel.id) ? currentModel.id : models[0].id
	);

	const client = useAPIClient();

	function getErrorMessage(error: unknown) {
		return parseTreatyError(error, "Failed to update model");
	}

	async function handleModelChange() {
		if (!page.params.id) return;

		try {
			await client
				.conversations({ id: page.params.id })
				.patch({ model: selectedModelId })
				.then(handleResponse);

			await invalidateAll();
		} catch (error) {
			const message = getErrorMessage(error);
			console.error(error);
			if (typeof window !== "undefined") {
				window.alert?.(message);
			}
		}
	}
</script>

<div
	class="mx-auto mt-0 flex w-fit flex-col items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-500/20 p-4 dark:border-gray-800"
>
	<span>
		This model is no longer available. Switch to a new one to continue this conversation:
	</span>
	<div class="flex items-center space-x-2">
		<select
			bind:value={selectedModelId}
			class="rounded-md bg-gray-100 px-2 py-1 dark:bg-gray-900 max-sm:max-w-32"
		>
			{#each models as model}
				<option value={model.id}>{model.name}</option>
			{/each}
		</select>
		<button
			onclick={handleModelChange}
			disabled={selectedModelId === currentModel.id}
			class="rounded-md bg-gray-100 px-2 py-1 dark:bg-gray-900"
		>
			Accept
		</button>
	</div>
</div>
