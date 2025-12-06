import { writable } from "svelte/store";
import type { Skill } from "$lib/types/Skill";

interface SkillsState {
	skills: Array<Skill & { isEnabled: boolean }>;
	isLoading: boolean;
	error: string | null;
	isModalOpen: boolean;
}

const initialState: SkillsState = {
	skills: [],
	isLoading: false,
	error: null,
	isModalOpen: false,
};

function createSkillsStore() {
	const { subscribe, set, update } = writable<SkillsState>(initialState);

	return {
		subscribe,

		/**
		 * Load skills from the API
		 */
		async loadSkills() {
			update((state) => ({ ...state, isLoading: true, error: null }));

			try {
				const response = await fetch("/api/v2/skills");
				if (!response.ok) {
					throw new Error("Failed to load skills");
				}
				const skills = await response.json();
				update((state) => ({ ...state, skills, isLoading: false }));
			} catch (error) {
				update((state) => ({
					...state,
					isLoading: false,
					error: error instanceof Error ? error.message : "Unknown error",
				}));
			}
		},

		/**
		 * Toggle a skill's enabled status
		 */
		async toggleSkill(skillId: string, enabled: boolean) {
			// Optimistic update
			update((state) => ({
				...state,
				skills: state.skills.map((s) => (s.id === skillId ? { ...s, isEnabled: enabled } : s)),
			}));

			try {
				const response = await fetch(`/api/v2/skills/${skillId}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled }),
				});

				if (!response.ok) {
					throw new Error("Failed to update skill");
				}
			} catch (error) {
				// Revert on error
				update((state) => ({
					...state,
					skills: state.skills.map((s) => (s.id === skillId ? { ...s, isEnabled: !enabled } : s)),
					error: error instanceof Error ? error.message : "Unknown error",
				}));
			}
		},

		/**
		 * Open the skills modal
		 */
		openModal() {
			update((state) => ({ ...state, isModalOpen: true }));
		},

		/**
		 * Close the skills modal
		 */
		closeModal() {
			update((state) => ({ ...state, isModalOpen: false }));
		},

		/**
		 * Get count of enabled skills
		 */
		getEnabledCount(state: SkillsState): number {
			return state.skills.filter((s) => s.isEnabled).length;
		},

		/**
		 * Reset the store
		 */
		reset() {
			set(initialState);
		},
	};
}

export const skillsStore = createSkillsStore();
