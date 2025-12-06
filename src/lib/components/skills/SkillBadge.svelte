<script lang="ts">
	import CarbonWatsonHealthAiStatus from "~icons/carbon/watson-health-ai-status";

	interface Props {
		count: number;
		onclick?: () => void;
	}

	let { count, onclick }: Props = $props();
</script>

{#if count > 0}
	<button
		type="button"
		{onclick}
		class="flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800 transition-colors hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
		title={`${count} skill${count !== 1 ? "s" : ""} enabled`}
	>
		<CarbonWatsonHealthAiStatus class="h-3.5 w-3.5" />
		<span>{count}</span>
	</button>
{/if}
