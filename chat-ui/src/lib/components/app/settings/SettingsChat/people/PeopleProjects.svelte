<script lang="ts">
	// Every project on the server, for an admin whose roles grant
	// manageProjects (2026-11-24): who owns it, who it is shared with, and the
	// owner's controls — share, hand over, delete — for any of them.
	import { toast } from 'svelte-sonner';
	import { FolderKanban, Search, Share2, Trash2, ExternalLink } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { RouterService } from '$lib/services/router.service';
	import { ProjectService, type Project } from '$lib/services/project.service';
	import ProjectShareDialog from '$lib/components/app/projects/ProjectShareDialog.svelte';

	let { projects = $bindable() }: { projects: Project[] } = $props();

	let query = $state('');
	let sharing = $state<Project | null>(null);
	let shareOpen = $state(false);
	let confirmDeleteId = $state<string | null>(null);

	const filtered = $derived(
		projects.filter((p) =>
			`${p.name} ${p.ownerName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
		)
	);

	function openShare(p: Project) {
		sharing = p;
		shareOpen = true;
	}

	async function remove(p: Project) {
		try {
			await ProjectService.remove(p.id);
			projects = projects.filter((x) => x.id !== p.id);
			confirmDeleteId = null;
			toast.success(`Deleted "${p.name}". Everyone's chats in it moved back to their own lists.`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete it');
		}
	}
</script>

<div class="mt-4 space-y-3">
	<p class="text-sm text-muted-foreground">
		Every project on this server. Your roles let you manage them all: share, hand over or delete any
		of them. People's chats in a project stay theirs; you see the project, not their chats.
	</p>
	<label class="relative block max-w-72">
		<Search
			class="pointer-events-none absolute top-1/2 left-2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
		/>
		<Input
			bind:value={query}
			placeholder="Find a project or owner"
			class="h-8 pl-7 text-sm"
			aria-label="Find a project or owner"
		/>
	</label>

	<ul class="divide-y rounded-md border border-border/50">
		{#each filtered as p (p.id)}
			<li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
				<FolderKanban class="h-4 w-4 shrink-0 text-muted-foreground" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{p.name}</p>
					<p class="text-xs text-muted-foreground">
						Owner {p.ownerName ?? '—'} ·
						{p.members.length ? `shared with ${p.members.length}` : 'not shared'} · updated {new Date(
							p.updatedAt
						).toLocaleDateString()}
					</p>
				</div>
				<div class="flex gap-1">
					<Button size="sm" variant="ghost" href={RouterService.project(p.id)} title="Open">
						<ExternalLink class="h-3.5 w-3.5" />
					</Button>
					<Button size="sm" variant="outline" onclick={() => openShare(p)}>
						<Share2 class="h-3.5 w-3.5" /> Share
					</Button>
					{#if confirmDeleteId === p.id}
						<Button size="sm" variant="destructive" onclick={() => remove(p)}>Delete</Button>
						<Button size="sm" variant="ghost" onclick={() => (confirmDeleteId = null)}
							>Cancel</Button
						>
					{:else}
						<Button
							size="sm"
							variant="ghost"
							onclick={() => (confirmDeleteId = p.id)}
							aria-label="Delete {p.name}"
						>
							<Trash2 class="h-3.5 w-3.5" />
						</Button>
					{/if}
				</div>
			</li>
		{:else}
			<li class="px-3 py-4 text-sm text-muted-foreground">No projects.</li>
		{/each}
	</ul>
</div>

{#if sharing}
	<ProjectShareDialog
		bind:open={shareOpen}
		project={sharing}
		onChanged={(updated) => {
			projects = projects.map((x) => (x.id === updated.id ? updated : x));
		}}
	/>
{/if}
