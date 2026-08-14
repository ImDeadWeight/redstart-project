<script lang="ts">
	import { apiFetch, apiPost } from '$lib/utils';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Trash2, Plus, Copy, ShieldCheck } from '@lucide/svelte';

	type AdminGrants = Record<string, boolean>;

	type RolePermissions = {
		capabilities?: string[] | null;
		webSourceIds?: string[] | null;
		allowWhitelistBypass?: boolean | null;
		maxFetchTokens?: number | null;
		fileSystem?: { allowWrite?: boolean; allowDestructive?: boolean } | null;
		surfaces?: string[] | null;
		admin?: AdminGrants | null;
	};

	type Role = {
		id: string;
		name: string;
		description: string;
		builtIn?: boolean;
		permissions: RolePermissions;
	};

	type RolesResponse = {
		roles: Role[];
		capabilityIds: string[];
		adminPermissions: string[];
		webSources: { id: string; name: string }[];
		surfaces: string[];
		canEdit: boolean;
	};

	let roles = $state<Role[]>([]);
	let capabilityIds = $state<string[]>([]);
	let adminPermissions = $state<string[]>([]);
	let webSources = $state<{ id: string; name: string }[]>([]);
	let surfaces = $state<string[]>([]);
	let canEdit = $state(false);

	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);
	let busyId = $state<string | null>(null);
	let confirmDeleteId = $state<string | null>(null);

	// The role currently open in the editor. null = nothing open.
	let draft = $state<Role | null>(null);

	async function load() {
		loading = true;
		error = '';
		try {
			const result = await apiFetch<RolesResponse>('/auth/roles', { authOnly: true });
			roles = result.roles;
			capabilityIds = result.capabilityIds;
			adminPermissions = result.adminPermissions;
			webSources = result.webSources;
			surfaces = result.surfaces;
			canEdit = result.canEdit;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load roles';
		} finally {
			loading = false;
		}
	}

	void load();

	function blankRole(): Role {
		// A new role starts UNRESTRICTED (every list null = inherit) rather than
		// empty, so an admin who saves immediately has not silently locked its
		// members out of everything. Restriction is opt-in, tick by tick.
		return {
			id: '',
			name: '',
			description: '',
			permissions: {
				capabilities: null,
				webSourceIds: null,
				allowWhitelistBypass: null,
				maxFetchTokens: null,
				fileSystem: null,
				surfaces: null,
				admin: null
			}
		};
	}

	function cloneRole(role: Role) {
		draft = {
			id: '',
			name: `${role.name} copy`,
			description: role.description,
			permissions: structuredClone($state.snapshot(role.permissions))
		};
	}

	function editRole(role: Role) {
		draft = {
			...role,
			permissions: structuredClone($state.snapshot(role.permissions))
		};
	}

	async function save() {
		if (!draft?.name.trim()) return;
		saving = true;
		error = '';
		try {
			await apiPost('/auth/roles', {
				id: draft.id || undefined,
				name: draft.name,
				description: draft.description,
				permissions: $state.snapshot(draft.permissions)
			});
			draft = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save role';
		} finally {
			saving = false;
		}
	}

	async function remove(id: string) {
		busyId = id;
		try {
			const result = await apiFetch<{ reassigned: number }>(`/auth/roles/${id}`, {
				method: 'DELETE',
				authOnly: true
			});
			confirmDeleteId = null;
			if (result.reassigned > 0) {
				error = `Role deleted — ${result.reassigned} account(s) moved to Full Access.`;
			}
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete role';
		} finally {
			busyId = null;
		}
	}

	// --- Tri-state list helpers -------------------------------------------
	// null means "inherit whatever the server allows" and an array means "narrow
	// to exactly these". The distinction is the whole model, so the UI shows it
	// explicitly rather than collapsing an untouched role into an empty list —
	// which would read as "allow nothing".

	function isRestricted(list: string[] | null | undefined) {
		return Array.isArray(list);
	}

	function setRestricted(field: 'capabilities' | 'webSourceIds' | 'surfaces', on: boolean) {
		if (!draft) return;
		draft.permissions[field] = on ? [] : null;
	}

	function toggleIn(field: 'capabilities' | 'webSourceIds' | 'surfaces', value: string) {
		if (!draft) return;
		const list = draft.permissions[field];
		if (!Array.isArray(list)) return;
		draft.permissions[field] = list.includes(value)
			? list.filter((v) => v !== value)
			: [...list, value];
	}

	function summarize(role: Role): string {
		const p = role.permissions ?? {};
		const parts: string[] = [];
		parts.push(
			Array.isArray(p.capabilities)
				? p.capabilities.length
					? `${p.capabilities.length} capabilit${p.capabilities.length === 1 ? 'y' : 'ies'}`
					: 'no capabilities'
				: 'all capabilities'
		);
		parts.push(
			Array.isArray(p.webSourceIds)
				? p.webSourceIds.length
					? `${p.webSourceIds.length} web source(s)`
					: 'no web sources'
				: 'all web sources'
		);
		if (p.fileSystem?.allowWrite === false) parts.push('no writes');
		if (p.fileSystem?.allowDestructive === false) parts.push('no deletes');
		if (Array.isArray(p.surfaces)) parts.push(`apps: ${p.surfaces.join(', ') || 'none'}`);
		if (p.admin && Object.keys(p.admin).length === 0) parts.push('no admin');
		return parts.join(' · ');
	}

	const CAPABILITY_LABELS: Record<string, string> = {
		postgres: 'Postgres',
		documents: 'Documents',
		sqlite: 'SQLite',
		vault: 'Vault',
		git: 'Git',
		file_system: 'File System',
		scholar: 'Scholar'
	};
