<script lang="ts">
	// Roles: what each one GIVES (roles add up — 2026-11-24). The editor reads
	// as a list of things to allow; anything not allowed here can still come
	// from another of the person's roles, and nothing here can reach past what
	// the running profile has switched on.
	import { apiFetch, apiPost } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Plus, Copy, ShieldCheck, Users as UsersIcon } from '@lucide/svelte';
	import {
		summarizeRole,
		CAPABILITY_LABELS,
		GRANT_LABELS,
		GRANT_HOLDER,
		ADMIN_LABELS,
		type PeopleData,
		type Role,
		type RolePermissions
	} from './people';

	let { data, reload }: { data: PeopleData; reload: () => Promise<void> } = $props();

	const vocab = $derived(data.vocab);
	const canEdit = $derived(vocab.canEditRoles);

	let selectedId = $state<string | null>(null);
	let draft = $state<Role | null>(null);
	let readOnly = $state(false);
	let error = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);

	function open(r: Role) {
		selectedId = r.id;
		draft = structuredClone($state.snapshot(r));
		readOnly = !!r.builtIn || !canEdit;
		error = '';
		confirmDelete = false;
	}

	function blank(): Role {
		// A new role gives nothing until something is ticked: roles add up, so an
		// empty role is harmless, and a role that silently gave everything would
		// not be.
		return {
			id: '',
			name: '',
			description: '',
			permissions: { capabilities: [], webSourceIds: [], fileSystem: {}, admin: {} }
		};
	}

	function startNew() {
		selectedId = null;
		draft = blank();
		readOnly = false;
		error = '';
	}

	function cloneOf(r: Role) {
		selectedId = null;
		draft = {
			...structuredClone($state.snapshot(r)),
			id: '',
			name: `${r.name} copy`,
			builtIn: false
		};
		readOnly = false;
		error = '';
	}

	// Who holds the role, directly or through a group.
	const holders = $derived.by(() => {
		if (!draft?.id) return { people: [] as string[], groups: [] as string[] };
		const id = draft.id;
		return {
			people: (data.accounts ?? []).filter((a) => a.roleIds.includes(id)).map((a) => a.username),
			groups: (data.groups ?? []).filter((g) => g.roleIds.includes(id)).map((g) => g.name)
		};
	});

	// --- "All" or "only these" lists ----------------------------------------------
	type ListField = 'capabilities' | 'webSourceIds' | 'surfaces';
	function mode(p: RolePermissions, field: ListField): 'all' | 'some' {
		return p[field] === null || (field === 'surfaces' && p[field] === undefined) ? 'all' : 'some';
	}
	function setMode(field: ListField, m: 'all' | 'some') {
		if (!draft) return;
		draft.permissions[field] = m === 'all' ? null : [];
	}
	function toggleIn(field: ListField, value: string) {
		if (!draft) return;
		const list = draft.permissions[field];
		const current = Array.isArray(list) ? list : [];
		draft.permissions[field] = current.includes(value)
			? current.filter((v) => v !== value)
			: [...current, value];
	}

	function holdsCapability(p: RolePermissions, cap: string) {
		return p.capabilities === null || (p.capabilities ?? []).includes(cap);
	}

	function grantMode(cap: string): 'all' | 'some' {
		return Array.isArray(draft?.permissions.grants?.[cap]) ? 'some' : 'all';
	}
	function setGrantMode(cap: string, m: 'all' | 'some') {
		if (!draft) return;
		const grants = { ...(draft.permissions.grants ?? {}) };
		if (m === 'some') grants[cap] = [];
		else delete grants[cap];
		draft.permissions.grants = grants;
	}
	function toggleGrant(cap: string, folder: string) {
		if (!draft) return;
		const list = draft.permissions.grants?.[cap];
		const current = Array.isArray(list) ? list : [];
		draft.permissions.grants = {
			...(draft.permissions.grants ?? {}),
			[cap]: current.includes(folder) ? current.filter((f) => f !== folder) : [...current, folder]
		};
	}
	function folderChoices(cap: string): string[] {
		const chosen = draft?.permissions.grants?.[cap];
		return [
			...new Set([...(vocab.grantFolders[cap] ?? []), ...(Array.isArray(chosen) ? chosen : [])])
		].sort();
	}

	async function save() {
		if (!draft?.name.trim()) return;
		busy = true;
		error = '';
		try {
			const r = await apiPost<{ role: Role }>('/auth/roles', {
				id: draft.id || undefined,
				name: draft.name,
				description: draft.description,
				permissions: $state.snapshot(draft.permissions)
			});
			await reload();
			const fresh = data.roles.find((x) => x.id === r.role.id);
			if (fresh) open(fresh);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save the role';
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!draft?.id) return;
		busy = true;
		error = '';
		try {
			await apiFetch(`/auth/roles/${draft.id}`, { method: 'DELETE', authOnly: true });
			draft = null;
			selectedId = null;
			await reload();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete the role';
		} finally {
			busy = false;
		}
	}
