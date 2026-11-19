<script lang="ts">
	import { X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { ActionIcon } from '$lib/components/app';
	import { ProjectsPage } from '$lib/components/app/projects';
	import { SETTINGS_FALLBACK_EXIT_ROUTE } from '$lib/constants';

	// Same exit behaviour as the Workflows page.
	function handleClose() {
		if (browser && window.history.length > 1) {
			history.back();
		} else {
			goto(SETTINGS_FALLBACK_EXIT_ROUTE);
		}
	}
</script>

<div class="relative h-full overflow-y-auto">
	<div class="fixed top-4.5 right-4 z-50 md:hidden">
		<ActionIcon icon={X} tooltip="Close" onclick={handleClose} />
	</div>

	<ProjectsPage />
</div>
