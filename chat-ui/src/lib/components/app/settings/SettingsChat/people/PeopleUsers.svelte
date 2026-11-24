<script lang="ts">
	// Users: the list on the left, the chosen person on the right — their roles,
	// their groups, what that adds up to, and the account actions.
	import { apiFetch, apiPost } from '$lib/utils';
	import { authStore } from '$lib/stores/auth.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Plus, Search, Copy, Check, Crown, Users as UsersIcon } from '@lucide/svelte';
	import {
		roleName,
		CAPABILITY_LABELS,
		ADMIN_LABELS,
		type Account,
		type PeopleData,
		type RolePermissions
	} from './people';

	let { data, reload }: { data: PeopleData; reload: () => Promise<void> } = $props();

	const accounts = $derived(data.accounts ?? []);
	const groups = $derived(data.groups ?? []);

	let query = $state('');
	let selectedId = $state<string | null>(null);
	let creatingNew = $state(false);
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);

	const filtered = $derived(
		accounts
			.filter((a) => a.username.toLowerCase().includes(query.trim().toLowerCase()))
			.sort((a, b) =>
				a.tier === 'owner' ? -1 : b.tier === 'owner' ? 1 : a.username.localeCompare(b.username)
			)
	);
	const selected = $derived(accounts.find((a) => a.id === selectedId) ?? null);

	// --- The chosen account's draft -----------------------------------------
	let draftRoles = $state<string[]>([]);
	let draftGroups = $state<string[]>([]);
	let access = $state<{
		roles: { id: string; name: string; via: { id: string; name: string } | null }[];
		permissions: RolePermissions | null;
	} | null>(null);

	function select(a: Account) {
		selectedId = a.id;
		creatingNew = false;
		error = '';
		notice = '';
		resetting = false;
		confirmDelete = false;
		draftRoles = [...a.roleIds];
		draftGroups = groups.filter((g) => g.memberIds.includes(a.id)).map((g) => g.id);
		void loadAccess(a.id);
	}

	async function loadAccess(id: string) {
		access = null;
		try {
			access = await apiFetch(`/auth/accounts/${id}/access`, { authOnly: true });
		} catch {
			access = null;
		}
	}

	const dirty = $derived(
		!!selected &&
			(JSON.stringify([...draftRoles].sort()) !== JSON.stringify([...selected.roleIds].sort()) ||
				JSON.stringify([...draftGroups].sort()) !==
					JSON.stringify(
						groups
							.filter((g) => g.memberIds.includes(selected.id))
							.map((g) => g.id)
							.sort()
					))
	);

	function toggle(list: string[], id: string) {
		return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
	}

	async function saveAccess() {
		if (!selected) return;
		busy = true;
		error = '';
		notice = '';
		try {
			if (JSON.stringify([...draftRoles].sort()) !== JSON.stringify([...selected.roleIds].sort())) {
				const r = await apiFetch<{ apiKeyRevoked: boolean }>(
					`/auth/accounts/${selected.id}/roles`,
					{
						method: 'PUT',
						body: JSON.stringify({ roleIds: draftRoles })
					}
				);
				if (r.apiKeyRevoked) {
					notice = `These roles limit which apps ${selected.username} may connect from, so their account-wide API key was revoked. They can issue per-app keys under Connectors.`;
				}
			}
			// Group membership is saved on each group whose membership changed.
			for (const g of groups) {
				const was = g.memberIds.includes(selected.id);
				const now = draftGroups.includes(g.id);
				if (was === now) continue;
				await apiPost('/auth/groups', {
					...g,
					memberIds: now
						? [...g.memberIds, selected.id]
						: g.memberIds.filter((m) => m !== selected.id)
				});
			}
			const id = selected.id;
			await reload();
			const fresh = data.accounts?.find((a) => a.id === id);
			if (fresh) select(fresh);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save';
		} finally {
			busy = false;
		}
	}

	// --- Account actions ------------------------------------------------------
	let revealed = $state<{ username: string; apiKey: string } | null>(null);
	let copied = $state(false);
	let resetting = $state(false);
	let newPasswordValue = $state('');
	let confirmDelete = $state(false);

	function copyKey(key: string) {
		navigator.clipboard.writeText(key);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function act(fn: () => Promise<void>) {
		busy = true;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed';
		} finally {
			busy = false;
		}
	}

	const resetPassword = () =>
		act(async () => {
			if (!selected || !newPasswordValue) return;
			await apiPost(`/auth/accounts/${selected.id}/reset-password`, { password: newPasswordValue });
			resetting = false;
			newPasswordValue = '';
			notice = `Password changed. ${selected.username} has been signed out everywhere.`;
		});

	const regenerateKey = () =>
		act(async () => {
			if (!selected) return;
			const r = await apiPost<{ apiKey: string }>(
				`/auth/accounts/${selected.id}/regenerate-key`,
				{}
			);
			revealed = { username: selected.username, apiKey: r.apiKey };
			await reload();
		});

	const deleteAccount = () =>
		act(async () => {
			if (!selected) return;
			await apiFetch(`/auth/accounts/${selected.id}`, { method: 'DELETE', authOnly: true });
			selectedId = null;
			confirmDelete = false;
			await reload();
		});

	// --- New user -------------------------------------------------------------
	let newUsername = $state('');
	let newPassword = $state('');
	let newRoles = $state<string[]>(['full-access']);

	function startNew() {
		creatingNew = true;
		selectedId = null;
		error = '';
		notice = '';
		newUsername = '';
		newPassword = '';
		newRoles = ['full-access'];
	}

	const createUser = () =>
		act(async () => {
			const username = newUsername.trim();
			if (!username || !newPassword) return;
			const r = await apiPost<{ account: Account; apiKey: string }>('/auth/accounts', {
				username,
				password: newPassword,
				roleIds: newRoles
			});
			revealed = { username: r.account.username, apiKey: r.apiKey };
			creatingNew = false;
			await reload();
			const fresh = data.accounts?.find((a) => a.id === r.account.id);
			if (fresh) select(fresh);
		});

	// --- The access summary -----------------------------------------------------
	function capsLine(p: RolePermissions | null): string {
		if (!p) return '';
		if (p.capabilities === undefined || p.capabilities === null)
			return 'Every capability the profile has on';
		return p.capabilities.length
			? p.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(', ')
			: 'No local capabilities';
	}
	function adminLine(p: RolePermissions | null): string {
		const held = Object.entries(p?.admin ?? {})
			.filter(([, v]) => v)
			.map(([k]) => ADMIN_LABELS[k] ?? k);
		return held.length ? held.join(', ') : 'None';
	}
