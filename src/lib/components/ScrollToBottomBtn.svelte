<script lang="ts">
	import { fade } from "svelte/transition";
	import IconChevron from "./icons/IconChevron.svelte";

	// Threshold for showing the button - matches snapScrollToBottom's BOTTOM_THRESHOLD
	const VISIBILITY_THRESHOLD = 100;

	interface Props {
		scrollNode: HTMLElement | undefined;
		class?: string;
	}

	let { scrollNode, class: className = "" }: Props = $props();

	let visible = $state(false);
	let observer: ResizeObserver | null = $state(null);

	function updateVisibility() {
		if (!scrollNode) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollNode;
		// Show button when user has scrolled up more than the threshold
		visible = scrollHeight - scrollTop - clientHeight > VISIBILITY_THRESHOLD;
	}

	function destroy() {
		observer?.disconnect();
		scrollNode?.removeEventListener("scroll", updateVisibility);
	}

	const cleanup = $effect.root(() => {
		$effect(() => {
			if (scrollNode) {
				if (typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(() => updateVisibility());
					observer.observe(scrollNode);
					// Also observe content for size changes
					const contentWrapper = scrollNode.firstElementChild;
					if (contentWrapper) {
						observer.observe(contentWrapper);
					}
				}
				scrollNode.addEventListener("scroll", updateVisibility, { passive: true });
				// Initial visibility check
				updateVisibility();
			}
		});
		return () => destroy();
	});
</script>

{#if visible && scrollNode}
	<button
		transition:fade={{ duration: 150 }}
		onclick={() => scrollNode?.scrollTo({ top: scrollNode.scrollHeight, behavior: "smooth" })}
		class="btn absolute flex h-[41px] w-[41px] rounded-full border bg-white shadow-md transition-all hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:shadow-gray-950 dark:hover:bg-gray-600 {className}"
		><IconChevron classNames="mt-[2px]" /></button
	>
{/if}
