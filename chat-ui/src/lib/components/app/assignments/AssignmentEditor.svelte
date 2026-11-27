<script lang="ts">
	/**
	 * The task editor (tasks plan Phase 1): a side panel for a new task or an
	 * existing one, with its history below. Every field the caller may not
	 * change, by Nest's `can`, is shown read-only; Save sends only what changed,
	 * so a viewer finishing their own task never trips over a field they
	 * cannot touch.
	 */
	import { Loader, Trash2, RotateCcw, Hand, Undo2, MessageSquare, X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		AssignmentService,
		ASSIGNMENT_STATUSES,
		statusLabel,
		type AssigneeChoices,
		type Assignee,
		type Assignment,
		type AssignmentHistoryEntry,
		type AssignmentStatus
	} from '$lib/services/assignment.service';
	import { canEditProject } from '$lib/services/project.service';
	import { projectsStore } from '$lib/stores/projects.svelte';
	import { assignmentsStore } from '$lib/stores/assignments.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { ROUTES } from '$lib/constants/routes';
	import { RouterService } from '$lib/services/router.service';

	interface Props {
		open: boolean;
		/** The task to open, or null for a new one. */
		taskId: string | null;
		/** For a new task: the project it starts in. */
		defaultProjectId?: string | null;
		/** For a new task: give it to the signed-in person. */
		assignToMe?: boolean;
		onChanged?: () => void;
	}

	let {
		open = $bindable(),
		taskId,
		defaultProjectId = null,
		assignToMe = false,
		onChanged
	}: Props = $props();

	let task = $state<Assignment | null>(null);
	let loading = $state(false);
	let saving = $state(false);
	let loadError = $state('');
	let commentDraft = $state('');
	let commenting = $state(false);

	let title = $state('');
	let notes = $state('');
	let status = $state<AssignmentStatus>('open');
	let dueDate = $state('');
	let assigneeKey = $state('');
	let projectId = $state('');

	let choices = $state<AssigneeChoices>({ accounts: [], groups: [] });

	const isNew = $derived(!taskId);
	const signedIn = $derived(!!authStore.user);
	const can = $derived(
		task?.can ?? {
			edit: true,
			status: true,
			assign: true,
			claim: false,
			release: false,
			delete: false,
			move: true
		}
	);
	const deleted = $derived(!!task?.deletedAt);
	const writableProjects = $derived(projectsStore.projects.filter((p) => canEditProject(p)));

	const keyOf = (a: Assignee | null) => (a ? `${a.type}:${a.id}` : '');
	const assigneeOf = (key: string): Assignee | null => {
		if (!key) return null;
		const [type, ...rest] = key.split(':');
		return { type: type as Assignee['type'], id: rest.join(':') };
	};

	$effect(() => {
		if (open) void init(taskId);
	});

	// The people a task can go to depend on its project.
	$effect(() => {
		if (open && signedIn) void loadChoices(projectId || null);
	});

	async function init(id: string | null) {
		loadError = '';
		void projectsStore.ensureLoaded();
		if (!id) {
			task = null;
			title = '';
			notes = '';
			status = 'open';
			dueDate = '';
			projectId = defaultProjectId ?? '';
			assigneeKey = assignToMe && authStore.user ? `account:${authStore.user.id}` : '';
			return;
		}
		loading = true;
		try {
			fill(await AssignmentService.get(id));
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Could not open this task';
			task = null;
		} finally {
			loading = false;
		}
	}

	function fill(t: Assignment) {
		task = t;
		title = t.title;
		notes = t.notes;
		status = t.status;
		dueDate = t.dueDate ?? '';
		projectId = t.projectId ?? '';
		assigneeKey = keyOf(t.assignee);
	}

	async function loadChoices(pid: string | null) {
		try {
			choices = await AssignmentService.assignees(pid);
		} catch {
			choices = { accounts: [], groups: [] };
		}
	}

	// The current assignee stays selectable even when they have left the
	// project, so opening the task does not silently pick someone else.
	const assigneeMissing = $derived(
		!!task?.assignee &&
			assigneeKey === keyOf(task.assignee) &&
			task.assignee.type !== 'agent' &&
			!choices.accounts.some((a) => `account:${a.id}` === assigneeKey) &&
			!choices.groups.some((g) => `group:${g.id}` === assigneeKey)
	);

	function done(t: Assignment | null, message?: string) {
		if (t) fill(t);
		assignmentsStore.changed();
		onChanged?.();
		if (message) toast.success(message);
	}

	async function save() {
		if (!title.trim()) return;
		saving = true;
		try {
			if (isNew) {
				const created = await AssignmentService.create({
					title: title.trim(),
					notes,
					status,
					dueDate: dueDate || null,
					projectId: projectId || null,
					assignee: assigneeOf(assigneeKey)
				});
				done(created, 'Task added');
				open = false;
				return;
			}
			if (!task) return;
			const draft: Record<string, unknown> = {};
			if (can.edit && title.trim() !== task.title) draft.title = title.trim();
			if (can.edit && notes !== task.notes) draft.notes = notes;
			if (can.edit && (dueDate || null) !== task.dueDate) draft.dueDate = dueDate || null;
			if (can.status && status !== task.status) draft.status = status;
			if (can.assign && assigneeKey !== keyOf(task.assignee))
				draft.assignee = assigneeOf(assigneeKey);
			if (can.move && (projectId || null) !== task.projectId) draft.projectId = projectId || null;
			if (Object.keys(draft).length === 0) {
				open = false;
				return;
			}
			done(await AssignmentService.update(task.id, draft), 'Saved');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save the task');
		} finally {
			saving = false;
		}
	}

	async function act(fn: () => Promise<Assignment | void>, message: string, close = false) {
		saving = true;
		try {
			const r = await fn();
			done(r || null, message);
			if (close) open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'That did not work');
		} finally {
			saving = false;
		}
	}

	/**
	 * A new chat about this task, in its project when it has one, with a first
	 * message the person can edit before sending. The id is in it so the
	 * assistant can find the task (assignment_list, assignment_update) when
	 * Tasks is on; the chat itself stays private, as every chat is.
	 */
	/** Comments (tasks plan Phase 3): anyone who can see the task may add one. */
	async function postComment() {
		const text = commentDraft.trim();
		if (!task || !text) return;
		commenting = true;
		try {
			fill(await AssignmentService.addComment(task.id, text));
			commentDraft = '';
			onChanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not add the comment');
		} finally {
			commenting = false;
		}
	}

	async function removeComment(commentId: string) {
		if (!task) return;
		try {
			fill(await AssignmentService.deleteComment(task.id, commentId));
			onChanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the comment');
		}
	}

	function startChat() {
		if (!task) return;
		const due = task.dueDate ? `, due ${task.dueDate}` : '';
		chatStore.savePendingDraft(
			`About the task "${task.title}" (assignment ${task.id}${due}): `,
			[]
		);
		open = false;
		void goto(task.projectId ? RouterService.newChatInProject(task.projectId) : ROUTES.NEW_CHAT);
	}

	function describe(h: AssignmentHistoryEntry): string {
		const person = h.byName ?? (h.by ? 'A removed account' : 'Redstart');
		// Changes the assistant made in someone's chat (tasks plan Phase 2).
		const who = h.via === 'assistant' ? `${person} (through the assistant)` : person;
		switch (h.action) {
			case 'created':
				return `${who} created this`;
			case 'edited':
				return `${who} changed the ${(h.fields ?? []).map((f) => (f === 'dueDate' ? 'due date' : f)).join(', ')}`;
			case 'status':
				return `${who} moved it from ${statusLabel(h.from as AssignmentStatus)} to ${statusLabel(h.to as AssignmentStatus)}`;
			case 'assigned':
				return h.to
					? `${who} gave it to ${h.toName ?? 'someone'}`
					: `${who} took it off ${h.fromName ?? 'its assignee'}`;
			case 'claimed':
				return `${who} took it from ${h.fromName ?? 'the group'}`;
			case 'released':
				return `${who} handed it back to ${h.toName ?? 'the group'}`;
			case 'moved':
				if (h.reason === 'project deleted') return 'Its project was deleted';
				return h.to
					? `${who} moved it to ${h.toName ?? 'a project'}`
					: `${who} took it out of ${h.fromName ?? 'its project'}`;
			case 'deleted':
				return `${who} deleted it`;
			case 'restored':
				return `${who} restored it`;
			case 'unassigned':
				if (h.reason?.startsWith('assistant'))
					return `Back to ${h.toName ?? 'no one'} from the assistant`;
				return `Unassigned: ${h.fromName ?? 'its assignee'} was removed`;
			case 'agent_started':
				return 'The assistant started on it';
			case 'agent_finished':
				return h.outcome === 'done'
					? 'The assistant finished'
					: h.outcome === 'cancelled'
						? 'The assistant was stopped'
						: 'The assistant could not finish';
			default:
				return h.action;
		}
	}

	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});

	const selectClass =
		'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:opacity-60';
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 overflow-y-auto sm:max-w-md">
		<Sheet.Header>
			<Sheet.Title>{isNew ? 'New task' : 'Task'}</Sheet.Title>
			{#if task?.createdByName}
				<Sheet.Description>
					Made by {task.createdByName}
					{#if task.claimedFromName}· taken from {task.claimedFromName}{/if}
				</Sheet.Description>
			{/if}
		</Sheet.Header>

		{#if task?.agentRun}
			<div class="mx-4 mb-2 rounded-md border px-2 py-1.5 text-sm">
				{#if task.agentRun.running}
					The assistant is working on this{task.agentRun.byName
						? ` for ${task.agentRun.byName}`
						: ''}.
				{:else if task.agentRun.outcome === 'done'}
					The assistant finished. Check its work, then mark the task done.
				{:else}
					The assistant {task.agentRun.outcome === 'cancelled'
						? 'was stopped'
						: 'could not finish'}.
				{/if}
				{#if task.agentRun.conversationId}
					<a
						class="underline"
						href={RouterService.chat(task.agentRun.conversationId)}
						onclick={() => (open = false)}>Open its chat</a
					>
				{/if}
			</div>
		{/if}

		{#if loading}
			<div class="flex justify-center p-6"><Loader class="h-5 w-5 animate-spin" /></div>
		{:else if loadError}
			<div class="p-4 text-sm text-destructive">{loadError}</div>
		{:else}
			<div class="space-y-4 px-4 pb-4">
				{#if deleted}
					<div class="rounded-md border border-destructive/40 p-2 text-sm">
						This task is deleted. It can be restored for 30 days.
					</div>
				{/if}

				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground">Title</span>
					<Input
						bind:value={title}
						readonly={!can.edit || deleted}
						maxlength={200}
						placeholder="What needs doing"
						onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && isNew && save()}
					/>
				</label>

				<div class="grid grid-cols-2 gap-3">
					<label class="block space-y-1">
						<span class="text-xs font-medium text-muted-foreground">Status</span>
						<select bind:value={status} disabled={!can.status || deleted} class={selectClass}>
							{#each ASSIGNMENT_STATUSES as s (s.value)}
								<option value={s.value}>{s.label}</option>
							{/each}
						</select>
					</label>
					<label class="block space-y-1">
						<span class="text-xs font-medium text-muted-foreground">Due</span>
						<input
							type="date"
							bind:value={dueDate}
							disabled={!can.edit || deleted}
							class={selectClass}
						/>
					</label>
				</div>

				{#if signedIn}
					<label class="block space-y-1">
						<span class="text-xs font-medium text-muted-foreground">Assigned to</span>
						<select bind:value={assigneeKey} disabled={!can.assign || deleted} class={selectClass}>
							<option value="">No one</option>
							<option value="agent:assistant">The assistant</option>
							{#if assigneeMissing && task?.assignee}
								<option value={keyOf(task.assignee)}
									>{task.assigneeName ?? 'Someone'} (no longer in the project)</option
								>
							{/if}
							{#if choices.groups.length}
								<optgroup label="Groups">
									{#each choices.groups as g (g.id)}
										<option value={`group:${g.id}`}>{g.name}</option>
									{/each}
								</optgroup>
							{/if}
							<optgroup label="People">
								{#each choices.accounts as a (a.id)}
									<option value={`account:${a.id}`}
										>{a.username}{a.id === authStore.user?.id ? ' (me)' : ''}</option
									>
								{/each}
							</optgroup>
						</select>
						{#if projectId}
							<span class="text-xs text-muted-foreground"
								>Only people and groups the project is shared with.</span
							>
						{/if}
					</label>
				{/if}

				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground">Project</span>
					<select bind:value={projectId} disabled={!can.move || deleted} class={selectClass}>
						<option value="">No project</option>
						{#if task?.projectId && !writableProjects.some((p) => p.id === task?.projectId)}
							<option value={task.projectId}>{task.projectName ?? 'This project'}</option>
						{/if}
						{#each writableProjects as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>

				<label class="block space-y-1">
					<span class="text-xs font-medium text-muted-foreground">Notes</span>
					<Textarea
						bind:value={notes}
						readonly={!can.edit || deleted}
						rows={5}
						maxlength={8000}
						placeholder="Details, links, what done looks like"
					/>
				</label>

				<div class="flex flex-wrap items-center gap-2">
					{#if !deleted}
						<Button size="sm" onclick={save} disabled={saving || !title.trim()}>
							{#if saving}<Loader class="h-3 w-3 animate-spin" />{/if}
							{isNew ? 'Add task' : 'Save'}
						</Button>
					{/if}
					{#if task && can.claim && !deleted}
						<Button
							size="sm"
							variant="outline"
							disabled={saving}
							onclick={() => act(() => AssignmentService.claim(task!.id), 'It is yours now')}
						>
							<Hand class="h-3 w-3" /> Take it
						</Button>
					{/if}
					{#if task && can.release && !deleted}
						<Button
							size="sm"
							variant="outline"
							disabled={saving}
							onclick={() =>
								act(() => AssignmentService.release(task!.id), 'Handed back to the group')}
						>
							<Undo2 class="h-3 w-3" /> Hand back
						</Button>
					{/if}
					{#if task && !deleted}
						<Button size="sm" variant="ghost" disabled={saving} onclick={startChat}>
							<MessageSquare class="h-3 w-3" /> Start a chat
						</Button>
					{/if}
					<div class="flex-1"></div>
					{#if task && can.delete && !deleted}
						<Button
							size="sm"
							variant="ghost"
							disabled={saving}
							aria-label="Delete task"
							onclick={() => act(() => AssignmentService.remove(task!.id), 'Task deleted', true)}
						>
							<Trash2 class="h-4 w-4" />
						</Button>
					{/if}
					{#if task && can.delete && deleted}
						<Button
							size="sm"
							variant="outline"
							disabled={saving}
							onclick={() => act(() => AssignmentService.restore(task!.id), 'Task restored')}
						>
							<RotateCcw class="h-3 w-3" /> Restore
						</Button>
					{/if}
				</div>

				{#if task}
					<div class="space-y-2 border-t pt-3">
						<h3 class="text-xs font-medium text-muted-foreground">
							Comments{task.comments?.length ? ` · ${task.comments.length}` : ''}
						</h3>
						{#if task.comments?.length}
							<ul class="space-y-2">
								{#each task.comments as c (c.id)}
									<li class="group rounded-md bg-muted/40 px-2 py-1.5 text-sm">
										<div
											class="flex items-center justify-between gap-2 text-xs text-muted-foreground"
										>
											<span
												>{c.via === 'assistant'
													? 'The assistant'
													: (c.byName ?? 'A removed account')} · {when(c.at)}</span
											>
											{#if c.canDelete}
												<button
													class="opacity-60 hover:opacity-100"
													aria-label="Delete comment"
													onclick={() => removeComment(c.id)}
												>
													<X class="h-3 w-3" />
												</button>
											{/if}
										</div>
										<p class="mt-0.5 whitespace-pre-wrap">{c.text}</p>
									</li>
								{/each}
							</ul>
						{/if}
						{#if !deleted && task.can.comment !== false}
							<Textarea
								bind:value={commentDraft}
								rows={2}
								maxlength={4000}
								placeholder="Add a comment"
								aria-label="Add a comment"
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={commenting || !commentDraft.trim()}
								onclick={postComment}
							>
								Comment
							</Button>
						{/if}
					</div>
				{/if}

				{#if task?.history?.length}
					<div class="space-y-1 border-t pt-3">
						<h3 class="text-xs font-medium text-muted-foreground">History</h3>
						<ul class="space-y-1">
							{#each [...task.history].reverse() as h, i (i)}
								<li class="flex justify-between gap-3 text-xs">
									<span>{describe(h)}</span>
									<span class="shrink-0 text-muted-foreground">{when(h.at)}</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
