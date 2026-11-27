<script lang="ts">
	/**
	 * A project's tasks, on the project page (tasks plan Phase 1): grouped by
	 * status, with an "Add a task" line for whoever may add them. Everyone who
	 * can open the project sees the list; a viewer can finish the tasks given
	 * to them.
	 */
	import { ListTodo, Plus, Loader } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		AssignmentService,
		ASSIGNMENT_STATUSES,
		type Assignment
	} from '$lib/services/assignment.service';
	import { assignmentsStore } from '$lib/stores/assignments.svelte';
	import AssignmentRow from './AssignmentRow.svelte';
	import AssignmentEditor from './AssignmentEditor.svelte';

	interface Props {
		projectId: string;
		canAdd: boolean;
	}

	let { projectId, canAdd }: Props = $props();

	let items = $state<Assignment[]>([]);
	let loading = $state(true);
	let error = $state('');
	let draft = $state('');
	let adding = $state(false);
	let showDone = $state(false);
	let showDeleted = $state(false);
	let deletedItems = $state<Assignment[]>([]);

	let editorOpen = $state(false);
	let editingId = $state<string | null>(null);

	const groups = $derived(
		ASSIGNMENT_STATUSES.map((s) => ({ ...s, items: items.filter((t) => t.status === s.value) }))
	);
	const openCount = $derived(items.filter((t) => t.status !== 'done').length);

	$effect(() => {
		void assignmentsStore.version;
		void load(projectId);
	});

	async function load(pid: string) {
		try {
			const r = await AssignmentService.forProject(pid, showDeleted);
			items = r.items.filter((t) => !t.deletedAt);
			deletedItems = r.items.filter((t) => !!t.deletedAt);
			error = '';
		} catch (e) {
			// An older Nest has no /assignments: say so quietly.
			error = e instanceof Error ? e.message : 'Could not load tasks';
		} finally {
			loading = false;
		}
	}

	async function quickAdd() {
		const title = draft.trim();
		if (!title) return;
		adding = true;
		try {
			await AssignmentService.create({ title, projectId });
			draft = '';
			assignmentsStore.changed();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not add the task');
		} finally {
			adding = false;
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

	function openTask(t: Assignment) {
		editingId = t.id;
		editorOpen = true;
	}

	function openNew() {
		editingId = null;
		editorOpen = true;
	}
</script>

<section class="space-y-2">
	<div class="flex items-center justify-between gap-2">
		<h2 class="flex items-center gap-1.5 text-sm font-medium">
			<ListTodo class="h-4 w-4" /> Tasks
			{#if openCount > 0}<span class="text-xs font-normal text-muted-foreground"
					>{openCount} open</span
				>{/if}
		</h2>
		{#if canAdd && !error}
			<Button size="sm" variant="outline" onclick={openNew}>
				<Plus class="h-3 w-3" /> New task
			</Button>
		{/if}
	</div>

	{#if loading}
		<Loader class="h-4 w-4 animate-spin text-muted-foreground" />
	{:else if error}
		<div class="text-sm text-muted-foreground">{error}</div>
	{:else}
		{#if canAdd}
			<div class="flex gap-2">
				<Input
					bind:value={draft}
					placeholder="Add a task and press Enter"
					maxlength={200}
					disabled={adding}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && quickAdd()}
				/>
			</div>
		{/if}

		{#if items.length === 0}
			<div class="text-sm text-muted-foreground italic">
				No tasks yet.{canAdd ? ' Give someone in the project something to do.' : ''}
			</div>
		{:else}
			{#each groups as g (g.value)}
				{#if g.items.length > 0 && (g.value !== 'done' || showDone)}
					<div class="space-y-1">
						<h3 class="text-xs font-medium text-muted-foreground">
							{g.label} · {g.items.length}
						</h3>
						<ul class="divide-y rounded-lg border">
							{#each g.items as task (task.id)}
								<AssignmentRow
									{task}
									hideProject
									hideStatus
									onOpen={openTask}
									onToggleDone={toggleDone}
								/>
							{/each}
						</ul>
					</div>
				{/if}
			{/each}
			{@const doneCount = groups.find((g) => g.value === 'done')?.items.length ?? 0}
			{#if doneCount > 0}
				<button
					class="text-xs text-muted-foreground hover:underline"
					onclick={() => (showDone = !showDone)}
				>
					{showDone ? 'Hide' : 'Show'}
					{doneCount} done
				</button>
			{/if}
		{/if}

		{#if canAdd}
			<button
				class="block text-xs text-muted-foreground hover:underline"
				onclick={() => {
					showDeleted = !showDeleted;
					void load(projectId);
				}}
			>
				{showDeleted ? 'Hide recently deleted' : 'Recently deleted'}
			</button>
			{#if showDeleted}
				{#if deletedItems.length === 0}
					<div class="text-xs text-muted-foreground italic">
						Nothing deleted in the last 30 days.
					</div>
				{:else}
					<ul class="divide-y rounded-lg border opacity-75">
						{#each deletedItems as task (task.id)}
							<AssignmentRow
								task={{ ...task, can: { ...task.can, status: false } }}
								hideProject
								onOpen={openTask}
								onToggleDone={() => {}}
							/>
						{/each}
					</ul>
				{/if}
			{/if}
		{/if}
	{/if}
</section>

<AssignmentEditor bind:open={editorOpen} taskId={editingId} defaultProjectId={projectId} />
