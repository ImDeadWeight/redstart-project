<script lang="ts">
	/**
	 * My tasks (tasks plan Phase 1): everything given to me, or to a group I
	 * am in and not yet taken, across every project and outside them; and the
	 * tasks I gave out that are in no project. Sorted into when they are due,
	 * in the viewer's own calendar.
	 */
	import { ListTodo, Plus, Loader } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { AssignmentService, localToday, type Assignment } from '$lib/services/assignment.service';
	import { assignmentsStore } from '$lib/stores/assignments.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import AssignmentRow from './AssignmentRow.svelte';
	import AssignmentEditor from './AssignmentEditor.svelte';

	type Filter = 'mine' | 'groups' | 'created';

	let filter = $state<Filter>('mine');
	let mine = $state<Assignment[]>([]);
	let created = $state<Assignment[]>([]);
	let loading = $state(true);
	let error = $state('');
	let showDone = $state(false);
	let draft = $state('');
	let adding = $state(false);

	let editorOpen = $state(false);
	let editingId = $state<string | null>(null);

	const signedIn = $derived(!!authStore.user);
	const myId = $derived(authStore.user?.id ?? null);

	// "Assigned to me" is mine plus nothing-yet-taken group tasks only when
	// "My groups" is not its own filter: with sign-in off it is every task.
	const visible = $derived.by(() => {
		if (filter === 'created') return created;
		if (filter === 'groups') return mine.filter((t) => t.assignee?.type === 'group');
		return signedIn
			? mine.filter((t) => t.assignee?.type === 'account' && t.assignee.id === myId)
			: mine;
	});
	const groupCount = $derived(
		mine.filter((t) => t.assignee?.type === 'group' && t.status !== 'done').length
	);

	const sections = $derived.by(() => {
		const today = localToday();
		const weekEnd = localToday(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
		const open = visible.filter((t) => t.status !== 'done');
		return [
			{
				key: 'overdue',
				label: 'Overdue',
				urgent: true,
				items: open.filter((t) => t.dueDate && t.dueDate < today)
			},
			{
				key: 'week',
				label: 'Due this week',
				urgent: false,
				items: open.filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd)
			},
			{
				key: 'later',
				label: 'Later',
				urgent: false,
				items: open.filter((t) => t.dueDate && t.dueDate > weekEnd)
			},
			{ key: 'none', label: 'No due date', urgent: false, items: open.filter((t) => !t.dueDate) }
		];
	});
	const doneItems = $derived(visible.filter((t) => t.status === 'done'));

	$effect(() => {
		void assignmentsStore.version;
		void load(showDone);
	});

	async function load(includeDone: boolean) {
		try {
			const [m, c] = await Promise.all([
				AssignmentService.mine(includeDone),
				signedIn ? AssignmentService.created(includeDone) : Promise.resolve({ items: [] })
			]);
			mine = m.items;
			created = c.items;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load your tasks';
		} finally {
			loading = false;
		}
	}

	async function quickAdd() {
		const title = draft.trim();
		if (!title) return;
		adding = true;
		try {
			await AssignmentService.create({
				title,
				assignee: myId ? { type: 'account', id: myId } : null
			});
			draft = '';
			if (filter !== 'mine') filter = 'mine';
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

	const filters: { value: Filter; label: string }[] = [
		{ value: 'mine', label: 'Assigned to me' },
		{ value: 'groups', label: 'My groups' },
		{ value: 'created', label: 'Given out by me' }
	];
</script>

<!-- pt-16 below md: the sidebar toggle and the close button are fixed in
     the top corners there, as on every full page. -->
<div class="mx-auto w-full max-w-3xl space-y-6 p-4 pt-16 md:p-6 md:pt-28">
	<div class="flex items-center gap-3">
		<ListTodo class="h-6 w-6 shrink-0" />

		<div class="min-w-0 flex-1">
			<h1 class="truncate text-lg font-semibold">My tasks</h1>
			<p class="text-sm text-muted-foreground">
				Given to you or your groups, in every project and outside them
			</p>
		</div>

		<Button
			size="sm"
			variant="outline"
			onclick={() => {
				editingId = null;
				editorOpen = true;
			}}
		>
			<Plus class="h-3 w-3" /> New task
		</Button>
	</div>

	{#if signedIn}
		<div class="flex flex-wrap gap-1" role="tablist">
			{#each filters as f (f.value)}
				<Button
					size="sm"
					variant={filter === f.value ? 'secondary' : 'ghost'}
					role="tab"
					aria-selected={filter === f.value}
					onclick={() => (filter = f.value)}
				>
					{f.label}
					{#if f.value === 'groups' && groupCount > 0}
						<span class="ml-1 rounded-full bg-primary/15 px-1.5 text-xs">{groupCount}</span>
					{/if}
				</Button>
			{/each}
		</div>
		{#if filter === 'groups'}
			<p class="text-xs text-muted-foreground">
				Given to a group you are in and not yet taken. Open one and choose Take it.
			</p>
		{:else if filter === 'created'}
			<p class="text-xs text-muted-foreground">
				Tasks you gave out that are in no project. Project tasks are on each project's page.
			</p>
		{/if}
	{/if}

	<Input
		bind:value={draft}
		placeholder={signedIn
			? 'Add a task for yourself and press Enter'
			: 'Add a task and press Enter'}
		maxlength={200}
		disabled={adding}
		onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && quickAdd()}
	/>

	{#if loading}
		<div class="flex justify-center"><Loader class="h-5 w-5 animate-spin" /></div>
	{:else if error}
		<div class="text-sm text-destructive">{error}</div>
	{:else}
		{@const total = sections.reduce((n, s) => n + s.items.length, 0)}
		{#if total === 0}
			<div class="text-sm text-muted-foreground italic">
				{filter === 'created'
					? 'You have not given anyone a task outside a project.'
					: 'Nothing to do. Enjoy it.'}
			</div>
		{/if}
		{#each sections as s (s.key)}
			{#if s.items.length > 0}
				<section class="space-y-1">
					<h2 class="text-xs font-medium {s.urgent ? 'text-destructive' : 'text-muted-foreground'}">
						{s.label} · {s.items.length}
					</h2>
					<ul class="divide-y rounded-lg border">
						{#each s.items as task (task.id)}
							<AssignmentRow {task} hideOwnAssignee onOpen={openTask} onToggleDone={toggleDone} />
						{/each}
					</ul>
				</section>
			{/if}
		{/each}

		<button
			class="text-xs text-muted-foreground hover:underline"
			onclick={() => (showDone = !showDone)}
		>
			{showDone ? 'Hide done' : 'Show done'}
		</button>
		{#if showDone && doneItems.length > 0}
			<section class="space-y-1">
				<h2 class="text-xs font-medium text-muted-foreground">Done · {doneItems.length}</h2>
				<ul class="divide-y rounded-lg border">
					{#each doneItems as task (task.id)}
						<AssignmentRow {task} hideOwnAssignee onOpen={openTask} onToggleDone={toggleDone} />
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>

<AssignmentEditor bind:open={editorOpen} taskId={editingId} assignToMe />
