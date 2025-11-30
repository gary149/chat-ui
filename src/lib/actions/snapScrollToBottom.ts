import { navigating } from "$app/state";
import { tick } from "svelte";

// Threshold for considering user "at bottom" - generous to handle small layout shifts
const BOTTOM_THRESHOLD = 50;
// Minimum scroll distance to consider intentional user scrolling up
const SCROLL_UP_THRESHOLD = 30;

/**
 * Checks if the scroll container is at or near the bottom
 */
function isAtBottom(node: HTMLElement): boolean {
	const { scrollTop, scrollHeight, clientHeight } = node;
	return scrollHeight - scrollTop - clientHeight <= BOTTOM_THRESHOLD;
}

/**
 * @param node element to snap scroll to bottom
 * @param dependency pass in a dependency to update scroll on changes.
 */
export const snapScrollToBottom = (node: HTMLElement, dependency: unknown) => {
	// Track whether user has intentionally scrolled away from bottom
	let isUserDetached = false;
	// Track previous scroll position to detect user scroll direction
	let prevScrollTop = node.scrollTop;
	// Track previous content height to detect content growth vs user scroll
	let prevScrollHeight = node.scrollHeight;
	// Track if we're programmatically scrolling to avoid false detach
	let isProgrammaticScroll = false;
	// ResizeObserver to watch for content height changes
	let resizeObserver: ResizeObserver | null = null;

	const scrollToBottom = () => {
		isProgrammaticScroll = true;
		node.scrollTo({ top: node.scrollHeight });
		// Reset flag after scroll completes
		requestAnimationFrame(() => {
			isProgrammaticScroll = false;
			prevScrollTop = node.scrollTop;
			prevScrollHeight = node.scrollHeight;
		});
	};

	const handleScroll = () => {
		// Ignore programmatic scrolls
		if (isProgrammaticScroll) {
			return;
		}

		const currentScrollTop = node.scrollTop;
		const scrollDelta = currentScrollTop - prevScrollTop;
		const contentGrew = node.scrollHeight > prevScrollHeight;

		// If content grew while we were at the bottom, stay attached
		if (contentGrew && !isUserDetached) {
			prevScrollTop = currentScrollTop;
			prevScrollHeight = node.scrollHeight;
			return;
		}

		// User scrolled up significantly - detach
		if (scrollDelta < -SCROLL_UP_THRESHOLD) {
			isUserDetached = true;
		}

		// User scrolled back to bottom - reattach
		if (isAtBottom(node)) {
			isUserDetached = false;
		}

		prevScrollTop = currentScrollTop;
		prevScrollHeight = node.scrollHeight;
	};

	const handleContentResize = () => {
		// If user is not detached and we're at/near bottom, scroll to stay at bottom
		if (!isUserDetached) {
			// Use requestAnimationFrame to batch with browser's layout
			requestAnimationFrame(() => {
				if (!isUserDetached && !isAtBottom(node)) {
					scrollToBottom();
				}
				prevScrollHeight = node.scrollHeight;
			});
		}
	};

	const updateScroll = async (_options: { force?: boolean } = {}) => {
		const defaultOptions = { force: false };
		const options = { ...defaultOptions, ..._options };
		const { force } = options;

		// Don't scroll if user has detached (unless forcing or navigating)
		if (!force && isUserDetached && !navigating.to) return;

		// Wait for DOM to update
		await tick();
		// Additional frame to ensure layout is complete
		await new Promise((resolve) => requestAnimationFrame(resolve));

		scrollToBottom();
	};

	// Set up scroll listener
	node.addEventListener("scroll", handleScroll, { passive: true });

	// Set up ResizeObserver to watch for content changes
	// This catches expanding thinking blocks, streaming content, etc.
	if (typeof ResizeObserver !== "undefined") {
		resizeObserver = new ResizeObserver(() => {
			handleContentResize();
		});

		// Observe the scroll container's first child (the content wrapper)
		// to detect when content inside changes size
		const contentWrapper = node.firstElementChild;
		if (contentWrapper) {
			resizeObserver.observe(contentWrapper);
		}
		// Also observe the container itself
		resizeObserver.observe(node);
	}

	// Initial scroll if there's a dependency
	if (dependency) {
		updateScroll({ force: true });
	}

	return {
		update: updateScroll,
		destroy: () => {
			node.removeEventListener("scroll", handleScroll);
			resizeObserver?.disconnect();
		},
	};
};
