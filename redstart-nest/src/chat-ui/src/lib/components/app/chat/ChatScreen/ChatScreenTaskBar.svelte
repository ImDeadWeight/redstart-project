<script lang="ts">
	import { LoaderCircle, Square } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import {
		ChatMessageActionCardContinueRequest,
		ChatMessageActionCardPermissionRequest
	} from '$lib/components/app';
	import { tasksStore } from '$lib/stores/tasks.svelte';
	import { approvalDecisionFor, taskStatusLabel } from '$lib/services/task.service';
	import type { ToolPermissionDecision } from '$lib/enums';

	/**
	 * The background task holding this chat (agent-runtime Phase 3.9, U-b):
	 * its state and Cancel, and — when it waits on the user — the same
	 * approval and continue cards a chat shows, answered through the task
	 * routes instead of the browser loop. Its questions are shown with the
	 * composer like every chat's (ChatFormQuestion.svelte). Nothing renders for a chat
	 * with no live task.
	 */
	interface Props {
		conversationId: string | null | undefined;
	}

	let { conversationId }: Props = $props();

	const task = $derived(tasksStore.activeFor(conversationId));
	const waiting = $derived(task?.waiting ?? null);
	let busy = $state(false);

	async function run(fn: () => Promise<unknown>) {
		if (busy || !conversationId) return;
		busy = true;
		try {
			await fn();
		} finally {
			busy = false;
		}
	}

	function onPermission(decision: ToolPermissionDecision) {
		const id = conversationId;
		if (!id) return;
		void run(() => tasksStore.decideApproval(id, approvalDecisionFor(decision)));
	}

	function onContinue(shouldContinue: boolean) {
		const id = conversationId;
		if (!id) return;
		void run(() => tasksStore.answer(id, { continue: shouldContinue }));
	}

	function onCancel() {
		const id = conversationId;
		if (!id) return;
		void run(() => tasksStore.cancel(id));
	}
</script>

{#if task}
	<div class="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-2" data-testid="task-bar">
		<div
			class="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm"
		>
			{#if !waiting || waiting.kind === 'model'}
				<LoaderCircle class="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
			{/if}
			<span class="min-w-0 flex-1 truncate">{taskStatusLabel(task)}</span>
			<span class="hidden text-xs text-muted-foreground sm:inline">
				Messages you send go to the task.
			</span>
			<Button size="sm" variant="ghost" disabled={busy} onclick={onCancel} title="Cancel the task">
				<Square class="h-3.5 w-3.5" />
				Cancel
			</Button>
		</div>

		<!-- A question is shown with the composer (ChatFormQuestion.svelte). -->
		{#if waiting?.kind === 'approval'}
			{#key waiting.approval.id}
				<ChatMessageActionCardPermissionRequest
					toolName={waiting.tool}
					serverLabel=""
					onDecision={onPermission}
				/>
				{#if waiting.approval.summary}
					<p class="px-1 text-xs break-all text-muted-foreground">{waiting.approval.summary}</p>
				{/if}
			{/key}
		{:else if waiting?.kind === 'continue'}
			<ChatMessageActionCardContinueRequest onDecision={onContinue} />
		{/if}
	</div>
{/if}
