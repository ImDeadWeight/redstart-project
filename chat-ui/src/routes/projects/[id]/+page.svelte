<script lang="ts">
	import { X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ActionIcon } from '$lib/components/app';
	import { ProjectPage } from '$lib/components/app/projects';
	import { ROUTES } from '$lib/constants/routes';

	let id = $derived(page.params.id ?? '');
</script>

<div class="relative h-full overflow-y-auto">
	<div class="fixed top-4.5 right-4 z-50 md:hidden">
		<ActionIcon icon={X} tooltip="All projects" onclick={() => goto(ROUTES.PROJECTS)} />
	</div>

	{#key id}
		<ProjectPage {id} />
	{/key}
</div>
