<script lang="ts">
	/**
	 * Above the composer: the chat's update_plan checklist (agent-runtime plan
	 * §4, 1.2). The model keeps it; this only shows it, plus a way to clear it.
	 * Clearing matters: while steps are open, every request carries them and
	 * the first answer of each flow gets one "these steps are still open"
	 * nudge, so a plan the user has moved on from would keep steering the chat.
	 *
	 * Open while steps are open; collapses to one line once they are all done
	 * or skipped.
	 */
	import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleDot, CircleMinus, ListChecks, X } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { planProgress } from '$lib/utils/agentic';

	const conversationId = $derived(conversationsStore.activeConversation?.id ?? null);
	const steps = $derived(conversationsStore.activeConversation?.plan?.steps ?? []);
	const progress = $derived(planProgress(steps));

	let expandedOverride = $state<boolean | null>(null);
	const expanded = $derived(expandedOverride ?? progress.open > 0);

	// Each change to the plan (or another chat's plan) goes back to the
	// default view: open while steps are open.
	const planVersion = $derived(
		`${conversationId}:${conversationsStore.activeConversation?.plan?.updatedAt ?? ''}`
	);
	let prevVersion = '';
	$effect(() => {
		if (planVersion !== prevVersion) {
			prevVersion = planVersion;
			expandedOverride = null;
		}
	});

	let clearing = $state(false);
	async function clear() {
		if (!conversationId) return;
		clearing = true;
		try {
			await conversationsStore.setConversationPlan(conversationId, null);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not clear the plan');
		} finally {
			clearing = false;
		}
	}
</script>

{#if steps.length > 0}
	<div class="mb-2 rounded-lg border border-border bg-card px-3 py-2 text-xs" data-testid="chat-plan">
		<div class="flex items-center gap-2">
			<ListChecks class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
				aria-expanded={expanded}
				onclick={() => (expandedOverride = !expanded)}
			>
				<span class="truncate">Plan · {progress.label}</span>
				{#if expanded}
					<ChevronUp class="h-3.5 w-3.5 shrink-0" />
				{:else}
					<ChevronDown class="h-3.5 w-3.5 shrink-0" />
				{/if}
			</button>
			<button
				type="button"
				class="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
				aria-label="Clear the plan"
				title="Clear the plan"
				disabled={clearing}
				onclick={clear}
			>
				<X class="h-3.5 w-3.5" />
			</button>
		</div>

		{#if expanded}
			<ol class="mt-1.5 space-y-1">
				{#each steps as step, i (i)}
					<li class="flex items-start gap-2" data-status={step.status}>
						{#if step.status === 'done'}
							<CircleCheck class="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" aria-label="done" />
						{:else if step.status === 'in_progress'}
							<CircleDot class="mt-px h-3.5 w-3.5 shrink-0 text-sky-500" aria-label="in progress" />
						{:else if step.status === 'skipped'}
							<CircleMinus class="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="skipped" />
						{:else}
							<Circle class="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="pending" />
						{/if}
						<span class:line-through={step.status === 'skipped'} class:text-muted-foreground={step.status === 'done' || step.status === 'skipped'}>
							{step.text}
							{#if step.note}
								<span class="text-muted-foreground"> — {step.note}</span>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
{/if}
