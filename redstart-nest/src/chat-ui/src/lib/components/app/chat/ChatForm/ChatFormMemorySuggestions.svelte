<script lang="ts">
	/**
	 * Above the composer: what automatic memory (projects-plan Phase 3) found
	 * in this chat.
	 *
	 *  - Suggest mode: "Remember …?" with Save and Dismiss. Dismiss is for
	 *    good: the review won't propose that text again.
	 *  - Automatic mode: "Remembered …" with Undo (an update gets its old text
	 *    back), and a close button that keeps it.
	 *
	 * Also tells memoryReviewStore which chat is open, which is what reviews a
	 * chat the user has just left and loads this one's pending suggestions.
	 */
	import { Brain, Check, X, Undo2, FolderKanban } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { untrack } from 'svelte';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { memoryReviewStore } from '$lib/stores/memory-review.svelte';
	import type { MemorySuggestion } from '$lib/services/memory.service';

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
			toast.success(r.op === 'update' ? 'Memory updated' : 'Remembered');
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
					{#if s.op === 'update'}
						Update memory: <span class="line-through opacity-60">{s.previousText}</span> →
						<span class="font-medium">{s.text}</span>
					{:else}
						Remember <span class="font-medium">{s.text}</span>?
					{/if}
					{#if s.scope === 'project'}
						<span class="ml-1 inline-flex items-center gap-0.5 opacity-70"
							><FolderKanban class="h-3 w-3" /> project</span
						>
					{/if}
				</span>
				<button
					class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sky-500/20"
					onclick={() => accept(s)}
					disabled={busy === s.id}
				>
					<Check class="h-3 w-3" /> Save
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
					{entry.item.op === 'update' ? 'Updated memory' : 'Remembered'}:
					<span class="font-medium">{entry.item.memory.text}</span>
					{#if entry.item.scope === 'project'}
						<span class="ml-1 opacity-70">(project)</span>
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
