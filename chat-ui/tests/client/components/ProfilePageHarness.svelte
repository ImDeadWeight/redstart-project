<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { ProfilePage } from '$lib/components/app/profile';
	import { authStore } from '$lib/stores/auth.svelte';

	// The page renders nothing without a signed-in user, so the harness seeds
	// one directly rather than driving a login round-trip.
	authStore.user = {
		id: 'acc-test',
		username: 'alice',
		tier: 'user',
		role: 'user',
		apiKeyPrefix: 'rst_abcd',
		createdAt: '2026-01-02T03:04:05.000Z',
		lastLoginAt: '2026-08-07T09:10:11.000Z'
	};
</script>

<Tooltip.Provider>
	<ProfilePage />
</Tooltip.Provider>
