<script lang="ts">
	import { untrack } from 'svelte';
	import RedstartLoadingScreen from '$lib/components/app/RedstartLoadingScreen.svelte';

	interface Props {
		error?: string | null;
		retrying?: boolean;
		showRetry?: boolean;
		/** Omitted in one case to prove the button is gated on the handler too. */
		withHandlers?: boolean;
	}

	let { error = null, retrying = false, showRetry = false, withHandlers = true }: Props = $props();

	// Fixture props, read once — each test renders a fresh harness.
	const initial = untrack(() => ({ error, retrying, showRetry, withHandlers }));

	let retried = $state(0);
</script>

<RedstartLoadingScreen
	error={initial.error}
	retrying={initial.retrying}
	showRetry={initial.showRetry}
	onRetry={initial.withHandlers ? () => retried++ : undefined}
	onOpenSettings={initial.withHandlers ? () => {} : undefined}
/>

<!-- Surfaced so a test can prove the click reached the handler. -->
<span data-testid="retry-count">{retried}</span>
