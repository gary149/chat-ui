<script lang="ts">
	import Modal from "../Modal.svelte";
	import SkillCard from "./SkillCard.svelte";
	import type { Skill } from "$lib/types/Skill";
	import CarbonWatsonHealthAiStatus from "~icons/carbon/watson-health-ai-status";

	interface Props {
		skills: Array<Skill & { isEnabled: boolean }>;
		onClose: () => void;
		onToggleSkill: (skillId: string, enabled: boolean) => void;
	}

	let { skills, onClose, onToggleSkill }: Props = $props();

	let searchQuery = $state("");

	const filteredSkills = $derived(
		searchQuery
			? skills.filter(
					(skill) =>
						skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
						skill.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
						skill.tags?.some((tag) => tag.toLowerCase().includes(searchQuery.toLowerCase()))
				)
			: skills
	);

	const enabledCount = $derived(skills.filter((s) => s.isEnabled).length);
</script>

<Modal width="max-w-2xl" onclose={onClose} closeButton>
	<div class="p-6">
		<div class="mb-6 flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900"
			>
				<CarbonWatsonHealthAiStatus class="h-6 w-6 text-blue-600 dark:text-blue-400" />
			</div>
			<div>
				<h2 class="text-xl font-semibold text-gray-900 dark:text-gray-100">Skills</h2>
				<p class="text-sm text-gray-500 dark:text-gray-400">
					Enable skills to enhance Claude's capabilities
				</p>
			</div>
		</div>

		<!-- Search -->
		<div class="mb-4">
			<input
				type="text"
				placeholder="Search skills..."
				bind:value={searchQuery}
				class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-900 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder-gray-400"
			/>
		</div>

		<!-- Stats -->
		<div class="mb-4 text-sm text-gray-500 dark:text-gray-400">
			{enabledCount} of {skills.length} skills enabled
		</div>

		<!-- Skills list -->
		<div class="max-h-[400px] space-y-3 overflow-y-auto">
			{#if filteredSkills.length === 0}
				<div class="py-8 text-center text-gray-500 dark:text-gray-400">
					{#if searchQuery}
						No skills match your search
					{:else}
						No skills available
					{/if}
				</div>
			{:else}
				{#each filteredSkills as skill (skill.id)}
					<SkillCard {skill} onToggle={onToggleSkill} />
				{/each}
			{/if}
		</div>

		<!-- Info section -->
		<div class="mt-6 rounded-lg bg-gray-50 p-4 dark:bg-gray-900">
			<h3 class="mb-2 font-medium text-gray-900 dark:text-gray-100">About Skills</h3>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				Skills are specialized instruction sets that enhance Claude's capabilities for specific
				tasks. When enabled, Claude will automatically load relevant skills based on your
				conversation context.
			</p>
		</div>
	</div>
</Modal>
