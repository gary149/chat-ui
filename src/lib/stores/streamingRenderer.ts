import { derived, writable } from "svelte/store";

const TICK_MS = 80;
const BASE_CPS = 120;
const MAX_CPS = 260;
const CLEANUP_DELAY_MS = 400;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

type StreamEntry = {
	visible: string;
	incoming: string;
	done: boolean;
	lastActive: number;
};

const entries = writable(new Map<string, StreamEntry>());

let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
	if (typeof window === "undefined") return;
	if (!timer) {
		timer = setInterval(tick, TICK_MS);
	}
}

function stopTimer() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

function tick() {
	entries.update((current) => {
		if (current.size === 0) {
			stopTimer();
			return current;
		}

		const next = new Map(current);
		let changed = false;
		const currentTime = now();

		for (const [id, entry] of current.entries()) {
			const backlog = entry.incoming.length;

			if (backlog > 0) {
				const backlogBoost = Math.max(0, backlog - 200);
				const cps = Math.min(MAX_CPS, BASE_CPS + backlogBoost * 0.5);
				const quota = Math.max(1, Math.floor((cps * TICK_MS) / 1000));
				const sliceLength = Math.min(quota, backlog);

				if (sliceLength > 0) {
					const slice = entry.incoming.slice(0, sliceLength);
					next.set(id, {
						visible: entry.visible + slice,
						incoming: entry.incoming.slice(sliceLength),
						done: entry.done,
						lastActive: currentTime,
					});
					changed = true;
				}
			} else if (entry.done && currentTime - entry.lastActive > CLEANUP_DELAY_MS) {
				next.delete(id);
				changed = true;
			}
		}

		if (!changed) {
			return current;
		}

		if (next.size === 0) {
			stopTimer();
		}

		return next;
	});
}

export function primeStreamView(id: string, initialVisible = "") {
	if (!id) return;
	const time = now();

	entries.update((current) => {
		const next = new Map(current);
		next.set(id, {
			visible: initialVisible,
			incoming: "",
			done: false,
			lastActive: time,
		});
		return next;
	});

	ensureTimer();
}

export function queueStreamView(id: string, delta: string) {
	if (!id || !delta) return;

	entries.update((current) => {
		const next = new Map(current);
		const existing = next.get(id);
		if (existing) {
			next.set(id, {
				...existing,
				incoming: existing.incoming + delta,
			});
		} else {
			next.set(id, {
				visible: "",
				incoming: delta,
				done: false,
				lastActive: now(),
			});
		}
		return next;
	});

	ensureTimer();
}

export function completeStreamView(id: string, finalVisible?: string) {
	if (!id) return;
	const time = now();

	entries.update((current) => {
		if (!current.has(id)) {
			return current;
		}

		const next = new Map(current);
		const existing = next.get(id)!;
		next.set(id, {
			visible: finalVisible ?? existing.visible,
			incoming: "",
			done: true,
			lastActive: time,
		});
		return next;
	});

	ensureTimer();
}

export function clearStreamView(id: string) {
	if (!id) return;

	entries.update((current) => {
		if (!current.has(id)) {
			return current;
		}

		const next = new Map(current);
		next.delete(id);
		return next;
	});
}

export const visibleStreamContent = derived(entries, ($entries) => {
	const result: Record<string, string> = {};
	$entries.forEach((entry, id) => {
		result[id] = entry.visible;
	});
	return result;
});
