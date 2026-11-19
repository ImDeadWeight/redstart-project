<script lang="ts">
	/**
	 * Under the composer: which project this chat is in (projects-plan Phase 2),
	 * as a link to the project page, with a button to take a not-yet-started
	 * chat out of it. Renders nothing outside a project.
	 *
	 * Moving an existing chat is the sidebar menu's job (or `/project`); here
	 * only the pending choice is undoable, because that is the one a user makes
	 * by arriving from a project page and may not have meant.
	 */
	import { FolderKanban, X } from '@lucide/svelte';
	import { RouterService } from '$lib/services/router.service';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { projectsStore } from '$lib/stores/projects.svelte';

	let projectId = $derived(conversationsStore.getProjectId());
	let project = $derived(projectsStore.byId(projectId));
	let pending = $derived(!conversationsStore.activeConversation && !!projectId);

	$effect(() => {
		if (projectId) void projectsStore.ensureLoaded();
	});
</script>

{#if project}
	<div class="mt-1.5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
		<FolderKanban class="h-3 w-3" />
		<span>In project</span>
		<a class="font-medium hover:underline" href={RouterService.project(project.id)}
			>{project.name}</a
		>
		{#if pending}
			<button
				class="rounded p-0.5 hover:text-foreground"
				onclick={() => conversationsStore.setPendingProject(null)}
				aria-label="Start this chat outside the project"
				title="Start this chat outside the project"
			>
				<X class="h-3 w-3" />
			</button>
		{/if}
	</div>
{/if}
