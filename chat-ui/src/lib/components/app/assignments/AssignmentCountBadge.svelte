<script lang="ts">
	/**
	 * The open-task count beside "My tasks" (tasks plan Phase 1), red when any
	 * is overdue. `dot` is the collapsed rail's form: a small mark on the icon.
	 * Hidden at zero and when Nest has no tasks to count (an older server).
	 */
	import { onMount } from 'svelte';
	import { assignmentsStore } from '$lib/stores/assignments.svelte';

	interface Props {
		dot?: boolean;
	}

	let { dot = false }: Props = $props();

	onMount(() => assignmentsStore.start());

	const open = $derived(assignmentsStore.counts?.open ?? 0);
	const overdue = $derived(assignmentsStore.counts?.overdue ?? 0);
	const label = $derived(overdue > 0 ? `${open} open, ${overdue} overdue` : `${open} open`);
</script>

{#if open > 0}
	{#if dot}
		<span
			class="pointer-events-none absolute top-1 right-1 h-2 w-2 rounded-full {overdue > 0
				? 'bg-destructive'
				: 'bg-primary'}"
			aria-label={label}
		></span>
	{:else}
		<span
			class="rounded-full px-1.5 text-xs leading-5 tabular-nums {overdue > 0
				? 'text-destructive-foreground bg-destructive'
				: 'bg-primary/15 text-foreground'}"
			aria-label={label}
			title={label}>{open > 99 ? '99+' : open}</span
		>
	{/if}
{/if}
