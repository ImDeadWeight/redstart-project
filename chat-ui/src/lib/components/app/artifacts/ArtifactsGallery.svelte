<script lang="ts">
	/**
	 * The artifacts this account can see (artifacts plan §10): the gallery at
	 * #/artifacts, and (with `projectId`) a project page's Artifacts section.
	 * Mine / Shared with me / In projects, newest first, with search. The
	 * gallery card is the title, kind, revision, owner and when it changed;
	 * no thumbnails yet (plan §15).
	 */
	import { toast } from 'svelte-sonner';
	import { AppWindow, FileText, Image as ImageIcon, Loader, Plus, Search } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { ArtifactService, type Artifact } from '$lib/services/artifact.service';
	import { RouterService } from '$lib/services/router.service';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';

	interface Props {
		/** Only this project's artifacts, and New makes one in it. */
		projectId?: string | null;
		/** May the caller add to that project (D6)? Otherwise New makes one of their own. */
		canAdd?: boolean;
		compact?: boolean;
	}

	let { projectId = null, canAdd = true, compact = false }: Props = $props();

	type Scope = 'all' | 'mine' | 'shared' | 'project';
	let scope = $state<Scope>('all');
	let query = $state('');
	let items = $state<Artifact[] | null>(null);
	let error = $state('');
	let creating = $state(false);

	async function load() {
		error = '';
		try {
			items = await ArtifactService.list({
				scope: projectId ? 'project' : scope === 'all' ? undefined : scope,
				projectId: projectId ?? undefined,
				query: query.trim() || undefined
			});
		} catch (e) {
			items = [];
			error = e instanceof Error ? e.message : 'Could not load artifacts';
		}
	}

	let debounce: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		void scope;
		void query;
		void projectId;
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => void load(), 200);
	});

	const STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Untitled</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; }
</style>
</head>
<body>
  <h1>Untitled</h1>
  <p>Ask the assistant to build this out, or edit it yourself.</p>
</body>
</html>
`;

	async function create() {
		creating = true;
		try {
			const a = await ArtifactService.create({
				title: 'Untitled',
				kind: 'web',
				projectId: canAdd ? projectId : null,
				files: [{ path: 'index.html', content: STARTER }]
			});
			await goto(RouterService.artifact(a.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not make one');
		} finally {
			creating = false;
		}
	}

	function ago(t: number) {
		const s = Math.round((Date.now() - t) / 1000);
		if (s < 90) return 'just now';
		if (s < 5400) return `${Math.round(s / 60)} min ago`;
		if (s < 129600) return `${Math.round(s / 3600)} h ago`;
		return new Date(t).toLocaleDateString();
	}
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center gap-2">
		{#if !projectId}
			<div class="flex rounded-md border text-sm">
				{#each [['all', 'All'], ['mine', 'Mine'], ['shared', 'Shared with me'], ['project', 'In projects']] as [value, label] (value)}
					<button type="button" class="px-2.5 py-1 {scope === value ? 'bg-accent' : ''}" onclick={() => (scope = value as Scope)}>{label}</button>
				{/each}
			</div>
		{/if}
		<div class="relative min-w-40 flex-1">
			<Search class="absolute top-2.5 left-2 h-3.5 w-3.5 text-muted-foreground" />
			<Input bind:value={query} placeholder="Search artifacts" aria-label="Search artifacts" class="pl-7" />
		</div>
		<Button size="sm" onclick={create} disabled={creating}>
			{#if creating}<Loader class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if} New
		</Button>
	</div>

	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{:else if items === null}
		<div class="flex justify-center py-6"><Loader class="h-5 w-5 animate-spin" /></div>
	{:else if items.length === 0}
		<p class="py-6 text-center text-sm text-muted-foreground">
			{query ? 'Nothing matches.' : projectId ? 'No artifacts in this project yet.' : 'No artifacts yet. Ask the assistant for a page, a prototype or a mockup.'}
		</p>
	{:else}
		<ul class="grid gap-2 {compact ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}">
			{#each items as a (a.id)}
				<li>
					<a href={RouterService.artifact(a.id)} class="flex items-start gap-3 rounded-xl border bg-card px-3 py-2.5 hover:border-primary/50">
						<div class="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted">
							{#if a.kind === 'svg'}<ImageIcon class="h-4 w-4" />{:else if a.kind === 'document'}<FileText class="h-4 w-4" />{:else}<AppWindow class="h-4 w-4" />{/if}
						</div>
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{a.title}</div>
							<div class="truncate text-xs text-muted-foreground">
								{a.head ? `r${a.head}` : 'draft'}{a.draft?.mine && a.head ? ' + draft' : ''} · {ago(a.updatedAt)}{a.ownerName && a.role !== 'owner' ? ` · ${a.ownerName}` : ''}{a.role !== 'owner' ? ` · ${a.role}` : ''}
							</div>
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