</script>

{#if revealed}
	<div class="mt-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-3">
		<p class="text-sm font-medium">
			API key for <span class="font-mono">{revealed.username}</span>. Copy it now; it won't be shown
			again:
		</p>
		<div class="flex gap-2">
			<code class="flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs"
				>{revealed.apiKey}</code
			>
			<Button
				size="sm"
				variant="outline"
				onclick={() => copyKey(revealed!.apiKey)}
				aria-label="Copy the key"
			>
				{#if copied}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
			</Button>
		</div>
		<Button size="sm" variant="ghost" onclick={() => (revealed = null)}>Dismiss</Button>
	</div>
{/if}

<div class="mt-4 grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
	<!-- List -->
	<div class="space-y-2">
		<div class="flex gap-1.5">
			<label class="relative flex-1">
				<Search
					class="pointer-events-none absolute top-1/2 left-2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					bind:value={query}
					placeholder="Find a person"
					class="h-8 pl-7 text-sm"
					aria-label="Find a person"
				/>
			</label>
			<Button size="sm" variant="outline" onclick={startNew} aria-label="New user" title="New user">
				<Plus class="h-3.5 w-3.5" />
			</Button>
		</div>
		<ul class="max-h-[28rem] space-y-0.5 overflow-y-auto">
			{#each filtered as a (a.id)}
				<li>
					<button
						type="button"
						onclick={() => select(a)}
						aria-current={selectedId === a.id ? 'true' : undefined}
						class="w-full rounded-md px-2 py-1.5 text-left transition-colors {selectedId === a.id
							? 'bg-muted'
							: 'hover:bg-muted/50'}"
					>
						<span class="flex items-center gap-1.5 text-sm font-medium">
							{#if a.tier === 'owner'}<Crown class="h-3.5 w-3.5 text-amber-500" />{/if}
							<span class="truncate">{a.username}</span>
							{#if a.id === authStore.user?.id}<span
									class="text-xs font-normal text-muted-foreground">you</span
								>{/if}
						</span>
						<span class="block truncate text-xs text-muted-foreground">
							{a.tier === 'owner'
								? 'Owner'
								: a.roleIds.map((id) => roleName(data.roles, id)).join(', ') || 'No roles'}
							{#if a.groupIds.length}
								· {a.groupIds.length} group{a.groupIds.length === 1 ? '' : 's'}{/if}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>

	<!-- Detail -->
	<div class="min-w-0 rounded-md border border-border/50 p-4">
		{#if error}<p class="mb-3 text-sm text-destructive">{error}</p>{/if}
		{#if notice}<p class="mb-3 text-sm text-amber-600 dark:text-amber-500">{notice}</p>{/if}

		{#if creatingNew}
			<h4 class="mb-3 text-sm font-medium">New user</h4>
			<div class="space-y-3">
				<div class="flex flex-wrap gap-2">
					<Input
						placeholder="Username"
						bind:value={newUsername}
						class="max-w-48"
						aria-label="Username"
					/>
					<Input
						type="password"
						placeholder="Password"
						bind:value={newPassword}
						class="max-w-48"
						aria-label="Password"
					/>
				</div>
				<fieldset class="space-y-1">
					<legend class="text-xs font-medium text-muted-foreground">Roles</legend>
					{#each data.roles as r (r.id)}
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={newRoles.includes(r.id)}
								onchange={() => (newRoles = toggle(newRoles, r.id))}
							/>
							{r.name}
						</label>
					{/each}
				</fieldset>
				<p class="text-xs text-muted-foreground">
					You can give only less access than you have yourself.
				</p>
				<div class="flex gap-2">
					<Button onclick={createUser} disabled={busy || !newUsername.trim() || !newPassword}>
						{#if busy}<Loader class="h-3.5 w-3.5 animate-spin" />{/if} Create user
					</Button>
					<Button variant="ghost" onclick={() => (creatingNew = false)}>Cancel</Button>
				</div>
			</div>
		{:else if selected}
			<div class="mb-4 flex items-start justify-between gap-2">
				<div>
					<h4 class="flex items-center gap-1.5 text-base font-semibold">
						{#if selected.tier === 'owner'}<Crown class="h-4 w-4 text-amber-500" />{/if}
						{selected.username}
					</h4>
					<p class="text-xs text-muted-foreground">
						{selected.tier === 'owner' ? 'Owner' : selected.isAdmin ? 'Administrator' : 'Member'}
						· joined {new Date(selected.createdAt).toLocaleDateString()}
						{#if selected.lastLoginAt}· last signed in {new Date(
								selected.lastLoginAt
							).toLocaleDateString()}{/if}
						{#if selected.apiKeyPrefix}· key {selected.apiKeyPrefix}…{/if}
					</p>
				</div>
			</div>

			{#if selected.tier === 'owner'}
				<p class="text-sm text-muted-foreground">
					The owner can do everything and cannot be given roles. Only the owner manages
					administrators. To recover it, re-run setup from the Nest launcher.
				</p>
			{:else}
				{#if !selected.canEdit}
					<p class="mb-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
						{selected.username} has as much access as you, or more, so you can see their access but not
						change it.
					</p>
				{/if}

				<div class="grid gap-4 sm:grid-cols-2">
					<fieldset class="space-y-1" disabled={!selected.canEdit}>
						<legend class="mb-1 text-xs font-medium text-muted-foreground">Roles</legend>
						{#each data.roles as r (r.id)}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={draftRoles.includes(r.id)}
									onchange={() => (draftRoles = toggle(draftRoles, r.id))}
								/>
								{r.name}
							</label>
						{/each}
					</fieldset>
					<fieldset class="space-y-1" disabled={!selected.canEdit}>
						<legend class="mb-1 text-xs font-medium text-muted-foreground">Groups</legend>
						{#each groups as g (g.id)}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={draftGroups.includes(g.id)}
									onchange={() => (draftGroups = toggle(draftGroups, g.id))}
								/>
								{g.name}
								{#if g.roleIds.length}<span class="truncate text-xs text-muted-foreground"
										>({g.roleIds.map((id) => roleName(data.roles, id)).join(', ')})</span
									>{/if}
							</label>
						{:else}
							<p class="text-xs text-muted-foreground">No groups yet.</p>
						{/each}
					</fieldset>
				</div>

				{#if selected.canEdit}
					<div class="mt-3 flex gap-2">
						<Button size="sm" onclick={saveAccess} disabled={busy || !dirty}>
							{#if busy}<Loader class="h-3.5 w-3.5 animate-spin" />{/if} Save access
						</Button>
						{#if dirty}<Button size="sm" variant="ghost" onclick={() => select(selected)}
								>Undo</Button
							>{/if}
					</div>
				{/if}

				<!-- What it adds up to -->
				<div class="mt-5 space-y-1.5 rounded-md bg-muted/40 px-3 py-2.5 text-xs">
					<p class="font-medium text-foreground">
						What {selected.username} can do{dirty ? ' (before your unsaved changes)' : ''}
					</p>
					{#if access?.permissions}
						<p>
							<span class="text-muted-foreground">Capabilities:</span>
							{capsLine(access.permissions)}
						</p>
						<p>
							<span class="text-muted-foreground">Administration:</span>
							{adminLine(access.permissions)}
						</p>
						<p class="text-muted-foreground">From:</p>
						<ul class="space-y-0.5">
							{#each access.roles as r (r.id + (r.via?.id ?? ''))}
								<li class="flex items-center gap-1">
									<span class="text-foreground">{r.name}</span>
									{#if r.via}
										<span class="flex items-center gap-1 text-muted-foreground">
											{'·'} through <UsersIcon class="h-3 w-3" />
											{r.via.name}
										</span>
									{/if}
								</li>
							{:else}
								<li class="text-muted-foreground">No roles: plain chat only.</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground">Loading…</p>
					{/if}
				</div>

				{#if selected.canEdit}
					<div class="mt-5 flex flex-wrap gap-2 border-t border-border/50 pt-4">
						{#if resetting}
							<Input
								type="password"
								placeholder="New password"
								bind:value={newPasswordValue}
								class="h-8 max-w-48"
								aria-label="New password"
							/>
							<Button size="sm" onclick={resetPassword} disabled={busy || !newPasswordValue}
								>Set password</Button
							>
							<Button size="sm" variant="ghost" onclick={() => (resetting = false)}>Cancel</Button>
						{:else}
							<Button size="sm" variant="outline" onclick={() => (resetting = true)}
								>Reset password</Button
							>
							<Button size="sm" variant="outline" onclick={regenerateKey} disabled={busy}
								>New API key</Button
							>
							{#if confirmDelete}
								<Button size="sm" variant="destructive" onclick={deleteAccount} disabled={busy}
									>Delete {selected.username}</Button
								>
								<Button size="sm" variant="ghost" onclick={() => (confirmDelete = false)}
									>Cancel</Button
								>
								<p class="w-full text-xs text-muted-foreground">
									Projects {selected.username} owns become yours, shared as they are now.
								</p>
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
				{/if}
			{/if}
		{:else}
			<p class="text-sm text-muted-foreground">
				Choose someone to see and change their access, or add a new user.
			</p>
		{/if}
	</div>
</div>
