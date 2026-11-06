<script lang="ts">
	/**
	 * Settings → Memory (chat-tooling Phase 3): every fact the assistant has
	 * been asked to remember about this account, with edit and delete.
	 *
	 * This tab is half of the answer to persisted prompt injection (the other
	 * half is the chip with Undo on each save): nothing the assistant remembers
	 * is out of the user's sight. Memories saved while the assistant was reading
	 * web content carry a warning until the user edits (and so has read) them.
	 */
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Trash2, Pencil, Check, X, AlertTriangle } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { MemoryService, type Memory } from '$lib/services/memory.service';

	let memories = $state<Memory[]>([]);
	let loading = $state(true);
	let error = $state('');
	let editingId = $state<string | null>(null);
	let draft = $state('');
	let busyId = $state<string | null>(null);

	async function load() {
		loading = true;
		error = '';
		try {
			memories = await MemoryService.list();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load memories';
		} finally {
			loading = false;
		}
	}

	void load();

	function startEdit(m: Memory) {
		editingId = m.id;
		draft = m.text;
	}

	async function saveEdit(id: string) {
		busyId = id;
		try {
			const updated = await MemoryService.update(id, draft);
			memories = memories.map((m) => (m.id === id ? updated : m));
			editingId = null;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			busyId = null;
		}
	}

	async function remove(id: string) {
		busyId = id;
		try {
			await MemoryService.remove(id);
			memories = memories.filter((m) => m.id !== id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not forget it');
		} finally {
			busyId = null;
		}
	}

	const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
</script>

<div class="space-y-4">
	<p class="text-sm text-muted-foreground">
		What the assistant has been asked to remember about you, across all your chats. The newest are
		included with every conversation; it can search the rest. Remembering only works when an
		administrator has turned Memory on for your server, but you can always see and delete what is
		here. The server's administrator can read this on disk, as with your files.
	</p>

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground"><Loader class="h-4 w-4 animate-spin" /> Loading…</div>
	{:else if error}
		<div class="text-sm text-destructive">{error}</div>
	{:else if memories.length === 0}
		<div class="text-sm text-muted-foreground italic">Nothing remembered yet.</div>
	{:else}
		<ul class="space-y-2">
			{#each memories as m (m.id)}
				<li class="rounded-lg border border-border/50 p-3">
					{#if editingId === m.id}
						<div class="flex items-center gap-2">
							<Input bind:value={draft} maxlength={500} class="flex-1" />
							<Button size="sm" variant="outline" onclick={() => saveEdit(m.id)} disabled={busyId === m.id} aria-label="Save"><Check class="h-4 w-4" /></Button>
							<Button size="sm" variant="ghost" onclick={() => (editingId = null)} aria-label="Cancel"><X class="h-4 w-4" /></Button>
						</div>
					{:else}
						<div class="flex items-start gap-2">
							<div class="flex-1">
								<div class="text-sm">{m.text}</div>
								<div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
									<span>{fmt(m.createdAt)}</span>
									{#if m.fromWebTurn}
										<span class="inline-flex items-center gap-1 text-amber-500" title="Saved while the assistant was reading web content. Check it says something you actually told it.">
											<AlertTriangle class="h-3 w-3" /> saved while reading the web
										</span>
									{/if}
								</div>
							</div>
							<Button size="sm" variant="ghost" onclick={() => startEdit(m)} aria-label="Edit"><Pencil class="h-4 w-4" /></Button>
							<Button size="sm" variant="ghost" onclick={() => remove(m.id)} disabled={busyId === m.id} aria-label="Delete"><Trash2 class="h-4 w-4" /></Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
