<script lang="ts">
	import { CircleUser } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { authStore } from '$lib/stores/auth.svelte';
	import { PROFILE_TABS, PROFILE_TAB_IDS, type ProfileTabId } from '$lib/constants/profile-tabs';
	import ProfileAccountTab from './ProfileAccountTab.svelte';
	import ProfileFilesTab from './ProfileFilesTab.svelte';

	// Full-page account view. The shell owns identity (which is true on every
	// tab) and the tab strip; each tab owns its own state and data loading.
	//
	// Tabs come from PROFILE_TABS rather than being hardcoded here, so adding
	// one is an entry in that array plus a branch below. See the note in
	// constants/profile-tabs.ts for why this is state-driven rather than routed.

	let user = $derived(authStore.user);
	let activeTab = $state<ProfileTabId>(PROFILE_TAB_IDS.ACCOUNT);
</script>

{#if user}
	<div class="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6 md:pt-28">
		<div class="flex items-center gap-3">
			<CircleUser class="h-6 w-6 shrink-0" />

			<div class="min-w-0 flex-1">
				<h1 class="truncate text-lg font-semibold">{user.username}</h1>
				<p class="text-sm text-muted-foreground">Your account</p>
			</div>

			<Badge variant="secondary" class="capitalize">{user.role}</Badge>
		</div>

		<div class="flex gap-1 border-b border-border/30" role="tablist">
			{#each PROFILE_TABS as tab (tab.id)}
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === tab.id}
					class="flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors
						{activeTab === tab.id
						? 'border-foreground font-medium text-foreground'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = tab.id)}
				>
					<tab.icon class="h-4 w-4 shrink-0" />
					{tab.label}
				</button>
			{/each}
		</div>

		{#if activeTab === PROFILE_TAB_IDS.ACCOUNT}
			<ProfileAccountTab />
		{:else if activeTab === PROFILE_TAB_IDS.FILES}
			<ProfileFilesTab />
		{/if}
	</div>
{:else}
	<div class="mx-auto w-full max-w-3xl p-6 md:pt-28">
		<p class="text-sm text-muted-foreground">You are not signed in.</p>
	</div>
{/if}
