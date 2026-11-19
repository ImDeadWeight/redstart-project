<script lang="ts">
	/**
	 * Above the composer: what automatic memory (projects-plan Phase 3) found
	 * in this chat.
	 *
	 *  - Suggest mode: "Remember …?" with Save and Dismiss. Dismiss is for
	 *    good: the review won't propose that text again. Each chip shows its
	 *    kind, and the user's own words it was taken from (agent-runtime D36,
	 *    8.6), so the user can judge it. A forget reads "Forget: …" (a forget
	 *    is only ever suggested, D38); a merge lists what it folds in.
	 *  - Automatic mode: "Remembered …" with Undo (an update gets its old
	 *    text, kind and why back; a merge also the memories it folded in), and
	 *    a close button that keeps it.
	 *
	 * Also tells memoryReviewStore which chat is open, which is what reviews a
	 * chat the user has just left and loads this one's pending suggestions.
	 */
	import { Brain, Check, X, Undo2, FolderKanban } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { memoryReviewStore } from '$lib/stores/memory-review.svelte';
	import { KIND_LABELS, type MemorySuggestion } from '$lib/services/memory.service';
	import { suggestionLabel } from './memory-chip-label';

	let conversationId = $derived(conversationsStore.activeConversation?.id ?? null);
	let saved = $derived(memoryReviewStore.saved.filter((s) => s.conversationId === conversationId));
	let busy = $state<string | null>(null);

	// Depends only on which chat is open; the store reads and writes its own
	// state inside, which must not re-trigger this effect.
	$effect(() => {
		const id = conversationId;
		untrack(() => void memoryReviewStore.chatOpened(id));
	});

	async function accept(s: MemorySuggestion) {
		busy = s.id;
		try {
			const r = await memoryReviewStore.accept(s);
			toast.success(r.op === 'forget' ? 'Forgotten' : r.op === 'update' ? 'Memory updated' : 'Remembered');
			// A saved suggestion gets the same Undo an automatic save has.
			if (conversationId) memoryReviewStore.saved = [...memoryReviewStore.saved, { conversationId, item: r }];
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save it');
		} finally {
			busy = null;
		}
	}

	async function dismiss(s: MemorySuggestion) {
		busy = s.id;
		try {
			await memoryReviewStore.dismiss(s);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not dismiss it');
		} finally {
			busy = null;
		}
	}
</script>

{#if memoryReviewStore.suggestions.length > 0 || saved.length > 0}
	<div class="mb-2 space-y-1.5">
		{#each memoryReviewStore.suggestions as s (s.id)}
			<div
				class="flex flex-wrap items-center gap-2 rounded-lg bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300"
			>
				<Brain class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1">
					{#if s.op === 'forget'}
						Forget: <span class="font-medium">{s.text}</span>?
					{:else if s.op === 'update'}
						Update memory: <span class="line-through opacity-60">{s.previousText}</span> →
						<span class="font-medium">{s.text}</span>
					{:else}
						Remember <span class="font-medium">{s.text}</span>?
					{/if}
					{#if s.op !== 'forget' && s.kind}
						<span class="ml-1 rounded bg-sky-500/15 px-1 opacity-80">{KIND_LABELS[s.kind] ?? s.kind}</span>
					{/if}
					{#if s.scope === 'project'}
						<span class="ml-1 inline-flex items-center gap-0.5 opacity-70"
							><FolderKanban class="h-3 w-3" /> project</span
						>
					{/if}
					{#if s.replaces?.length}
						<span class="block opacity-70">{suggestionLabel(s).merge}</span>
					{/if}
					{#if s.why && s.kind === 'guidance'}
						<span class="block opacity-70">Because: {s.why}</span>
					{/if}
					{#if s.quote}
						<span class="block italic opacity-70">From your message: “{s.quote}”</span>
					{/if}
				</span>
				<button
					class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sky-500/20"
					onclick={() => accept(s)}
					disabled={busy === s.id}
				>
					<Check class="h-3 w-3" /> {s.op === 'forget' ? 'Forget' : 'Save'}
				</button>
				<button
					class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 opacity-70 hover:bg-sky-500/20"
					onclick={() => dismiss(s)}
					disabled={busy === s.id}
					title="Don't suggest this again"
				>
					<X class="h-3 w-3" /> Dismiss
				</button>
			</div>
		{/each}

		{#each saved as entry (entry.item.memory.id)}
			<div
				class="flex flex-wrap items-center gap-2 rounded-lg bg-sky-500/10 px-3 py-1.5 text-xs text-sky-300"
			>
				<Brain class="h-3.5 w-3.5 shrink-0" />
				<span class="min-w-0 flex-1">
					{entry.item.op === 'forget' ? 'Forgot' : entry.item.op === 'update' ? 'Updated memory' : 'Remembered'}:
					<span class="font-medium">{entry.item.memory.text}</span>
					{#if entry.item.scope === 'project'}
						<span class="ml-1 opacity-70">(project)</span>
					{/if}
					{#if entry.item.removed?.length}
						<span class="ml-1 opacity-70">(merged {entry.item.removed.length} other{entry.item.removed.length === 1 ? '' : 's'})</span>
					{/if}
				</span>
				<button
					class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sky-500/20"
					onclick={() =>
						memoryReviewStore
							.undo(entry)
							.catch((e) => toast.error(e instanceof Error ? e.message : 'Could not undo'))}
				>
					<Undo2 class="h-3 w-3" /> Undo
				</button>
				<button
					class="rounded p-0.5 opacity-70 hover:bg-sky-500/20"
					onclick={() => memoryReviewStore.acknowledge(entry)}
					aria-label="Keep it and close"
				>
					<X class="h-3 w-3" />
				</button>
			</div>
		{/each}
	</div>
{/if}
