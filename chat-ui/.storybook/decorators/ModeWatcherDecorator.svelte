<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		children?: any;
	}

	let { children }: Props = $props();

	// The app is dark-only, so stories render dark unconditionally. This used to
	// read the mode-watcher key and fall back to the OS preference, which meant
	// stories could render light while the app itself never can.
	onMount(() => {
		document.documentElement.classList.add('dark');
	});
</script>

{#if children}
	{@const Component = children}

	<Component />
{/if}
