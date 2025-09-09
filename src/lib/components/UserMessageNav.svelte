<script lang="ts">
	import { onDestroy } from "svelte";

	interface Props {
		scrollNode: HTMLElement;
		class?: string;
	}

	let { scrollNode, class: className = "" }: Props = $props();

	let assistantEls: Element[] = $state([]);
	let elToIndex = new Map<Element, number>();
	let activeIndex = $state(0);
	// imperative handles: keep them out of Svelte reactivity
	let mutationObserver: MutationObserver | null = null;
	let io: IntersectionObserver | null = null;
	const visibleDistances = new Map<number, number>();

	function getTopRelativeToContainer(el: Element) {
		const rect = (el as HTMLElement).getBoundingClientRect();
		const crect = scrollNode.getBoundingClientRect();
		// position of element's top in the scroll coordinate system
		return rect.top - crect.top + scrollNode.scrollTop;
	}

	function updateAssistantEls() {
		if (!scrollNode) return;
		const next = Array.from(scrollNode.querySelectorAll('[data-message-type="user"]'));
		// If same nodes, skip re-init
		if (assistantEls.length === next.length && assistantEls.every((el, i) => el === next[i])) {
			return;
		}
		// disconnect previous observer
		io?.disconnect();
		io = new IntersectionObserver(onIntersect, {
			root: scrollNode,
			rootMargin: "0px",
			threshold: [0, 0.25, 0.5, 0.75, 1],
		});

		assistantEls = next;
		elToIndex = new Map(assistantEls.map((el, i) => [el, i] as const));
		visibleDistances.clear();
		for (const el of assistantEls) io.observe(el);
		// keep active index within bounds
		if (assistantEls.length === 0) {
			activeIndex = 0;
		} else if (activeIndex >= assistantEls.length) {
			activeIndex = assistantEls.length - 1;
		}
		updateActiveIndex();
	}

	function updateActiveIndex() {
		if (!scrollNode || assistantEls.length === 0) return;
		if (visibleDistances.size > 0) {
			// choose visible one closest to top
			let bestIdx = activeIndex;
			let bestDist = Infinity;
			for (const [idx, dist] of visibleDistances) {
				if (dist < bestDist) {
					bestDist = dist;
					bestIdx = idx;
				}
			}
			if (activeIndex !== bestIdx) activeIndex = bestIdx;
			return;
		}
		// Fallback: choose nearest by absolute top distance
		const scrollTop = scrollNode.scrollTop;
		let bestIdx = 0;
		let bestDist = Infinity;
		for (let i = 0; i < assistantEls.length; i++) {
			const top = getTopRelativeToContainer(assistantEls[i]);
			const dist = Math.abs(top - scrollTop);
			if (dist < bestDist) {
				bestDist = dist;
				bestIdx = i;
			}
		}
		if (activeIndex !== bestIdx) activeIndex = bestIdx;
	}

	function onIntersect(entries: IntersectionObserverEntry[]) {
		for (const entry of entries) {
			const idx = elToIndex.get(entry.target) ?? -1;
			if (idx === -1) continue;
			const rootTop = entry.rootBounds?.top ?? 0;
			const dist = Math.abs(entry.boundingClientRect.top - rootTop);
			if (entry.isIntersecting) {
				visibleDistances.set(idx, dist);
			} else {
				visibleDistances.delete(idx);
			}
		}
		updateActiveIndex();
	}

	const TOP_OFFSET_PX = 32; // add a bit of padding from the top
	function scrollToIndex(i: number) {
		const el = assistantEls[i] as HTMLElement | undefined;
		if (!el) return;
		// compute target top with offset so the message isn't glued to the top
		const targetTop = Math.max(0, getTopRelativeToContainer(el) - TOP_OFFSET_PX);
		scrollNode.scrollTo({ top: targetTop, behavior: "smooth" });
	}

	function setup() {
		if (!scrollNode) return;

		// Defer initial scan to keep effect deps minimal
		queueMicrotask(updateAssistantEls);

		// Watch only for message nodes being added/removed on the direct wrapper
		const firstAssistant = scrollNode.querySelector('[data-message-type="user"]');
		const wrapper = firstAssistant?.parentElement ?? scrollNode;
		mutationObserver = new MutationObserver(() => updateAssistantEls());
		mutationObserver.observe(wrapper, { childList: true });
	}

	function teardown() {
		io?.disconnect();
		io = null;
		mutationObserver?.disconnect();
		mutationObserver = null;
	}

	onDestroy(teardown);

	$effect(() => {
		// re-init when scrollNode changes; track only scrollNode
		teardown();
		setup();
	});
</script>

{#if assistantEls.length > 2}
	<div
		role="listbox"
		aria-label="User message navigator"
		class="fixed z-20 flex select-none flex-col items-center justify-center rounded-full border border-black/5 bg-white/10 shadow-sm backdrop-blur-sm dark:border-white/5 dark:bg-white/5 {className}"
	>
		<!-- fixed height rail with evenly spaced dots -->
		<div class="flex w-6 flex-col items-center justify-between gap-4 rounded-full py-2">
			{#each assistantEls as _el, i}
				<button
					type="button"
					role="option"
					aria-selected={i === activeIndex}
					aria-label={`Jump to user message ${i + 1} of ${assistantEls.length}`}
					class={{
						"relative box-content size-2 rounded-full border border-gray-500/50 transition-[transform,opacity,background-color] hover:scale-[1.08] focus:outline-none focus:ring-2 focus:ring-white/40 dark:border-white/30": true,
						"opacity-40": i !== activeIndex,
						"bg-gray-400 dark:bg-white": i === activeIndex,
						"bg-gray-300 dark:bg-white/50": i !== activeIndex,
					}}
					onclick={() => scrollToIndex(i)}
				></button>
			{/each}
		</div>
	</div>
{/if}

<style>
</style>
