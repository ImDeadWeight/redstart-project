<script lang="ts" module>
	import { ArtifactService, type ArtifactDetail } from '$lib/services/artifact.service';

	// One request per artifact per page load, however many cards name it; a
	// card asks again after the panel says the artifact changed.
	const cache = new Map<string, Promise<ArtifactDetail | null>>();
	export function artifactDetail(id: string, fresh = false): Promise<ArtifactDetail | null> {
		if (fresh || !cache.has(id)) cache.set(id, ArtifactService.get(id).catch(() => null));
		return cache.get(id)!;
	}
</script>

<script lang="ts">
	/**
	 * An artifact a tool made or changed, in the transcript (artifacts plan
	 * §10): drawn from the result's `[artifact: <id> r<n>|draft]` line, outside
	 * the collapsed tool block so it is seen. Open shows it beside the chat.
	 *
	 * The line is data from a tool result. The card shows only what Nest says
	 * about the id, and Nest answers only for artifacts this account can read.
	 */
	import { AppWindow, FileText, Image as ImageIcon, PanelRight } from '@lucide/svelte';
	import { artifactPanelStore } from '$lib/stores/artifact-panel.svelte';
	import { RouterService } from '$lib/services/router.service';

	interface Props {
		conversationId: string | null;
		id: string;
		revision: number | 'draft';
	}

	let { conversationId, id, revision }: Props = $props();

	let detail = $state<ArtifactDetail | null | undefined>(undefined);
	$effect(() => {
		void artifactPanelStore.revision;
		let live = true;
		artifactDetail(id, detail !== undefined).then((d) => {
			if (live) detail = d;
		});
		return () => (live = false);
	});

	const isOpen = $derived(artifactPanelStore.open?.id === id);
	// The line says where it stood when the tool ran; once the turn has sealed
	// that draft, say what is saved now.
	const label = $derived.by(() => {
		if (revision === 'draft') {
			if (detail && !detail.draft?.mine) return detail.head ? `revision ${detail.head}` : 'nothing saved yet';
			return 'draft, saved when this turn ends';
		}
		return revision ? `revision ${revision}` : 'nothing saved yet';
	});
</script>

{#if detail === null}
	<div class="my-1 inline-flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
		<AppWindow class="h-3.5 w-3.5" /> An artifact you can no longer open
	</div>
{:else}
	<div
		class="my-2 flex max-w-md items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-xs {isOpen
			? 'border-primary/60'
			: ''}"
	>
		<div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
			{#if detail?.kind === 'svg'}<ImageIcon class="h-4 w-4" />{:else if detail?.kind === 'document'}<FileText
					class="h-4 w-4"
				/>{:else}<AppWindow class="h-4 w-4" />{/if}
		</div>
		<div class="min-w-0 flex-1">
			<div class="truncate text-sm font-medium">{detail?.title ?? 'Artifact'}</div>
			<div class="truncate text-xs text-muted-foreground">
				{detail?.kind === 'document' ? 'Document' : detail?.kind === 'svg' ? 'SVG' : 'Web'} · {label}
			</div>
		</div>
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent"
			onclick={() => artifactPanelStore.show(id, conversationId)}
			title="Show beside the chat"
		>
			<PanelRight class="h-3.5 w-3.5" /> Open
		</button>
		<a class="text-xs text-muted-foreground hover:text-foreground" href={RouterService.artifact(id)}>Page</a>
	</div>
{/if}
