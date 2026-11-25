<script lang="ts">
	/**
	 * One artifact, shown (artifacts plan §10): the same component beside the
	 * chat and on the artifact's own page.
	 *
	 * THE CONTENT NEVER RUNS ON THIS ORIGIN (D9). The frame loads a view URL on
	 * the content origin, issued by Nest for this account and this revision,
	 * with `sandbox="allow-scripts allow-forms allow-modals"` and never
	 * allow-same-origin, allow-top-navigation or allow-popups. Nest's content
	 * responses add a sandbox CSP and frame-ancestors of their own. The frame
	 * cannot read the login token or call Nest; nothing here reads the frame.
	 *
	 * The token lasts an hour; the viewer asks for a new one before it ends.
	 */
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		Code, Copy, Download, ExternalLink, History, Loader, Monitor, Pencil, RefreshCw,
		RotateCcw, Share2, Smartphone, Tablet, Trash2, X
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import {
		ArtifactService, VIEWPORTS, canEditArtifact, canManageArtifact,
		type ArtifactDetail, type ArtifactRevision, type Viewport
	} from '$lib/services/artifact.service';
	import { RouterService } from '$lib/services/router.service';
	import { ROUTES } from '$lib/constants/routes';
	import { artifactPanelStore } from '$lib/stores/artifact-panel.svelte';
	import ArtifactShareDialog from './ArtifactShareDialog.svelte';

	interface Props {
		id: string;
		/** The chat it is open beside, when it is in the panel. */
		conversationId?: string | null;
		/** 'panel': beside a chat; 'page': its own page, with the revision list. */
		mode?: 'panel' | 'page';
		onClose?: () => void;
	}

	let { id, conversationId = null, mode = 'panel', onClose }: Props = $props();

	let detail = $state<ArtifactDetail | null>(null);
	let error = $state('');
	let viewUrl = $state<string | null>(null);
	let viewing = $state<number | 'draft' | null>(null);
	let viewError = $state('');
	/** undefined: the default (your live draft while you hold one, else the newest). */
	let chosen = $state<number | 'draft' | undefined>(undefined);
	let viewport = $state<Viewport>('desktop');
	let paper = $state<'letter' | 'a4'>('letter');
	let revisions = $state<ArtifactRevision[]>([]);
	let showSource = $state(false);
	let sourcePath = $state<string | null>(null);
	let sourceText = $state('');
	let shareOpen = $state(false);
	let renaming = $state(false);
	let titleDraft = $state('');
	let busy = $state(false);
	let frameKey = $state(0);
	let renewTimer: ReturnType<typeof setTimeout> | null = null;

	const canEdit = $derived(canEditArtifact(detail));
	const canManage = $derived(canManageArtifact(detail));
	const isDocument = $derived(detail?.kind === 'document');

	async function load() {
		error = '';
		try {
			detail = await ArtifactService.get(id);
			titleDraft = detail.title;
		} catch (e) {
			detail = null;
			error = e instanceof Error ? e.message : 'Could not open it';
			return;
		}
		await loadView();
		if (mode === 'page' || revisions.length) void loadRevisions();
	}

	async function loadView() {
		viewError = '';
		if (renewTimer) clearTimeout(renewTimer);
		if (!detail || (detail.head === 0 && !detail.draft?.mine)) {
			viewUrl = null;
			viewing = null;
			viewError = 'Nothing to show yet.';
			return;
		}
		try {
			const v = await ArtifactService.view(id, chosen === undefined ? {} : { revision: chosen });
			viewUrl = v.url;
			viewing = v.revision;
			frameKey++;
			// A new token a minute before this one ends.
			renewTimer = setTimeout(() => void loadView(), Math.max(30_000, v.expiresAt - Date.now() - 60_000));
		} catch (e) {
			viewUrl = null;
			viewError = e instanceof Error ? e.message : 'Could not show it';
		}
	}

	async function loadRevisions() {
		try {
			revisions = (await ArtifactService.revisions(id)).revisions;
		} catch {
			revisions = [];
		}
	}

	// Load on open, and again whenever the agent changes it (the panel store
	// counts those writes).
	$effect(() => {
		void id;
		void artifactPanelStore.revision;
		untrack(() => void load());
		return () => {
			if (renewTimer) clearTimeout(renewTimer);
		};
	});

	async function pick(value: string) {
		chosen = value === '' ? undefined : value === 'draft' ? 'draft' : Number(value);
		await loadView();
	}

	async function openSource(path: string) {
		sourcePath = path;
		sourceText = 'Loading…';
		try {
			sourceText = await ArtifactService.source(id, path, viewing ?? undefined);
		} catch (e) {
			sourceText = e instanceof Error ? e.message : 'Could not read it';
		}
	}

	async function act<T>(fn: () => Promise<T>, done?: (r: T) => void | Promise<void>) {
		busy = true;
		try {
			const r = await fn();
			await done?.(r);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'That did not work');
		} finally {
			busy = false;
		}
	}

	const restore = () =>
		act(() => ArtifactService.restore(id, viewing as number), async (r) => {
			toast.success(`Restored as revision ${r.revision}`);
			chosen = undefined;
			await load();
			await loadRevisions();
		});

	const fork = () =>
		act(() => ArtifactService.create({ title: `${detail!.title} (copy)`, from: id, projectId: detail!.projectId }), (r) => {
			toast.success(r.placedIn === 'project' ? 'Copied into the project' : 'Copied into your artifacts');
			if (mode === 'panel') artifactPanelStore.show(r.id, conversationId);
			else void goto(RouterService.artifact(r.id));
		});

	const saveTitle = () =>
		act(() => ArtifactService.rename(id, { title: titleDraft }), (a) => {
			renaming = false;
			if (detail) detail = { ...detail, title: a.title };
		});

	let confirmDelete = $state(false);
	const remove = () =>
		act(() => ArtifactService.remove(id), () => {
			toast.success('Moved to the trash');
			if (mode === 'panel') artifactPanelStore.close();
			else void goto(ROUTES.ARTIFACTS);
		});

	function openFull() {
		// The content URL itself: its own origin and sandbox CSP, in a new tab
		// that cannot reach this one (noopener).
		if (viewUrl) window.open(viewUrl, '_blank', 'noopener,noreferrer');
	}

	const VIEWPORT_BUTTONS: { v: Viewport; icon: typeof Monitor }[] = [
		{ v: 'desktop', icon: Monitor },
		{ v: 'tablet', icon: Tablet },
		{ v: 'phone', icon: Smartphone }
	];

	const frameWidth = $derived(isDocument ? (paper === 'a4' ? 794 : 816) : viewport === 'desktop' ? null : VIEWPORTS[viewport]);
	const frameHeight = $derived(isDocument ? (paper === 'a4' ? 1123 : 1056) : null);
	const viewingLabel = $derived(
		viewing === 'draft' ? 'Live draft' : viewing ? `Revision ${viewing}${detail && viewing === detail.head ? ' (latest)' : ''}` : ''
	);
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
	{#if error}
		<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
			<p class="text-sm text-destructive">{error}</p>
			{#if onClose}<button type="button" onclick={onClose} aria-label="Close"><X class="h-4 w-4" /></button>{/if}
		</div>
	{:else if !detail}
		<div class="flex flex-1 items-center justify-center"><Loader class="h-5 w-5 animate-spin" /></div>
	{:else}
		<!-- Toolbar -->
		<div class="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
			{#if renaming}
				<input
					class="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
					bind:value={titleDraft}
					aria-label="Title"
					onkeydown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') renaming = false; }}
				/>
				<button type="button" class="rounded-md px-2 py-1 text-xs hover:bg-accent" onclick={saveTitle} disabled={busy}>Save</button>
			{:else}
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-1.5">
						<h2 class="truncate text-sm font-semibold">{detail.title}</h2>
						{#if canEdit}
							<button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => (renaming = true)} aria-label="Rename">
								<Pencil class="h-3 w-3" />
							</button>
						{/if}
					</div>
					<div class="truncate text-xs text-muted-foreground">
						{viewingLabel}{detail.ownerName ? ` · ${detail.ownerName}` : ''} · you: {detail.role}
					</div>
				</div>
			{/if}

			<select
				class="rounded-md border bg-background px-1.5 py-1 text-xs"
				aria-label="Revision"
				value={chosen === undefined ? '' : String(chosen)}
				onfocus={() => { if (!revisions.length) void loadRevisions(); }}
				onchange={(e) => pick(e.currentTarget.value)}
			>
				<option value="">Latest{detail.draft?.mine ? ' (your live draft)' : ''}</option>
				{#if detail.draft?.mine}<option value="draft">Live draft</option>{/if}
				{#each revisions as r (r.n)}
					<option value={String(r.n)}>Revision {r.n}{r.restoredFrom ? ` (restored ${r.restoredFrom})` : ''}</option>
				{/each}
			</select>

			{#if isDocument}
				<select class="rounded-md border bg-background px-1.5 py-1 text-xs" aria-label="Paper" bind:value={paper}>
					<option value="letter">Letter</option>
					<option value="a4">A4</option>
				</select>
			{:else}
				<div class="flex rounded-md border">
					{#each VIEWPORT_BUTTONS as b (b.v)}
						<button
							type="button"
							class="px-1.5 py-1 {viewport === b.v ? 'bg-accent' : ''}"
							onclick={() => (viewport = b.v)}
							aria-label="{b.v} width"
							title="{b.v} width"
						>
							<b.icon class="h-3.5 w-3.5" />
						</button>
					{/each}
				</div>
			{/if}

			<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={() => void load()} aria-label="Reload" title="Reload"><RefreshCw class="h-3.5 w-3.5" /></button>
			<button type="button" class="rounded-md p-1 hover:bg-accent {showSource ? 'bg-accent' : ''}" onclick={() => (showSource = !showSource)} aria-label="Files" title="Files and source"><Code class="h-3.5 w-3.5" /></button>
			<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={openFull} disabled={!viewUrl} aria-label="Open full page" title="Open full page (print from there)"><ExternalLink class="h-3.5 w-3.5" /></button>
			<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={() => act(() => ArtifactService.downloadZip(id, viewing ?? undefined))} aria-label="Download" title="Download as .zip"><Download class="h-3.5 w-3.5" /></button>
			<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={fork} disabled={busy} aria-label="Make a copy" title="Make a copy (fork)"><Copy class="h-3.5 w-3.5" /></button>
			{#if canManage}
				<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={() => (shareOpen = true)} aria-label="Share" title="Share"><Share2 class="h-3.5 w-3.5" /></button>
			{/if}
			{#if mode === 'panel'}
				<a class="rounded-md p-1 hover:bg-accent" href={RouterService.artifact(id)} aria-label="Its own page" title="Its own page"><History class="h-3.5 w-3.5" /></a>
			{/if}
			{#if onClose}
				<button type="button" class="rounded-md p-1 hover:bg-accent" onclick={onClose} aria-label="Close"><X class="h-4 w-4" /></button>
			{/if}
		</div>

		{#if typeof viewing === 'number' && detail && viewing !== detail.head && canEdit}
			<div class="flex items-center justify-between gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
				<span>You are looking at revision {viewing}. The latest is {detail.head}.</span>
				<button type="button" class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium hover:bg-amber-500/20" onclick={restore} disabled={busy}>
					<RotateCcw class="h-3 w-3" /> Restore this one
				</button>
			</div>
		{/if}

		<div class="flex min-h-0 flex-1">
			{#if showSource}
				<div class="flex w-56 flex-shrink-0 flex-col border-r text-xs">
					<ul class="overflow-y-auto py-1">
						{#each detail.files as f (f.path)}
							<li>
								<button type="button" class="w-full truncate px-3 py-1 text-left hover:bg-accent {sourcePath === f.path ? 'bg-accent' : ''}" onclick={() => openSource(f.path)}>
									{f.path}
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if showSource && sourcePath}
				<pre class="min-w-0 flex-1 overflow-auto p-3 font-mono text-xs whitespace-pre">{sourceText}</pre>
			{:else}
				<div class="min-w-0 flex-1 overflow-auto {frameWidth ? 'bg-muted/40 p-4' : ''}">
					{#if viewUrl}
						{#key frameKey}
							<!-- Sandboxed, cross-origin, no referrer: see the header. -->
							<iframe
								src={viewUrl}
								title={detail.title}
								sandbox="allow-scripts allow-forms allow-modals"
								referrerpolicy="no-referrer"
								class="mx-auto block border-0 bg-white {frameWidth ? 'shadow-lg' : 'h-full w-full'}"
								style={frameWidth ? `width:${frameWidth}px;height:${frameHeight ? `${frameHeight}px` : '100%'};min-height:${frameHeight ? 0 : 600}px` : ''}
							></iframe>
						{/key}
					{:else}
						<div class="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
							{viewError || 'Loading…'}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if mode === 'page'}
			<div class="border-t px-3 py-2">
				<details>
					<summary class="cursor-pointer text-xs text-muted-foreground">History ({revisions.length} revisions)</summary>
					<ul class="mt-1 max-h-48 overflow-y-auto text-xs">
						{#each revisions as r (r.n)}
							<li class="flex items-center gap-2 py-0.5">
								<button type="button" class="hover:underline" onclick={() => pick(String(r.n))}>Revision {r.n}</button>
								<span class="text-muted-foreground">{new Date(r.sealedAt).toLocaleString()}{r.byName ? ` · ${r.byName}` : ''}{r.restoredFrom ? ` · restored from ${r.restoredFrom}` : ''}</span>
							</li>
						{/each}
					</ul>
				</details>
				{#if canManage}
					<div class="mt-2 text-xs">
						{#if confirmDelete}
							<span>Move it to the trash?</span>
							<button type="button" class="ml-2 text-destructive hover:underline" onclick={remove} disabled={busy}>Delete</button>
							<button type="button" class="ml-2 hover:underline" onclick={() => (confirmDelete = false)}>Cancel</button>
						{:else}
							<button type="button" class="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive" onclick={() => (confirmDelete = true)}>
								<Trash2 class="h-3 w-3" /> Delete
							</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		{#if canManage}
			<ArtifactShareDialog bind:open={shareOpen} artifact={detail} onChanged={(a) => (detail = detail ? { ...detail, ...a } : detail)} />
		{/if}
	{/if}
</div>
