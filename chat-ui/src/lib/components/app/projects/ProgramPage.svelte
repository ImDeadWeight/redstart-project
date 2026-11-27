<script lang="ts">
	/**
	 * One program (tasks plan Phase 4): a group of projects and their tasks
	 * together. A program gives no access: it lists only the projects in it
	 * this person can already open, and their tasks. Editors rename it and add
	 * or take out projects (adding one also needs managing that project);
	 * the owner or an admin shares and deletes it.
	 */
	import { goto } from '$app/navigation';
	import { Layers, FolderKanban, Plus, Trash2, Share2, X, Loader, ListTodo } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { DialogConfirmation } from '$lib/components/app';
	import { ROUTES } from '$lib/constants/routes';
	import { RouterService } from '$lib/services/router.service';
	import {
		ProgramService,
		canEditProgram,
		canManageProgram,
		type Program
	} from '$lib/services/program.service';
	import { canManageProject } from '$lib/services/project.service';
	import {
		AssignmentService,
		ASSIGNMENT_STATUSES,
		type Assignment
	} from '$lib/services/assignment.service';
	import { projectsStore } from '$lib/stores/projects.svelte';
	import { assignmentsStore } from '$lib/stores/assignments.svelte';
	import AssignmentRow from '../assignments/AssignmentRow.svelte';
	import AssignmentEditor from '../assignments/AssignmentEditor.svelte';
	import ProjectShareDialog from './ProjectShareDialog.svelte';

	interface Props {
		id: string;
	}

	let { id }: Props = $props();

	let program = $state<Program | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let items = $state<Assignment[]>([]);
	let nameDraft = $state('');
	let descriptionDraft = $state('');
	let saving = $state(false);
	let addId = $state('');
	let showShare = $state(false);
	let showDelete = $state(false);
	let showDone = $state(false);
	let editorOpen = $state(false);
	let editingId = $state<string | null>(null);

	const canEdit = $derived(canEditProgram(program));
	const canManage = $derived(canManageProgram(program));
	const changed = $derived(
		!!program && (nameDraft.trim() !== program.name || descriptionDraft !== program.description)
	);
	// Projects this person could add: ones they manage that are not in it yet.
	const addable = $derived(
		projectsStore.projects.filter(
			(p) => canManageProject(p) && !program?.projects.some((x) => x.id === p.id)
		)
	);
	const groups = $derived(
		ASSIGNMENT_STATUSES.map((s) => ({ ...s, items: items.filter((t) => t.status === s.value) }))
	);

	$effect(() => {
		void load(id);
	});
	$effect(() => {
		void assignmentsStore.version;
		if (program) void loadTasks(program.id);
	});

	async function load(programId: string) {
		loading = true;
		notFound = false;
		try {
			fill(await ProgramService.get(programId));
			// Fresh, not cached: the list of projects that can be added must match now.
			void projectsStore.refresh();
		} catch {
			program = null;
			notFound = true;
		} finally {
			loading = false;
		}
	}

	function fill(p: Program) {
		program = p;
		nameDraft = p.name;
		descriptionDraft = p.description;
	}

	async function loadTasks(programId: string) {
		try {
			items = (await AssignmentService.forProgram(programId)).items;
		} catch {
			items = [];
		}
	}

	async function save() {
		if (!program || !nameDraft.trim()) return;
		saving = true;
		try {
			fill(
				await ProgramService.update(program.id, {
					name: nameDraft.trim(),
					description: descriptionDraft
				})
			);
			toast.success('Saved');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			saving = false;
		}
	}

	async function setProjects(ids: string[]) {
		if (!program) return;
		try {
			fill(await ProgramService.setProjects(program.id, ids));
			void loadTasks(program.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the projects');
		}
	}

	function addProject() {
		if (!program || !addId) return;
		void setProjects([...program.projects.map((p) => p.id), addId]);
		addId = '';
	}

	async function confirmDelete() {
		if (!program) return;
		try {
			await ProgramService.remove(program.id);
			toast.success('Program deleted. Its projects are unchanged.');
			await goto(ROUTES.PROJECTS);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the program');
		}
	}

	async function toggleDone(task: Assignment, done: boolean) {
		try {
			await AssignmentService.update(task.id, { status: done ? 'done' : 'open' });
			assignmentsStore.changed();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change the task');
		}
	}
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 pt-16 md:p-6 md:pt-28">
	{#if loading}
		<div class="flex justify-center"><Loader class="h-5 w-5 animate-spin" /></div>
	{:else if notFound || !program}
		<div class="text-sm text-muted-foreground">
			This program does not exist, or it is not shared with you.
			<a class="underline" href={ROUTES.PROJECTS}>All projects</a>
		</div>
	{:else}
		<div class="flex items-center gap-3">
			<Layers class="h-6 w-6 shrink-0" />
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-lg font-semibold">{program.name}</h1>
				<div class="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
					<a class="hover:underline" href={ROUTES.PROJECTS}>Projects and programs</a>
					{#if program.access !== 'owner' && program.ownerName}
						<span>· run by {program.ownerName}</span>
					{/if}
				</div>
			</div>
			{#if canManage}
				<Button size="sm" variant="outline" onclick={() => (showShare = true)}>
					<Share2 class="h-3 w-3" /> Share
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Delete program"
					onclick={() => (showDelete = true)}
				>
					<Trash2 class="h-4 w-4" />
				</Button>
			{/if}
		</div>

		{#if canEdit}
			<section class="space-y-2">
				<Input bind:value={nameDraft} maxlength={80} aria-label="Program name" />
				<Textarea
					bind:value={descriptionDraft}
					rows={3}
					maxlength={2000}
					placeholder="What this program is for"
					aria-label="Program description"
				/>
				<Button size="sm" onclick={save} disabled={!changed || saving || !nameDraft.trim()}>
					{#if saving}<Loader class="h-3 w-3 animate-spin" />{/if} Save
				</Button>
			</section>
		{:else if program.description}
			<p class="text-sm whitespace-pre-wrap text-muted-foreground">{program.description}</p>
		{/if}

		<section class="space-y-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium">
				<FolderKanban class="h-4 w-4" /> Projects
			</h2>
			<p class="text-xs text-muted-foreground">
				A program shares no projects: you see the ones in it you can already open.
			</p>
			{#if program.projects.length === 0}
				<div class="text-sm text-muted-foreground italic">
					No projects you can open are in it yet.
				</div>
			{:else}
				<ul class="divide-y rounded-lg border">
					{#each program.projects as p (p.id)}
						<li class="flex items-center gap-2 px-3 py-2 text-sm">
							<a class="min-w-0 flex-1 truncate hover:underline" href={RouterService.project(p.id)}
								>{p.name}</a
							>
							{#if p.canRemove}
								<button
									class="text-muted-foreground hover:text-foreground"
									aria-label="Take {p.name} out of the program"
									onclick={() =>
										setProjects(program!.projects.filter((x) => x.id !== p.id).map((x) => x.id))}
								>
									<X class="h-3.5 w-3.5" />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if canEdit && addable.length}
				<div class="flex gap-2">
					<select
						bind:value={addId}
						aria-label="Project to add"
						class="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
					>
						<option value="">Add a project you manage…</option>
						{#each addable as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
					<Button size="sm" variant="outline" onclick={addProject} disabled={!addId}>
						<Plus class="h-3 w-3" /> Add
					</Button>
				</div>
			{/if}
		</section>

		<section class="space-y-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium">
				<ListTodo class="h-4 w-4" /> Tasks
				<span class="text-xs font-normal text-muted-foreground"
					>{items.filter((t) => t.status !== 'done').length} open</span
				>
			</h2>
			{#if items.length === 0}
				<div class="text-sm text-muted-foreground italic">No tasks in its projects yet.</div>
			{/if}
			{#each groups as g (g.value)}
				{#if g.items.length > 0 && (g.value !== 'done' || showDone)}
					<div class="space-y-1">
						<h3 class="text-xs font-medium text-muted-foreground">{g.label} · {g.items.length}</h3>
						<ul class="divide-y rounded-lg border">
							{#each g.items as task (task.id)}
								<AssignmentRow
									{task}
									hideStatus
									onOpen={(t) => {
										editingId = t.id;
										editorOpen = true;
									}}
									onToggleDone={toggleDone}
								/>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
			{#if items.some((t) => t.status === 'done')}
				<button
					class="text-xs text-muted-foreground hover:underline"
					onclick={() => (showDone = !showDone)}
				>
					{showDone ? 'Hide done' : 'Show done'}
				</button>
			{/if}
		</section>
	{/if}
</div>

{#if program && canManage}
	<ProjectShareDialog
		bind:open={showShare}
		project={program}
		saveMembers={(pid, members) => ProgramService.setMembers(pid, members)}
		description="Everyone here can open this program's page. It shares no projects: each person sees the projects in it they can already open."
		rolesNote="Viewers open the page. Editors can also rename it and add or take out projects (adding one also needs managing that project)."
		allowHandOver={false}
		onChanged={(p) => fill(p)}
	/>
{/if}

<DialogConfirmation
	bind:open={showDelete}
	title="Delete program"
	description={program
		? `Delete "${program.name}"? Its projects and their tasks are not changed; only the program goes.`
		: ''}
	confirmText="Delete program"
	cancelText="Cancel"
	variant="destructive"
	icon={Trash2}
	onConfirm={confirmDelete}
	onCancel={() => (showDelete = false)}
/>

<AssignmentEditor bind:open={editorOpen} taskId={editingId} />
