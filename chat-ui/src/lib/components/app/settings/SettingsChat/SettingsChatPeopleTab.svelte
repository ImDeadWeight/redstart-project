<script lang="ts">
	// People & access: users, groups and roles on one page (2026-11-24), so an
	// admin who puts someone in a group can see, a tab away, what that group's
	// roles grant. See people/people.ts for the model.
	import { Loader } from '@lucide/svelte';
	import { loadPeople, type PeopleData } from './people/people';
	import PeopleUsers from './people/PeopleUsers.svelte';
	import PeopleGroups from './people/PeopleGroups.svelte';
	import PeopleRoles from './people/PeopleRoles.svelte';

	interface Props {
		/** Open on this tab; the old Accounts and Roles links land here. */
		initialTab?: 'users' | 'groups' | 'roles';
	}
	let { initialTab = 'users' }: Props = $props();

	let data = $state<PeopleData | null>(null);
	let loading = $state(true);
	let error = $state('');
	// Read once on purpose: SettingsChat re-creates this page when the link changes.
	// svelte-ignore state_referenced_locally
	let tab = $state<'users' | 'groups' | 'roles'>(initialTab);

	async function reload() {
		error = '';
		try {
			data = await loadPeople();
			// An admin who cannot manage accounts sees Roles only.
			if (!data.accounts && tab !== 'roles') tab = 'roles';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	void reload();

	const tabs = $derived(
		[
			{
				id: 'users' as const,
				label: 'Users',
				count: data?.accounts?.length,
				show: !!data?.accounts
			},
			{ id: 'groups' as const, label: 'Groups', count: data?.groups?.length, show: !!data?.groups },
			{ id: 'roles' as const, label: 'Roles', count: data?.roles.length, show: true }
		].filter((t) => t.show)
	);
</script>

<div class="space-y-5">
	<p class="text-sm text-muted-foreground">
		People get access through <strong>roles</strong>, given to them directly or through a
		<strong>group</strong>. Roles add up: someone can do what any of their roles allows, but never
		more than the running profile has switched on. The owner can do everything.
	</p>

	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{/if}

	{#if loading}
		<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
			<Loader class="h-3.5 w-3.5 animate-spin" /> Loading…
		</p>
	{:else if data}
		<div role="tablist" aria-label="People and access" class="flex gap-1 border-b border-border/50">
			{#each tabs as t (t.id)}
				<button
					type="button"
					role="tab"
					aria-selected={tab === t.id}
					onclick={() => (tab = t.id)}
					class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {tab === t.id
						? 'border-primary font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
				>
					{t.label}
					{#if t.count !== undefined}<span class="ml-1 text-xs text-muted-foreground"
							>{t.count}</span
						>{/if}
				</button>
			{/each}
		</div>

		{#if tab === 'users' && data.accounts}
			<PeopleUsers {data} {reload} />
		{:else if tab === 'groups' && data.groups}
			<PeopleGroups {data} {reload} />
		{:else}
			<PeopleRoles {data} {reload} />
		{/if}
	{/if}
</div>
