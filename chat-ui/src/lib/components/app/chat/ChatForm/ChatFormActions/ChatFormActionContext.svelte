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

	// Circular "torus" gauge geometry (see the SVG ring below).
	const RING_SIZE = 16;
	const RING_STROKE = 2.5;
	const RING_R = (RING_SIZE - RING_STROKE) / 2;
	const RING_C = 2 * Math.PI * RING_R;

	// How much of the ring is "unfilled" — dashoffset shrinks as usage grows.
	const ringOffset = $derived(
		usage ? RING_C * (1 - Math.min(100, Math.max(0, usage.percent)) / 100) : RING_C
	);

	// System orange accent by default; escalate to red at 80% so the "getting
	// full / about to auto-compact" warning shows before overflow.
	const ringColor = $derived(
		!usage ? '' : usage.percent >= 80 ? 'text-red-500' : 'text-orange-500'
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
			<span class="relative inline-flex items-center justify-center">
				<svg
					width={RING_SIZE}
					height={RING_SIZE}
					viewBox="0 0 {RING_SIZE} {RING_SIZE}"
					class="-rotate-90"
					aria-hidden="true"
				>
					<!-- track -->
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_R}
						fill="none"
						stroke="currentColor"
						stroke-width={RING_STROKE}
						class="text-muted-foreground/25"
					/>
					<!-- usage arc -->
					<circle
						cx={RING_SIZE / 2}
						cy={RING_SIZE / 2}
						r={RING_R}
						fill="none"
						stroke="currentColor"
						stroke-width={RING_STROKE}
						stroke-linecap="round"
						stroke-dasharray={RING_C}
						stroke-dashoffset={ringOffset}
						class="{ringColor} transition-[stroke-dashoffset] duration-300"
					/>
				</svg>
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
