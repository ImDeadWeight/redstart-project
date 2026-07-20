<script lang="ts">
	import { onMount } from 'svelte';
	import { FolderOpen, Loader } from '@lucide/svelte';
	import { twigFsApi } from '$lib/utils/twig';
	import { toolsStore } from '$lib/stores/tools.svelte';

	// Twig desktop only: shows which local folder the file tools operate on,
	// right where the user is about to ask for file work. Renders nothing on
	// web/Android (no bridge) — the whole component is a no-op there.

	const api = twigFsApi();

	let rootDir = $state<string | null>(null);
	let busy = $state(false);

	onMount(async () => {
		if (!api) return;
		try {
			({ rootDir } = await api.getRoot());
		} catch {
			/* bridge unavailable */
		}
	});

	async function changeFolder() {
		if (!api) return;
		busy = true;
		try {
			({ rootDir } = await api.pickRoot());
			// Refresh the advertised fs_* tool set so a newly granted folder's
			// tools are available immediately.
			await toolsStore.loadLocalFsTools();
		} catch {
			/* user cancelled or bridge error */
		} finally {
			busy = false;
		}
	}
</script>

{#if api && rootDir}
	<div class="mt-1.5 flex items-center justify-center gap-1.5 px-2 text-muted-foreground">
		<button
			type="button"
			class="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors hover:bg-muted hover:text-foreground"
			onclick={changeFolder}
			disabled={busy}
			title="Change the folder local file tools may read and write"
		>
			{#if busy}
				<Loader class="h-3 w-3 shrink-0 animate-spin" />
			{:else}
				<FolderOpen class="h-3 w-3 shrink-0" />
			{/if}
			<span class="truncate font-mono">{rootDir}</span>
		</button>
	</div>
{/if}
