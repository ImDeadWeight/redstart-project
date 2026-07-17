<script lang="ts">
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import {
		ContextCompactionService,
		type ContextUsage
	} from '$lib/services/context-compaction.service';

	interface Props {
		isLoading?: boolean;
	}

	let { isLoading = false }: Props = $props();

	let usage = $state<ContextUsage | null>(null);
	let compacting = $state(false);
	let outcome = $state<string | null>(null);
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;

	// Re-estimate whenever the conversation or its message count changes and
	// nothing is streaming. Debounced: estimation includes a /tokenize call.
	$effect(() => {
		const conv = conversationsStore.activeConversation;
		const messageCount = conversationsStore.activeMessages.length;
		void messageCount;
		if (!conv || isLoading) return;
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(async () => {
			usage = await ContextCompactionService.estimateUsage(
				conv.id,
				conversationsStore.activeMessages
			);
		}, 600);
		return () => clearTimeout(refreshTimer);
	});

	const barColor = $derived(
		!usage ? '' : usage.percent >= 90 ? 'bg-red-500' : usage.percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
	);

	const tooltip = $derived(
		!usage
			? ''
			: `Context: ~${usage.usedTokens.toLocaleString()} of ${usage.nCtx.toLocaleString()} tokens (${usage.percent}%)` +
				(usage.summarized ? ' — older messages are summarized' : '') +
				'. Click to compact the conversation.'
	);

	async function handleCompact() {
		const conv = conversationsStore.activeConversation;
		if (!conv || compacting || isLoading) return;
		compacting = true;
		outcome = null;
		try {
			const result = await ContextCompactionService.compactNow(
				conv.id,
				conversationsStore.activeMessages
			);
			outcome = result.message;
			if (result.compacted) {
				usage = await ContextCompactionService.estimateUsage(
					conv.id,
					conversationsStore.activeMessages
				);
			}
			setTimeout(() => (outcome = null), 4000);
		} finally {
			compacting = false;
		}
	}
</script>

{#if usage && conversationsStore.activeMessages.length > 0}
	<div class="flex items-center gap-2">
		<button
			type="button"
			class="group flex items-center gap-1.5 rounded px-1 py-0.5 transition-opacity hover:opacity-80 disabled:cursor-wait"
			title={tooltip}
			aria-label={tooltip}
			disabled={compacting}
			onclick={handleCompact}
		>
			<span class="bg-muted relative block h-1.5 w-14 overflow-hidden rounded-full">
				<span
					class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 {barColor}"
					style="width: {Math.max(3, usage.percent)}%"
				></span>
			</span>

			<span class="text-muted-foreground text-[10px] tabular-nums select-none">
				{#if compacting}
					compacting…
				{:else}
					{usage.percent}%{usage.summarized ? ' ◆' : ''}
				{/if}
			</span>
		</button>

		{#if outcome}
			<span class="text-muted-foreground max-w-48 truncate text-[10px]">{outcome}</span>
		{/if}
	</div>
{/if}
