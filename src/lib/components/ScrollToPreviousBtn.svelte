<script lang="ts">
	import { fade } from "svelte/transition";
	import { onDestroy, untrack } from "svelte";
	import IconChevron from "./icons/IconChevron.svelte";

	// Threshold for showing the button - consistent with ScrollToBottomBtn
	const VISIBILITY_THRESHOLD = 100;

	let visible = $state(false);
	interface Props {
		scrollNode: HTMLElement | undefined;
		class?: string;
	}

	let { scrollNode, class: className = "" }: Props = $props();
	let observer: ResizeObserver | null = $state(null);

	function updateVisibility() {
		if (!scrollNode) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollNode;
		// Show when scrolled up more than threshold AND not at the very top
		visible = scrollHeight - scrollTop - clientHeight > VISIBILITY_THRESHOLD && scrollTop > 100;
	}

	function scrollToPrevious() {
		if (!scrollNode) return;
		const messages = scrollNode.querySelectorAll("[data-message-id]");
		const scrollTop = scrollNode.scrollTop;
		let previousMessage: Element | null = null;

		for (let i = messages.length - 1; i >= 0; i--) {
			const messageTop =
				messages[i].getBoundingClientRect().top +
				scrollTop -
				scrollNode.getBoundingClientRect().top;
			if (messageTop < scrollTop - 1) {
				previousMessage = messages[i];
				break;
			}
		}

		if (previousMessage) {
			previousMessage.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	}

	function destroy() {
		observer?.disconnect();
		scrollNode?.removeEventListener("scroll", updateVisibility);
	}

	onDestroy(destroy);

	$effect(() => {
		scrollNode &&
			untrack(() => {
				if (scrollNode) {
					destroy();

					if (typeof ResizeObserver !== "undefined") {
						observer = new ResizeObserver(() => {
							updateVisibility();
						});
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
	});
</script>

{#if visible}
	<button
		transition:fade={{ duration: 150 }}
		onclick={scrollToPrevious}
		class="btn absolute flex h-[41px] w-[41px] rounded-full border bg-white shadow-md transition-all hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:shadow-gray-950 dark:hover:bg-gray-600 {className}"
	>
		<IconChevron classNames="rotate-180 mt-[2px]" />
	</button>
{/if}
