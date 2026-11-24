<script lang="ts">
	// Groups: give several people the same roles at once. Groups are also what a
	// project can be shared with.
	import { apiFetch, apiPost } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Plus, Search, Users as UsersIcon } from '@lucide/svelte';
	import { roleName, summarizeRole, type Group, type PeopleData } from './people';

	let { data, reload }: { data: PeopleData; reload: () => Promise<void> } = $props();

	const groups = $derived(data.groups ?? []);
	const accounts = $derived(data.accounts ?? []);

	let selectedId = $state<string | null>(null);
	let draft = $state<Group | null>(null);
	let memberQuery = $state('');
	let error = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);

	function open(g: Group) {
		selectedId = g.id;
		draft = structuredClone($state.snapshot(g));
		error = '';
		confirmDelete = false;
	}

	function startNew() {
		selectedId = null;
		draft = { id: '', name: '', description: '', memberIds: [], roleIds: [] };
		error = '';
		confirmDelete = false;
	}

	function toggle(list: string[], id: string) {
		return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
	}

	const memberChoices = $derived(
		accounts
			.filter((a) => a.username.toLowerCase().includes(memberQuery.trim().toLowerCase()))
			.sort((a, b) => a.username.localeCompare(b.username))
	);

	async function save() {
		if (!draft?.name.trim()) return;
		busy = true;
		error = '';
		try {
			const r = await apiPost<{ group: Group }>('/auth/groups', {
				id: draft.id || undefined,
				name: draft.name,
				description: draft.description,
				memberIds: draft.memberIds,
				roleIds: draft.roleIds
			});
			await reload();
			const fresh = data.groups?.find((g) => g.id === r.group.id);
			if (fresh) open(fresh);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save the group';
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!draft?.id) return;
		busy = true;
		error = '';
		try {
			await apiFetch(`/auth/groups/${draft.id}`, { method: 'DELETE', authOnly: true });
			draft = null;
			selectedId = null;
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete the group';
		} finally {
			busy = false;
		}
	}
</script>

<div class="mt-4 grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
	<div class="space-y-2">
		<Button size="sm" variant="outline" class="w-full" onclick={startNew}>
			<Plus class="h-3.5 w-3.5" /> New group
		</Button>
		<ul class="max-h-[28rem] space-y-0.5 overflow-y-auto">
			{#each groups as g (g.id)}
				<li>
					<button
						type="button"
						onclick={() => open(g)}
						aria-current={selectedId === g.id ? 'true' : undefined}
						class="w-full rounded-md px-2 py-1.5 text-left transition-colors {selectedId === g.id
							? 'bg-muted'
							: 'hover:bg-muted/50'}"
					>
						<span class="flex items-center gap-1.5 text-sm font-medium">
							<UsersIcon class="h-3.5 w-3.5 text-muted-foreground" />
							<span class="truncate">{g.name}</span>
						</span>
						<span class="block truncate text-xs text-muted-foreground">
							{g.memberIds.length} member{g.memberIds.length === 1 ? '' : 's'}
							{#if g.roleIds.length}· {g.roleIds
									.map((id) => roleName(data.roles, id))
									.join(', ')}{/if}
						</span>
					</button>
				</li>
			{:else}
				<li class="px-2 text-xs text-muted-foreground">No groups yet.</li>
			{/each}
		</ul>
	</div>

	<div class="min-w-0 rounded-md border border-border/50 p-4">
		{#if error}<p class="mb-3 text-sm text-destructive">{error}</p>{/if}
		{#if draft}
			<div class="space-y-4">
				<div class="flex flex-wrap gap-2">
					<Input
						placeholder="Group name"
						bind:value={draft.name}
						class="max-w-56"
						aria-label="Group name"
					/>
					<Input
						placeholder="Description (optional)"
						bind:value={draft.description}
						class="flex-1"
						aria-label="Description"
					/>
				</div>

				<fieldset class="space-y-1">
					<legend class="mb-1 text-xs font-medium text-muted-foreground"
						>Roles everyone in this group gets</legend
					>
					{#each data.roles as r (r.id)}
						<label class="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								class="mt-1"
								checked={draft.roleIds.includes(r.id)}
								onchange={() => draft && (draft.roleIds = toggle(draft.roleIds, r.id))}
							/>
							<span>
								{r.name}
								<span class="block text-xs text-muted-foreground">{summarizeRole(r)}</span>
							</span>
						</label>
					{/each}
				</fieldset>

				<fieldset class="space-y-1.5">
					<legend class="mb-1 text-xs font-medium text-muted-foreground">
						Members ({draft.memberIds.length})
					</legend>
					<label class="relative block max-w-64">
						<Search
							class="pointer-events-none absolute top-1/2 left-2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							bind:value={memberQuery}
							placeholder="Find a person"
							class="h-8 pl-7 text-sm"
							aria-label="Find a person"
						/>
					</label>
					<div class="grid max-h-56 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-2">
						{#each memberChoices as a (a.id)}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={draft.memberIds.includes(a.id)}
									onchange={() => draft && (draft.memberIds = toggle(draft.memberIds, a.id))}
								/>
								<span class="truncate">{a.username}</span>
								{#if a.tier === 'owner'}<span class="text-xs text-muted-foreground">owner</span
									>{/if}
							</label>
						{/each}
					</div>
					<p class="text-xs text-muted-foreground">
						The owner can be in a group, for shared projects; roles don't change what the owner can
						do.
					</p>
				</fieldset>

				<div class="flex flex-wrap gap-2 border-t border-border/50 pt-4">
					<Button size="sm" onclick={save} disabled={busy || !draft.name.trim()}>
						{#if busy}<Loader class="h-3.5 w-3.5 animate-spin" />{/if}
						{draft.id ? 'Save group' : 'Create group'}
					</Button>
					{#if draft.id}
						{#if confirmDelete}
							<Button size="sm" variant="destructive" onclick={remove} disabled={busy}
								>Delete {draft.name}</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (confirmDelete = false)}
								>Cancel</Button
							>
						{:else}
							<Button
								size="sm"
								variant="ghost"
								class="text-destructive"
								onclick={() => (confirmDelete = true)}>Delete…</Button
							>
						{/if}
					{/if}
				</div>
			</div>
		{:else}
			<p class="text-sm text-muted-foreground">
				A group gives everyone in it the same roles. Choose one, or make a new group.
			</p>
		{/if}
	</div>
</div>
