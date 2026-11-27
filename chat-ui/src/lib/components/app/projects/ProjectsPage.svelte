<script lang="ts">
	/**
	 * The Projects list (projects-plan Phase 2): the signed-in account's
	 * projects and those shared with it (marked "shared by"), how many of its
	 * own chats each holds, and a form to start one. One project
	 * opens on its own page (ProjectPage).
	 */
	import { goto } from '$app/navigation';
	import { FolderKanban, Plus, Loader, MessageSquare, Layers } from '@lucide/svelte';
	import { ProgramService, type Program } from '$lib/services/program.service';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { RouterService } from '$lib/services/router.service';
	import { projectsStore } from '$lib/stores/projects.svelte';
	import { conversations } from '$lib/stores/conversations.svelte';

	let creating = $state(false);
	let saving = $state(false);
	let name = $state('');
	let instructions = $state('');

	$effect(() => {
		void projectsStore.ensureLoaded();
	});

	// Programs (tasks plan Phase 4): groups of projects. Quietly absent when
	// Nest has none to give (an older server).
	let programs = $state<Program[]>([]);
	let programsReady = $state(false);
	let newProgram = $state('');
	let creatingProgram = $state(false);

	$effect(() => {
		ProgramService.list()
			.then((list) => (programs = list))
			.catch(() => (programs = []))
			.finally(() => (programsReady = true));
	});

	async function createProgram() {
		const n = newProgram.trim();
		if (!n) return;
		creatingProgram = true;
		try {
			const p = await ProgramService.create(n);
			newProgram = '';
			await goto(RouterService.program(p.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not create the program');
		} finally {
			creatingProgram = false;
		}
	}

	let chatCounts = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const c of conversations()) {
			if (c.projectId) counts[c.projectId] = (counts[c.projectId] ?? 0) + 1;
		}
		return counts;
	});

	async function create() {
		if (!name.trim()) return;
		saving = true;
		try {
			const project = await projectsStore.create(name.trim(), instructions);
			name = '';
			instructions = '';
			creating = false;
			await goto(RouterService.project(project.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not create the project');
		} finally {
			saving = false;
		}
	}
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6 md:pt-28">
	<div class="flex items-center gap-3">
		<FolderKanban class="h-6 w-6 shrink-0" />

		<div class="min-w-0 flex-1">
			<h1 class="truncate text-lg font-semibold">Projects</h1>
			<p class="text-sm text-muted-foreground">
				Chats, instructions, memory and files for one piece of work
			</p>
		</div>

		{#if !creating}
			<Button size="sm" variant="outline" onclick={() => (creating = true)}>
				<Plus class="h-3 w-3" /> New project
			</Button>
		{/if}
	</div>

	{#if creating}
		<div class="space-y-3 rounded-lg border p-4">
			<label class="block space-y-1 text-sm">
				<span>Name</span>
				<Input
					bind:value={name}
					placeholder="Billing service"
					maxlength={projectsStore.limits?.maxNameChars}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && create()}
				/>
			</label>
			<label class="block space-y-1 text-sm">
				<span>Instructions <span class="text-muted-foreground">(optional)</span></span>
				<Textarea
					bind:value={instructions}
					rows={5}
					maxlength={projectsStore.limits?.maxInstructionsChars}
					placeholder="What every chat in this project should know or do. For example: we use TypeScript and Postgres 16; keep answers short."
				/>
			</label>
			<div class="flex justify-end gap-2">
				<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				<Button onclick={create} disabled={saving || !name.trim()}>
					{#if saving}<Loader class="h-4 w-4 animate-spin" />{/if} Create
				</Button>
			</div>
		</div>
	{/if}

	{#if !projectsStore.loaded}
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader class="h-4 w-4 animate-spin" /> Loading projects…
		</div>
	{:else if projectsStore.error}
		<div class="text-sm text-destructive">{projectsStore.error}</div>
	{:else if projectsStore.projects.length === 0 && !creating}
		<div class="text-sm text-muted-foreground italic">
			No projects yet. A project keeps related chats together, with instructions and memory they all
			share.
		</div>
	{:else}
		<ul class="space-y-2">
			{#each projectsStore.projects as project (project.id)}
				<li>
					<a
						href={RouterService.project(project.id)}
						class="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50"
					>
						<FolderKanban class="h-4 w-4 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2">
								<span class="truncate font-medium">{project.name}</span>
								{#if project.access !== 'owner' && project.ownerName}
									<span class="shrink-0 text-xs text-muted-foreground">
										shared by {project.ownerName}{project.access === 'viewer' ? ' · view only' : ''}
									</span>
								{:else if project.members?.length}
									<span class="shrink-0 text-xs text-muted-foreground">shared</span>
								{/if}
							</div>
							{#if project.instructions}
								<div class="truncate text-sm text-muted-foreground">{project.instructions}</div>
							{/if}
						</div>
						<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
							<MessageSquare class="h-3 w-3" />
							{chatCounts[project.id] ?? 0}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<section class="space-y-2 border-t pt-6">
		<h2 class="flex items-center gap-1.5 text-sm font-medium">
			<Layers class="h-4 w-4" /> Programs
		</h2>
		<p class="text-xs text-muted-foreground">
			A program groups projects on one page, with their tasks together. It shares no projects: each
			person sees the ones in it they can already open.
		</p>
		{#if programsReady && programs.length}
			<ul class="space-y-2">
				{#each programs as program (program.id)}
					<li>
						<a
							href={RouterService.program(program.id)}
							class="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50"
						>
							<Layers class="h-4 w-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<span class="truncate font-medium">{program.name}</span>
								{#if program.description}
									<div class="truncate text-sm text-muted-foreground">{program.description}</div>
								{/if}
							</div>
							<span class="shrink-0 text-xs text-muted-foreground"
								>{program.projects.length} project{program.projects.length === 1 ? '' : 's'}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="flex gap-2">
			<Input
				bind:value={newProgram}
				placeholder="New program name"
				aria-label="New program name"
				maxlength={80}
				onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && createProgram()}
			/>
			<Button
				size="sm"
				variant="outline"
				onclick={createProgram}
				disabled={creatingProgram || !newProgram.trim()}
			>
				<Plus class="h-3 w-3" /> New program
			</Button>
		</div>
	</section>
</div>
