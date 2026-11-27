<script lang="ts">
	/**
	 * One task in a list (tasks plan Phase 1): a tick box to finish it, the
	 * title, and what it is about — project, who has it, when it is due. The
	 * whole row opens the editor. Nest's `can` decides whether the box works.
	 */
	import {
		CalendarDays,
		FolderKanban,
		User,
		Users,
		AlertTriangle,
		MessageSquare,
		Bot
	} from '@lucide/svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { authStore } from '$lib/stores/auth.svelte';
	import {
		isOverdue,
		localToday,
		statusLabel,
		type Assignment
	} from '$lib/services/assignment.service';

	interface Props {
		task: Assignment;
		/** Hide the project name (the list is already one project's). */
		hideProject?: boolean;
		/** Hide who has it when it is the viewer (a list of their own tasks). */
		hideOwnAssignee?: boolean;
		/** Hide the status word (the list is already grouped by status). */
		hideStatus?: boolean;
		/** Came to the viewer since they last looked (My tasks, Phase 3). */
		isNew?: boolean;
		onOpen: (task: Assignment) => void;
		onToggleDone: (task: Assignment, done: boolean) => void;
	}

	let {
		task,
		hideProject = false,
		hideOwnAssignee = false,
		hideStatus = false,
		isNew = false,
		onOpen,
		onToggleDone
	}: Props = $props();

	const isMe = $derived(
		task.assignee?.type === 'account' && !!authStore.user && task.assignee.id === authStore.user.id
	);

	const done = $derived(task.status === 'done');
	const overdue = $derived(isOverdue(task));

	function formatDue(date: string): string {
		const today = localToday();
		if (date === today) return 'Today';
		const [y, m, d] = date.split('-').map(Number);
		const when = new Date(y, m - 1, d);
		const sameYear = y === new Date().getFullYear();
		return when.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			...(sameYear ? {} : { year: 'numeric' })
		});
	}
</script>

<li class="flex items-start gap-3 px-3 py-2 text-sm hover:bg-accent/50">
	<div class="pt-0.5">
		<Checkbox
			checked={done}
			disabled={!task.can.status}
			onCheckedChange={(v) => onToggleDone(task, v === true)}
			aria-label={done ? `Reopen "${task.title}"` : `Mark "${task.title}" done`}
		/>
	</div>
	<button class="min-w-0 flex-1 text-left" onclick={() => onOpen(task)}>
		<div class="flex items-center gap-2">
			<span class="truncate {done ? 'text-muted-foreground line-through' : ''}">{task.title}</span>
			{#if isNew && !done}
				<span
					class="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary"
					>New</span
				>
			{/if}
		</div>
		<div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
			{#if !hideStatus && (task.status === 'in_progress' || task.status === 'blocked')}
				<span class={task.status === 'blocked' ? 'text-destructive' : ''}
					>{statusLabel(task.status)}</span
				>
			{/if}
			{#if !hideProject && task.projectName}
				<span class="flex items-center gap-1"
					><FolderKanban class="h-3 w-3" />{task.projectName}</span
				>
			{/if}
			{#if task.assignee && !(isMe && hideOwnAssignee && !task.assigneeLeft)}
				<span class="flex items-center gap-1">
					{#if task.assignee.type === 'agent'}<Bot
							class="h-3 w-3"
						/>{:else if task.assignee.type === 'group'}<Users class="h-3 w-3" />{:else}<User
							class="h-3 w-3"
						/>{/if}
					{isMe ? 'you' : (task.assigneeName ?? 'someone')}
					{#if task.assigneeLeft}
						<span class="flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
							><AlertTriangle class="h-3 w-3" /> left the project</span
						>
					{/if}
				</span>
			{:else if task.formerAssignee}
				<span>Unassigned (was {task.formerAssignee.name ?? 'removed'})</span>
			{/if}
			{#if task.dueDate}
				<span class="flex items-center gap-1 {overdue ? 'font-medium text-destructive' : ''}">
					<CalendarDays class="h-3 w-3" />{formatDue(task.dueDate)}
				</span>
			{/if}
			{#if task.commentCount}
				<span class="flex items-center gap-1" title="{task.commentCount} comments"
					><MessageSquare class="h-3 w-3" />{task.commentCount}</span
				>
			{/if}
		</div>
	</button>
</li>
