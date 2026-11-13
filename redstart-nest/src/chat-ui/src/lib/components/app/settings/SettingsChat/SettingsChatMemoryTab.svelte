<script lang="ts">
	/**
	 * Settings → Memory (chat-tooling Phase 3): every fact the assistant has
	 * been asked to remember about this account, with edit and delete.
	 *
	 * This tab is half of the answer to persisted prompt injection (the other
	 * half is the chip with Undo on each save): nothing the assistant remembers
	 * is out of the user's sight. Memories saved while the assistant was reading
	 * web content carry a warning until the user edits (and so has read) them.
	 *
	 * Automatic memory (projects-plan Phase 3) lives here too: the mode (Off /
	 * Suggest / Automatic, Suggest by default) and every suggestion still
	 * waiting for Save or Dismiss, across all chats.
	 *
	 * By kind (agent-runtime D35, D42, 8.6): how the assistant should work
	 * (guidance, followed, with its reason), facts about the user, and where
	 * things stand (state, dated, marked when over 60 days old). Kind and why
	 * are editable.
	 */
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Trash2, Pencil, Check, X, AlertTriangle, Sparkles } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import {
		MemoryService,
		KIND_LABELS,
		MEMORY_KINDS,
		stateAge,
		type Memory,
		type MemoryKind,
		type MemorySuggestion,
		type AutoMemoryMode
	} from '$lib/services/memory.service';
	import { memoryReviewStore } from '$lib/stores/memory-review.svelte';

	const MODES: { value: AutoMemoryMode; label: string; help: string }[] = [
		{
			value: 'off',
			label: 'Off',
			help: 'Only remembers what you or the assistant explicitly ask it to.'
		},
		{
			value: 'suggest',
			label: 'Suggest',
			help: 'After a chat goes quiet, suggests things worth remembering. Nothing is saved until you choose Save.'
		},
		{
			value: 'auto',
			label: 'Automatic',
			help: 'Saves them straight away and shows each one in the chat with Undo.'
		}
	];

	let suggestions = $state<MemorySuggestion[]>([]);
	let savingMode = $state(false);

	async function loadAutomatic() {
		await memoryReviewStore.ensureSettings();
		try {
			suggestions = await MemoryService.suggestions();
		} catch {
			suggestions = [];
		}
	}
	void loadAutomatic();

	async function chooseMode(mode: AutoMemoryMode) {
		if (mode === memoryReviewStore.mode) return;
		savingMode = true;
		try {
			await memoryReviewStore.setMode(mode);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not change it');
		} finally {
			savingMode = false;
		}
	}

	async function acceptSuggestion(s: MemorySuggestion) {
		busyId = s.id;
		try {
			await MemoryService.acceptSuggestion(s.id);
			suggestions = suggestions.filter((x) => x.id !== s.id);
			memoryReviewStore.suggestions = memoryReviewStore.suggestions.filter((x) => x.id !== s.id);
			if (s.scope === 'user') await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save it');
			suggestions = suggestions.filter((x) => x.id !== s.id);
		} finally {
			busyId = null;
		}
	}

	async function dismissSuggestion(s: MemorySuggestion) {
		busyId = s.id;
		try {
			await MemoryService.dismissSuggestion(s.id);
			suggestions = suggestions.filter((x) => x.id !== s.id);
			memoryReviewStore.suggestions = memoryReviewStore.suggestions.filter((x) => x.id !== s.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not dismiss it');
		} finally {
			busyId = null;
		}
	}

	let memories = $state<Memory[]>([]);
	let loading = $state(true);
	let error = $state('');
	let editingId = $state<string | null>(null);
	let draft = $state('');
	let draftKind = $state<MemoryKind>('fact');
	let draftWhy = $state('');
	let busyId = $state<string | null>(null);

	const KIND_HELP: Record<MemoryKind, string> = {
		guidance: 'The assistant follows these, within the server\'s rules.',
		fact: 'Notes about you. The assistant treats them as information, never as instructions.',
		state: 'Where a piece of work stood on the date shown. Old ones may no longer be true.'
	};
	let grouped = $derived(
		MEMORY_KINDS.map((kind) => ({ kind, items: memories.filter((m) => (m.kind ?? 'fact') === kind) })).filter(
			(g) => g.items.length > 0
		)
	);

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
		draftKind = m.kind ?? 'fact';
		draftWhy = m.why ?? '';
	}

	async function saveEdit(id: string) {
		if (draftKind === 'guidance' && !draftWhy.trim()) {
			toast.error('Say why: the assistant uses the reason to judge when it applies.');
			return;
		}
		busyId = id;
		try {
			const updated = await MemoryService.update(id, draft, null, { kind: draftKind, why: draftWhy.trim() || null });
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
		What the assistant remembers about you, across all your chats. The ones that best match how a
		chat starts, then the newest, are included with it; it can search the rest.
		Remembering only works when an administrator has turned Memory on for your server, but you can
		always see and delete what is here. The server's administrator can read this on disk, as with
		your files.
	</p>

	{#if memoryReviewStore.settingsLoaded && memoryReviewStore.available}
		<section class="space-y-2 rounded-lg border border-border/50 p-3">
			<div class="flex items-center gap-1.5 text-sm font-medium">
				<Sparkles class="h-4 w-4" /> Automatic memory
			</div>
			<div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Automatic memory">
				{#each MODES as m (m.value)}
					<Button
						size="sm"
						variant={memoryReviewStore.mode === m.value ? 'default' : 'outline'}
						role="radio"
						aria-checked={memoryReviewStore.mode === m.value}
						disabled={savingMode}
						onclick={() => chooseMode(m.value)}
					>
						{m.label}
					</Button>
				{/each}
			</div>
			<p class="text-xs text-muted-foreground">
				{MODES.find((m) => m.value === memoryReviewStore.mode)?.help}
				It reads the chat, but never a web page, a file or a tool's result, and each suggestion has to
				quote something you typed. A suggestion to forget is never applied on its own.
			</p>

			{#if suggestions.length > 0}
				<div class="pt-1 text-xs font-medium text-muted-foreground">Waiting for you</div>
				<ul class="space-y-1">
					{#each suggestions as s (s.id)}
						<li class="flex items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent/30">
							<span class="flex-1">
								{#if s.op === 'forget'}
									Forget: {s.text}
								{:else if s.op === 'update'}
									<span class="line-through opacity-60">{s.previousText}</span> → {s.text}
								{:else}
									{s.text}
								{/if}
								{#if s.op !== 'forget' && s.kind}<span class="ml-1 text-xs text-muted-foreground"
										>({KIND_LABELS[s.kind] ?? s.kind})</span
									>{/if}
								{#if s.scope === 'project'}<span class="ml-1 text-xs text-muted-foreground"
										>(project)</span
									>{/if}
								{#if s.quote}<span class="block text-xs italic text-muted-foreground"
										>From your message: “{s.quote}”</span
									>{/if}
							</span>
							<Button
								size="sm"
								variant="outline"
								onclick={() => acceptSuggestion(s)}
								disabled={busyId === s.id}>{s.op === 'forget' ? 'Forget' : 'Save'}</Button
							>
							<Button
								size="sm"
								variant="ghost"
								onclick={() => dismissSuggestion(s)}
								disabled={busyId === s.id}
								aria-label="Dismiss"><X class="h-4 w-4" /></Button
							>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground"><Loader class="h-4 w-4 animate-spin" /> Loading…</div>
	{:else if error}
		<div class="text-sm text-destructive">{error}</div>
	{:else if memories.length === 0}
		<div class="text-sm text-muted-foreground italic">Nothing remembered yet.</div>
	{:else}
		{#each grouped as g (g.kind)}
		<section class="space-y-2">
			<div>
				<div class="text-sm font-medium">{KIND_LABELS[g.kind]}</div>
				<div class="text-xs text-muted-foreground">{KIND_HELP[g.kind]}</div>
			</div>
		<ul class="space-y-2">
			{#each g.items as m (m.id)}
				<li class="rounded-lg border border-border/50 p-3">
					{#if editingId === m.id}
						<div class="space-y-2">
							<div class="flex items-center gap-2">
								<Input bind:value={draft} maxlength={500} class="flex-1" />
								<Button size="sm" variant="outline" onclick={() => saveEdit(m.id)} disabled={busyId === m.id} aria-label="Save"><Check class="h-4 w-4" /></Button>
								<Button size="sm" variant="ghost" onclick={() => (editingId = null)} aria-label="Cancel"><X class="h-4 w-4" /></Button>
							</div>
							<div class="flex flex-wrap items-center gap-2 text-xs">
								<label class="flex items-center gap-1">
									Kind
									<select bind:value={draftKind} class="rounded border border-border bg-background px-1 py-0.5">
										{#each MEMORY_KINDS as k (k)}<option value={k}>{KIND_LABELS[k]}</option>{/each}
									</select>
								</label>
								<Input
									bind:value={draftWhy}
									maxlength={300}
									class="h-7 flex-1 text-xs"
									placeholder={draftKind === 'guidance' ? 'Why (required for how to work)' : 'Why (optional)'}
								/>
							</div>
						</div>
					{:else}
						<div class="flex items-start gap-2">
							<div class="flex-1">
								<div class="text-sm">{m.text}</div>
								{#if m.why}
									<div class="text-xs text-muted-foreground">Because: {m.why}</div>
								{/if}
								<div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
									{#if stateAge(m)}
										{@const age = stateAge(m)}
										<span>as of {age?.date}</span>
										{#if age?.stale}
											<span class="text-amber-500" title="Over 60 days old. The assistant is told it may no longer hold.">may be out of date</span>
										{/if}
									{:else}
										<span>{fmt(m.createdAt)}</span>
									{/if}
									{#if m.via === 'review'}
										<span title="Saved by automatic memory">automatic</span>
									{/if}
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
		</section>
		{/each}
	{/if}
</div>
