<script lang="ts">
	import Switch from "../Switch.svelte";
	import type { Skill } from "$lib/types/Skill";

	interface Props {
		skill: Skill & { isEnabled: boolean };
		onToggle: (skillId: string, enabled: boolean) => void;
	}

	let { skill, onToggle }: Props = $props();

	let isEnabled = $state(skill.isEnabled);

	// Watch for changes to isEnabled and call onToggle
	$effect(() => {
		if (isEnabled !== skill.isEnabled) {
			onToggle(skill.id, isEnabled);
		}
	});
</script>

<div
	class="flex items-start gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
>
	<div class="flex-1">
		<div class="flex items-center gap-2">
			<h3 class="font-semibold text-gray-900 dark:text-gray-100">
				{skill.name}
			</h3>
			{#if skill.source !== "builtin"}
				<span
					class="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-400"
				>
					{skill.source}
				</span>
			{/if}
		</div>
		<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
			{skill.description}
		</p>
		{#if skill.tags && skill.tags.length > 0}
			<div class="mt-2 flex flex-wrap gap-1">
				{#each skill.tags as tag}
					<span
						class="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200"
					>
						{tag}
					</span>
				{/each}
			</div>
		{/if}
	</div>
	<div class="flex-shrink-0">
		<Switch name={`skill-${skill.id}`} bind:checked={isEnabled} />
	</div>
</div>
