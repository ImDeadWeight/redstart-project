<script lang="ts">
	import { untrack } from 'svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { DesktopIconStrip } from '$lib/components/app/navigation';
	import { authStore } from '$lib/stores/auth.svelte';

	interface Props {
		/** Whether a user is signed in — Profile is hidden when nobody is. */
		signedIn?: boolean;
	}

	let { signedIn = true }: Props = $props();

	// Read once, on purpose: each test renders a fresh harness rather than
	// toggling this prop, so the auth state is fixture setup, not reactive state.
	// untrack says that explicitly instead of leaving a state_referenced_locally
	// warning for the next person to wonder about.
	const initiallySignedIn = untrack(() => signedIn);

	authStore.user = initiallySignedIn
		? {
				id: 'acc-test',
				username: 'alice',
				role: 'user',
				apiKeyPrefix: 'rst_abcd',
				createdAt: '2026-01-02T03:04:05.000Z',
				lastLoginAt: '2026-08-07T09:10:11.000Z'
			}
		: null;
</script>

<Tooltip.Provider>
	<!-- The rail only renders its icons while the sidebar is CLOSED, which is
	     exactly the state under test: these buttons are the whole navigation
	     surface when the sidebar is collapsed. -->
	<DesktopIconStrip sidebarOpen={false} onSearchClick={() => {}} />
</Tooltip.Provider>
