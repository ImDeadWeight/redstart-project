<script lang="ts">
	/**
	 * A memory the assistant just saved (chat-tooling Phase 3), with Undo.
	 * Rendered from memory_save's `[memory: <id>] <text>` result line. Every
	 * save is visible here by design: confirm-before-save was rejected, so
	 * seeing it and taking it back in one click is the control.
	 */
	import { Brain, Undo2, AlertTriangle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { MemoryService } from '$lib/services/memory.service';

	interface Props {
		id: string;
		text: string;
		fromWeb: boolean;
	}

	let { id, text, fromWeb }: Props = $props();
	let undone = $state(false);
	let busy = $state(false);

	async function undo() {
		busy = true;
		try {
			await MemoryService.remove(id);
			undone = true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not undo');
		} finally {
			busy = false;
		}
	}
</script>

<div class="my-1 inline-flex max-w-full flex-wrap items-center gap-2 rounded bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-400">
	<Brain class="h-3.5 w-3.5 flex-shrink-0" />
	<span class={undone ? 'line-through opacity-60' : ''}>Remembered: {text}</span>
	{#if fromWeb && !undone}
		<span class="inline-flex items-center gap-1 text-amber-500" title="Saved while the assistant was reading web content. Check it is something you actually said.">
			<AlertTriangle class="h-3 w-3" /> while reading the web
		</span>
	{/if}
	{#if undone}
		<span class="opacity-70">forgotten</span>
	{:else}
		<button onclick={undo} disabled={busy} class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-sky-500/20">
			<Undo2 class="h-3 w-3" /> Undo
		</button>
	{/if}
</div>