</script>

<div class="space-y-8">
	<div class="space-y-1">
		<p class="text-sm text-muted-foreground">
			A role <strong>restricts</strong> what an account may reach. It can never grant access the
			server has not already enabled, so a role's effective reach is whatever the running profile
			allows, minus what the role withholds.
		</p>
		<p class="text-xs text-muted-foreground">
			The owner account is never restricted. Accounts with no role get Full Access.
		</p>
	</div>

	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{/if}

	{#if loading}
		<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
			<Loader class="h-3.5 w-3.5 animate-spin" /> Loading…
		</p>
	{:else}
		<!-- Role list -->
		<div class="space-y-2">
			<div class="flex items-center justify-between">
				<h4 class="text-sm font-medium">Roles</h4>
				{#if canEdit}
					<Button size="sm" variant="outline" onclick={() => (draft = blankRole())}>
						<Plus class="h-3.5 w-3.5" /> New role
					</Button>
				{/if}
			</div>

			<ul class="space-y-2">
				{#each roles as role (role.id)}
					<li class="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<p class="flex items-center gap-1.5 text-sm font-medium">
									<ShieldCheck class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									{role.name}
									{#if role.builtIn}
										<span class="text-xs font-normal text-muted-foreground">(built-in)</span>
									{/if}
								</p>
								{#if role.description}
									<p class="text-xs text-muted-foreground">{role.description}</p>
								{/if}
								<p class="mt-0.5 text-xs text-muted-foreground">{summarize(role)}</p>
							</div>

							{#if canEdit}
								<div class="flex shrink-0 gap-1">
									<Button size="sm" variant="ghost" onclick={() => cloneRole(role)} title="Clone">
										<Copy class="h-3.5 w-3.5" />
									</Button>
									{#if !role.builtIn}
										<Button size="sm" variant="ghost" onclick={() => editRole(role)}>Edit</Button>
										{#if confirmDeleteId === role.id}
											<Button
												size="sm"
												variant="destructive"
												disabled={busyId === role.id}
												onclick={() => remove(role.id)}
											>
												{#if busyId === role.id}<Loader class="h-3.5 w-3.5 animate-spin" />{/if}
												Confirm
											</Button>
											<Button size="sm" variant="ghost" onclick={() => (confirmDeleteId = null)}>
												Cancel
											</Button>
										{:else}
											<Button
												size="sm"
												variant="ghost"
												onclick={() => (confirmDeleteId = role.id)}
												title="Delete"
											>
												<Trash2 class="h-3.5 w-3.5" />
											</Button>
										{/if}
									{/if}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</div>

		<!-- Editor -->
		{#if draft}
			<div class="space-y-5 rounded-md border border-border/60 px-3 py-4">
				<h4 class="text-sm font-medium">{draft.id ? 'Edit role' : 'New role'}</h4>

				<div class="flex flex-wrap gap-2">
					<Input placeholder="Role name" bind:value={draft.name} class="max-w-60" />
					<Input placeholder="Description (optional)" bind:value={draft.description} class="flex-1" />
				</div>

				<!-- Capabilities -->
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={isRestricted(draft.permissions.capabilities)}
							onchange={(e) => setRestricted('capabilities', e.currentTarget.checked)}
						/>
						Limit local capabilities
					</label>
					{#if isRestricted(draft.permissions.capabilities)}
						<div class="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
							{#each capabilityIds as id (id)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={draft.permissions.capabilities?.includes(id)}
										onchange={() => toggleIn('capabilities', id)}
									/>
									{CAPABILITY_LABELS[id] ?? id}
								</label>
							{/each}
						</div>
					{:else}
						<p class="pl-6 text-xs text-muted-foreground">
							Every capability the running profile has enabled.
						</p>
					{/if}
				</div>

				<!-- Web sources -->
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={isRestricted(draft.permissions.webSourceIds)}
							onchange={(e) => setRestricted('webSourceIds', e.currentTarget.checked)}
						/>
						Limit web sources
					</label>
					{#if isRestricted(draft.permissions.webSourceIds)}
						<div class="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
							{#each webSources as source (source.id)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={draft.permissions.webSourceIds?.includes(source.id)}
										onchange={() => toggleIn('webSourceIds', source.id)}
									/>
									{source.name}
								</label>
							{/each}
						</div>
						<p class="pl-6 text-xs text-muted-foreground">
							Limiting sources also forces the URL whitelist on for this role.
						</p>
					{:else}
						<p class="pl-6 text-xs text-muted-foreground">Every source the profile has active.</p>
					{/if}
				</div>

				<!-- File system policy -->
				<div class="space-y-2">
					<p class="text-sm font-medium">File System</p>
					<div class="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
						<label class="flex items-center gap-1.5 text-sm">
							<input
								type="checkbox"
								checked={draft.permissions.fileSystem?.allowWrite === false}
								onchange={(e) => {
									if (!draft) return;
									draft.permissions.fileSystem = {
										...(draft.permissions.fileSystem ?? {}),
										allowWrite: e.currentTarget.checked ? false : undefined
									};
								}}
							/>
							Block writes
						</label>
						<label class="flex items-center gap-1.5 text-sm">
							<input
								type="checkbox"
								checked={draft.permissions.fileSystem?.allowDestructive === false}
								onchange={(e) => {
									if (!draft) return;
									draft.permissions.fileSystem = {
										...(draft.permissions.fileSystem ?? {}),
										allowDestructive: e.currentTarget.checked ? false : undefined
									};
								}}
							/>
							Block deletes
						</label>
					</div>
					<p class="pl-6 text-xs text-muted-foreground">
						These only ever subtract — a role cannot switch on a permission the server has turned
						off. Applies to Redstart's own file tools and the web file explorer, not to a client
						app's local files.
					</p>
				</div>

				<!-- Surfaces -->
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={isRestricted(draft.permissions.surfaces)}
							onchange={(e) => setRestricted('surfaces', e.currentTarget.checked)}
						/>
						Limit which apps may connect
					</label>
					{#if isRestricted(draft.permissions.surfaces)}
						<div class="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
							{#each surfaces as surface (surface)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={draft.permissions.surfaces?.includes(surface)}
										onchange={() => toggleIn('surfaces', surface)}
									/>
									{surface}
								</label>
							{/each}
						</div>
						<p class="pl-6 text-xs text-amber-600 dark:text-amber-500">
							Members of this role cannot hold an account-wide API key — that credential names no
							app, so it would be a way around this setting. They use per-connector keys instead.
							Note this is enforced strictly for connector keys; a client that logs in with a
							password is treated as the chat UI.
						</p>
					{:else}
						<p class="pl-6 text-xs text-muted-foreground">Any app.</p>
					{/if}
				</div>

				<!-- Admin -->
				<div class="space-y-2">
					<label class="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={draft.permissions.admin != null}
							onchange={(e) => {
								if (!draft) return;
								draft.permissions.admin = e.currentTarget.checked ? {} : null;
							}}
						/>
						Limit administration
					</label>
					{#if draft.permissions.admin != null}
						<div class="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
							{#each adminPermissions as permission (permission)}
								<label class="flex items-center gap-1.5 text-sm">
									<input
										type="checkbox"
										checked={draft.permissions.admin?.[permission] === true}
										onchange={(e) => {
											if (!draft?.permissions.admin) return;
											draft.permissions.admin = {
												...draft.permissions.admin,
												[permission]: e.currentTarget.checked
											};
										}}
									/>
									{permission}
								</label>
							{/each}
						</div>
						<p class="pl-6 text-xs text-muted-foreground">
							Only affects admin-tier accounts — a role can never make a user an admin.
						</p>
					{:else}
						<p class="pl-6 text-xs text-muted-foreground">
							Admin-tier members keep every administrative permission.
						</p>
					{/if}
				</div>

				<div class="flex gap-2">
					<Button onclick={save} disabled={saving || !draft.name.trim()}>
						{#if saving}<Loader class="h-3.5 w-3.5 animate-spin" />{/if} Save role
					</Button>
					<Button variant="ghost" onclick={() => (draft = null)}>Cancel</Button>
				</div>
			</div>
		{/if}
	{/if}
</div>
