<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ArtifactViewer } from '$lib/components/app/artifacts';
	import { ROUTES } from '$lib/constants/routes';

	let id = $derived(page.params.id ?? '');
</script>

<div class="h-full min-h-0">
	{#key id}
		<ArtifactViewer {id} mode="page" onClose={() => goto(ROUTES.ARTIFACTS)} />
	{/key}
</div>
