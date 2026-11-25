<script lang="ts">
	import { page } from '$app/state';
	import { ChatScreen } from '$lib/components/app';
	import { ArtifactViewer } from '$lib/components/app/artifacts';
	import { artifactPanelStore } from '$lib/stores/artifact-panel.svelte';

	let { children } = $props();

	let showCenteredEmpty = $derived(!page.params.id);

	// The artifact panel (artifacts plan §10), beside the chat it was opened
	// from; a full-screen sheet on a narrow screen.
	let panel = $derived(
		artifactPanelStore.open && artifactPanelStore.open.conversationId === (page.params.id ?? null)
			? artifactPanelStore.open
			: null
	);
</script>

<div class="flex h-full min-h-0 w-full">
	<div class="h-full min-w-0 flex-1">
		<ChatScreen {showCenteredEmpty} />
	</div>
	{#if panel}
		<aside
			class="fixed inset-0 z-50 h-full bg-background md:static md:z-auto md:w-[46%] md:min-w-[360px] md:max-w-[960px] md:border-l"
			aria-label="Artifact"
		>
			{#key panel.id}
				<ArtifactViewer id={panel.id} conversationId={panel.conversationId} mode="panel" onClose={() => artifactPanelStore.close()} />
			{/key}
		</aside>
	{/if}
</div>

{@render children?.()}
