<script lang="ts">
	import { X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { ActionIcon } from '$lib/components/app';
	import { ArtifactsGallery } from '$lib/components/app/artifacts';
	import { SETTINGS_FALLBACK_EXIT_ROUTE } from '$lib/constants';

	// Same exit behaviour as the Projects page.
	function handleClose() {
		if (browser && window.history.length > 1) history.back();
		else goto(SETTINGS_FALLBACK_EXIT_ROUTE);
	}
</script>

<div class="relative h-full overflow-y-auto">
	<div class="fixed top-4.5 right-4 z-50 md:hidden">
		<ActionIcon icon={X} tooltip="Close" onclick={handleClose} />
	</div>

	<div class="mx-auto max-w-5xl px-4 py-8 md:px-8">
		<h1 class="mb-1 text-xl font-semibold">Artifacts</h1>
		<p class="mb-5 text-sm text-muted-foreground">
			Pages, prototypes and mockups you and the assistant made, and ones shared with you.
		</p>
		<ArtifactsGallery />
	</div>
</div>