</script>

<div class="mt-4 grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
	<div class="space-y-2">
		{#if canEdit}
			<Button size="sm" variant="outline" class="w-full" onclick={startNew}>
				<Plus class="h-3.5 w-3.5" /> New role
			</Button>
		{/if}
		<ul class="max-h-[28rem] space-y-0.5 overflow-y-auto">
			{#each data.roles as r (r.id)}
				<li>
					<button
						type="button"
						onclick={() => open(r)}
						aria-current={selectedId === r.id ? 'true' : undefined}
						class="w-full rounded-md px-2 py-1.5 text-left transition-colors {selectedId === r.id
							? 'bg-muted'
							: 'hover:bg-muted/50'}"
					>
						<span class="flex items-center gap-1.5 text-sm font-medium">
							<ShieldCheck class="h-3.5 w-3.5 text-muted-foreground" />
							<span class="truncate">{r.name}</span>
							{#if r.builtIn}<span class="text-xs font-normal text-muted-foreground">built-in</span
								>{/if}
						</span>
						<span class="line-clamp-2 text-xs text-muted-foreground">{summarizeRole(r)}</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>

	<div class="min-w-0 rounded-md border border-border/50 p-4">
		{#if error}<p class="mb-3 text-sm text-destructive">{error}</p>{/if}
		{#if draft}
			{@const p = draft.permissions}
			<fieldset class="space-y-5" disabled={readOnly}>
				<div class="space-y-2">
					<div class="flex flex-wrap gap-2">
						<Input
							placeholder="Role name"
							bind:value={draft.name}
							class="max-w-56"
							aria-label="Role name"
						/>
						<Input
							placeholder="Description (optional)"
							bind:value={draft.description}
							class="flex-1"
							aria-label="Description"
						/>
					</div>
					{#if draft.builtIn}
						<p class="text-xs text-muted-foreground">
							Built-in roles can't be changed. Clone one to make your own.
						</p>
					{/if}
				</div>

				<!-- Capabilities -->
				<section class="space-y-1.5">
					<h5 class="text-sm font-medium">Local capabilities</h5>
					<div class="flex gap-4 text-sm">
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="caps"
								checked={mode(p, 'capabilities') === 'all'}
								onchange={() => setMode('capabilities', 'all')}
							/> All of them</label
						>
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="caps"
								checked={mode(p, 'capabilities') === 'some'}
								onchange={() => setMode('capabilities', 'some')}
							/> Only these</label
						>
					</div>
					{#if mode(p, 'capabilities') === 'some'}
						<div class="grid gap-x-4 gap-y-1 pl-1 sm:grid-cols-3">
							{#each vocab.capabilityIds as id (id)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={(p.capabilities ?? []).includes(id)}
										onchange={() => toggleIn('capabilities', id)}
									/>
									{CAPABILITY_LABELS[id] ?? id}
								</label>
							{/each}
						</div>
					{/if}
				</section>

				<!-- Folders of shared capabilities this role holds -->
				{#each vocab.grantable.filter( (cap) => holdsCapability(p, GRANT_HOLDER[cap] ?? cap) ) as cap (cap)}
					<section class="space-y-1.5">
						<h5 class="text-sm font-medium">{GRANT_LABELS[cap] ?? cap}: which folders</h5>
						<div class="flex gap-4 text-sm">
							<label class="flex items-center gap-1.5"
								><input
									type="radio"
									name="g-{cap}"
									checked={grantMode(cap) === 'all'}
									onchange={() => setGrantMode(cap, 'all')}
								/> Every folder</label
							>
							<label class="flex items-center gap-1.5"
								><input
									type="radio"
									name="g-{cap}"
									checked={grantMode(cap) === 'some'}
									onchange={() => setGrantMode(cap, 'some')}
								/> Only these</label
							>
						</div>
						{#if grantMode(cap) === 'some'}
							<div class="flex flex-wrap gap-x-4 gap-y-1 pl-1">
								{#each folderChoices(cap) as folder (folder)}
									<label class="flex items-center gap-1.5 text-sm">
										<input
											type="checkbox"
											checked={(p.grants?.[cap] ?? []).includes(folder)}
											onchange={() => toggleGrant(cap, folder)}
										/>
										{folder}
									</label>
								{:else}
									<p class="text-xs text-muted-foreground">No folders there yet.</p>
								{/each}
							</div>
						{/if}
					</section>
				{/each}

				<!-- Web -->
				<section class="space-y-1.5">
					<h5 class="text-sm font-medium">Web sources</h5>
					<div class="flex gap-4 text-sm">
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="web"
								checked={mode(p, 'webSourceIds') === 'all'}
								onchange={() => setMode('webSourceIds', 'all')}
							/> All of them</label
						>
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="web"
								checked={mode(p, 'webSourceIds') === 'some'}
								onchange={() => setMode('webSourceIds', 'some')}
							/> Only these</label
						>
					</div>
					{#if mode(p, 'webSourceIds') === 'some'}
						<div class="grid gap-x-4 gap-y-1 pl-1 sm:grid-cols-3">
							{#each vocab.webSources as s (s.id)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={(p.webSourceIds ?? []).includes(s.id)}
										onchange={() => toggleIn('webSourceIds', s.id)}
									/>
									{s.name}
								</label>
							{/each}
						</div>
					{/if}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={p.allowWebSearchEngine === true}
							onchange={(e) =>
								draft && (draft.permissions.allowWebSearchEngine = e.currentTarget.checked)}
						/>
						The general web search engine (SearXNG or Brave), when the profile has one
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={p.allowWhitelistBypass === true}
							onchange={(e) =>
								draft && (draft.permissions.allowWhitelistBypass = e.currentTarget.checked)}
						/>
						Any public web page, when the profile's URL whitelist is off
					</label>
				</section>

				<!-- File system -->
				<section class="space-y-1.5">
					<h5 class="text-sm font-medium">Files</h5>
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={p.fileSystem?.allowWrite === true}
							onchange={(e) =>
								draft &&
								(draft.permissions.fileSystem = {
									...(draft.permissions.fileSystem ?? {}),
									allowWrite: e.currentTarget.checked
								})}
						/>
						Write and edit files
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={p.fileSystem?.allowDestructive === true}
							onchange={(e) =>
								draft &&
								(draft.permissions.fileSystem = {
									...(draft.permissions.fileSystem ?? {}),
									allowDestructive: e.currentTarget.checked
								})}
						/>
						Delete files
					</label>
				</section>

				<!-- Apps -->
				<section class="space-y-1.5">
					<h5 class="text-sm font-medium">Apps it may connect from</h5>
					<div class="flex gap-4 text-sm">
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="apps"
								checked={mode(p, 'surfaces') === 'all'}
								onchange={() => setMode('surfaces', 'all')}
							/> Any app</label
						>
						<label class="flex items-center gap-1.5"
							><input
								type="radio"
								name="apps"
								checked={mode(p, 'surfaces') === 'some'}
								onchange={() => setMode('surfaces', 'some')}
							/> Only these</label
						>
					</div>
					{#if mode(p, 'surfaces') === 'some'}
						<div class="flex flex-wrap gap-x-4 gap-y-1 pl-1">
							{#each vocab.surfaces as s (s)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={(p.surfaces ?? []).includes(s)}
										onchange={() => toggleIn('surfaces', s)}
									/>
									{s}
								</label>
							{/each}
						</div>
						<p class="text-xs text-muted-foreground">
							A limit, not a grant: it applies only when all of a person's roles limit apps. People
							limited this way can't hold an account-wide API key; they use per-app keys.
						</p>
					{/if}
				</section>

				<!-- Administration -->
				<section class="space-y-1.5">
					<h5 class="text-sm font-medium">Administration</h5>
					<div class="grid gap-x-4 gap-y-1 sm:grid-cols-2">
						{#each vocab.adminPermissions as perm (perm)}
							<label class="flex items-center gap-1.5 text-sm">
								<input
									type="checkbox"
									checked={p.admin?.[perm] === true}
									onchange={(e) =>
										draft &&
										(draft.permissions.admin = {
											...(draft.permissions.admin ?? {}),
											[perm]: e.currentTarget.checked
										})}
								/>
								{ADMIN_LABELS[perm] ?? perm}
							</label>
						{/each}
					</div>
				</section>
			</fieldset>

			{#if draft.id}
				<p class="mt-5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
					<UsersIcon class="h-3 w-3" />
					{#if holders.people.length || holders.groups.length}
						Held by {[...holders.people, ...holders.groups.map((g) => `everyone in ${g}`)].join(
							', '
						)}.
					{:else}
						Nobody holds this role yet.
					{/if}
				</p>
			{/if}

			<div class="mt-4 flex flex-wrap gap-2 border-t border-border/50 pt-4">
				{#if !readOnly}
					<Button size="sm" onclick={save} disabled={busy || !draft.name.trim()}>
						{#if busy}<Loader class="h-3.5 w-3.5 animate-spin" />{/if}
						{draft.id ? 'Save role' : 'Create role'}
					</Button>
				{/if}
				{#if canEdit && draft.id}
					<Button size="sm" variant="outline" onclick={() => draft && cloneOf(draft)}
						><Copy class="h-3.5 w-3.5" /> Clone</Button
					>
				{/if}
				{#if canEdit && draft.id && !draft.builtIn}
					{#if confirmDelete}
						<Button size="sm" variant="destructive" onclick={remove} disabled={busy}
							>Delete {draft.name}</Button
						>
						<Button size="sm" variant="ghost" onclick={() => (confirmDelete = false)}>Cancel</Button
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
		{:else}
			<p class="text-sm text-muted-foreground">
				A role is a set of things someone may do. Give it to people directly or through a group;
				their roles add up. Choose one to see it{canEdit ? ', or make a new role' : ''}.
			</p>
		{/if}
	</div>
</div>
