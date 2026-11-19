<script lang="ts">
	/**
	 * One file a tool produced (chat-tooling Phase 2), drawn by its MIME type:
	 *   image/*        inline, fetched with the session; click to enlarge
	 *   csv / tsv      the first 50 rows as a table, plus a download
	 *   anything else  a chip: name, type, size, download
	 *
	 * The file is fetched through fetchFileBlob, never an <img src>/<a href>
	 * to the server: neither would carry the session, and /files/download
	 * requires it. Object URLs are revoked when the component goes away.
	 */
	import { onDestroy } from 'svelte';
	import { Download, FileText } from '@lucide/svelte';
	import { fetchFileBlob } from '$lib/utils/agentic';
	import { parseDelimited, resourceKind, type ToolResultResource } from '$lib/utils/resource-links';

	interface Props {
		resource: ToolResultResource;
		onDownload: (path: string) => void;
	}

	let { resource, onDownload }: Props = $props();

	const TABLE_ROWS = 50;
	const kind = $derived(resourceKind(resource.mimeType));
	const name = $derived(resource.path.split('/').pop() || resource.path);

	let objectUrl = $state<string | null>(null);
	let rows = $state<string[][] | null>(null);
	let error = $state<string | null>(null);
	let enlarged = $state(false);

	$effect(() => {
		const path = resource.path;
		const k = kind;
		if (k === 'file') return;
		let cancelled = false;
		fetchFileBlob(path)
			.then(async (blob) => {
				if (cancelled) return;
				if (k === 'image') {
					objectUrl = URL.createObjectURL(blob);
				} else {
					const text = await blob.text();
					// One row past the limit, so "more rows" is known, not guessed.
					rows = parseDelimited(text, TABLE_ROWS + 1, resource.mimeType === 'text/csv' ? ',' : '\t');
				}
			})
			.catch((err) => {
				if (!cancelled) error = err instanceof Error ? err.message : String(err);
			});
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	});
</script>

{#snippet chip()}
	<button
		onclick={() => onDownload(resource.path)}
		class="inline-flex items-center gap-1.5 rounded bg-orange-500/10 px-2.5 py-1.5 text-xs font-medium text-orange-400 transition-colors hover:bg-orange-500/20"
		title={resource.path}
	>
		{#if kind === 'file'}<FileText class="h-3.5 w-3.5" />{:else}<Download class="h-3.5 w-3.5" />{/if}
		<span>{name}</span>
		<span class="text-orange-400/60">{resource.sizeLabel}</span>
	</button>
{/snippet}

<div class="my-2">
	{#if kind === 'image'}
		{#if objectUrl}
			<button
				type="button"
				class="block cursor-zoom-in"
				onclick={() => (enlarged = !enlarged)}
				aria-label={enlarged ? `Shrink ${name}` : `Enlarge ${name}`}
			>
				<img
					src={objectUrl}
					alt={name}
					class="h-auto rounded-lg {enlarged ? 'max-w-full' : 'max-h-80 max-w-full'}"
				/>
			</button>
		{:else if !error}
			<div class="h-24 w-40 animate-pulse rounded-lg bg-muted/50"></div>
		{/if}
		<div class="mt-1">{@render chip()}</div>
	{:else if kind === 'table'}
		{#if rows && rows.length}
			<div class="max-h-80 overflow-auto rounded border border-border">
				<table class="w-full text-xs">
					<thead class="sticky top-0 bg-muted">
						<tr>
							{#each rows[0] as cell, c (c)}
								<th class="px-2 py-1 text-left font-medium whitespace-nowrap">{cell}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each rows.slice(1, TABLE_ROWS + 1) as row, r (r)}
							<tr class="border-t border-border/50">
								{#each row as cell, c (c)}
									<td class="px-2 py-1 whitespace-nowrap">{cell}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if rows.length > TABLE_ROWS + 1}
				<div class="mt-1 text-xs text-muted-foreground">First {TABLE_ROWS} rows shown.</div>
			{/if}
		{/if}
		<div class="mt-1">{@render chip()}</div>
	{:else}
		{@render chip()}
	{/if}
	{#if error}
		<div class="mt-1 text-xs text-destructive">Could not load {name}: {error}</div>
	{/if}
</div>
