<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ArrowUp,
		ChevronRight,
		Download,
		File as FileIcon,
		Folder,
		FolderPlus,
		Loader,
		Trash2,
		Upload,
		X
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { FilesService, type FileEntry } from '$lib/services/files.service';
	import { localBrowser, serverBrowser, type FileBrowser } from '$lib/services/file-browser';
	import { SvelteSet } from 'svelte/reactivity';

	// Browser for the user's files, wherever they live.
	//
	// Server storage is scoped server-side by the authenticated account — the
	// client never sends a user id, and cannot ask for another account's files.
	// Inside Redstart Twig there is also the folder granted on THIS computer,
	// which is a different machine with a different trust model; both are reached
	// through the same FileBrowser interface (see services/file-browser.ts) so
	// this component does not need to know which is which.
	//
	// Deletions go to the recycle bin either way — nothing here destroys data.

	// One tab per place files can live: the server's storage spaces, plus the
	// folder granted on this computer when running inside Redstart Twig. Both are
	// FileBrowsers, so everything below is written once for either machine.
	let browsers = $state<FileBrowser[]>([]);
	let space = $state('documents');
	let path = $state('.');
	let entries = $state<FileEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	let preview = $state<{ name: string; text: string; truncated: boolean } | null>(null);
	let uploadInput = $state<HTMLInputElement | null>(null);

	const crumbs = $derived(path === '.' ? [] : path.split('/').filter(Boolean));
	const browser = $derived(browsers.find((b) => b.id === space) ?? browsers[0]);

	async function load() {
		if (!browser) return;
		loading = true;
		error = null;
		try {
			const listing = await browser.list(path);
			entries = listing.entries;
			path = listing.path || '.';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			entries = [];
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		const found: FileBrowser[] = [];
		try {
			for (const s of await FilesService.spaces()) found.push(serverBrowser(s));
		} catch {
			/* no server storage configured — load() surfaces the reason */
		}
		// Appended last so the server's own storage stays the default view.
		const local = localBrowser();
		if (local) found.push(local);

		browsers = found;
		if (found.length > 0 && !found.some((b) => b.id === space)) space = found[0].id;
		await load();
	});

	async function openSpace(id: string) {
		space = id;
		path = '.';
		preview = null;
		await load();
	}

	async function navigate(to: string) {
		path = to || '.';
		preview = null;
		// Selections are per-folder: carrying them across a navigation would mean
		// a later drag silently moves items the user can no longer see.
		clearSelection();
		await load();
	}

	function crumbPath(index: number): string {
		return crumbs.slice(0, index + 1).join('/');
	}

	/** The folder containing the current one, or '.' at the top. */
	const parentPath = $derived(crumbs.length === 0 ? '.' : crumbs.slice(0, -1).join('/') || '.');
	const atRoot = $derived(crumbs.length === 0);

	// ---------------------------------------------------------------------------
	// Drag to move
	//
	// A move is a rename with a different parent, so this reuses the same
	// endpoint — and inherits its containment checks, which is the point: there
	// is no second path-handling code path to get wrong. The server also refuses
	// a folder dropped inside itself, so the client guard below is a courtesy
	// (no pointless round-trip, no misleading error), not the enforcement.
	// ---------------------------------------------------------------------------

	/** Paths currently selected, and the paths currently being dragged. */
	const selected = new SvelteSet<string>();
	let draggingPaths = $state<string[]>([]);
	let dropTarget = $state<string | null>(null);
	/** A drop of OS files is pending over this folder ('.' = the open folder). */
	let uploadTarget = $state<string | null>(null);

	function toggleSelect(path: string) {
		if (selected.has(path)) selected.delete(path);
		else selected.add(path);
	}

	function clearSelection() {
		// Mutate, don't reassign: SvelteSet carries its own reactivity, so a
		// fresh instance would be a new object the template is no longer watching.
		selected.clear();
	}

	/** True when a drag carries files from outside the browser, not our rows. */
	function isExternalDrag(event: DragEvent): boolean {
		return !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
	}

	function startDrag(event: DragEvent, entry: FileEntry) {
		// Dragging a SELECTED row drags the whole selection; dragging an
		// unselected one drags just it and leaves the selection alone. That is
		// what every file manager does, and getting it backwards (silently
		// dragging a selection the user forgot about) moves files they did not
		// mean to touch.
		draggingPaths = selected.has(entry.path) ? [...selected] : [entry.path];

		// Text payload so a drag that leaves the app degrades to plain text
		// rather than looking droppable everywhere.
		event.dataTransfer?.setData(
			'text/plain',
			draggingPaths.length > 1 ? `${draggingPaths.length} items` : entry.name
		);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function endDrag() {
		draggingPaths = [];
		dropTarget = null;
	}

	/** Whether one dragged path may legally land in `targetPath`. */
	function canMoveInto(from: string, targetPath: string): boolean {
		if (targetPath === from) return false; // onto itself
		// Already directly inside the destination — a move that changes nothing.
		const currentParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '.';
		if (currentParent === targetPath) return false;
		// A folder cannot be dropped into its own descendant.
		if (targetPath.startsWith(`${from}/`)) return false;
		return true;
	}

	/** A drop is offered when at least one dragged item could actually move. */
	function canDropInto(targetPath: string): boolean {
		return draggingPaths.some((from) => canMoveInto(from, targetPath));
	}

	function onDragOver(event: DragEvent, targetPath: string) {
		if (isExternalDrag(event)) {
			// Dropping OS files means uploading, which the local folder has no
			// concept of — its files are already on this machine. Without this the
			// drop zone would light up and then silently do nothing.
			if (!browser?.upload) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
			uploadTarget = targetPath;
			return;
		}
		if (!canDropInto(targetPath)) return;
		event.preventDefault(); // required, or the browser refuses the drop
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		dropTarget = targetPath;
	}

	function onDragLeave() {
		dropTarget = null;
		uploadTarget = null;
	}

	/**
	 * Run one operation per item and summarise.
	 *
	 * Batches are reported as a whole rather than surfacing the first failure and
	 * abandoning the rest: dropping five files where one name already exists
	 * should move the other four and say so, not stop at the collision.
	 */
	async function runBatch<T>(
		items: T[],
		label: (item: T) => string,
		fn: (item: T) => Promise<unknown>,
		verb: string
	) {
		error = null;
		notice = null;

		const failures: string[] = [];
		let done = 0;
		for (const item of items) {
			try {
				await fn(item);
				done++;
			} catch (err) {
				failures.push(`${label(item)} — ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (done > 0) notice = `${verb} ${done} item${done === 1 ? '' : 's'}.`;
		if (failures.length > 0) {
			error =
				failures.length === 1
					? failures[0]
					: `${failures.length} could not be handled:\n${failures.join('\n')}`;
		}
		await load();
	}

	async function onDrop(event: DragEvent, targetPath: string) {
		event.preventDefault();
		// Stop the surrounding list from also handling a drop aimed at one row.
		event.stopPropagation();

		if (isExternalDrag(event)) {
			const files = Array.from(event.dataTransfer?.files ?? []);
			uploadTarget = null;
			if (files.length === 0) return;
			await runBatch(
				files,
				(file) => file.name,
				(file) => browser.upload!(targetPath, file),
				'Uploaded'
			);
			return;
		}

		const moving = draggingPaths.filter((from) => canMoveInto(from, targetPath));
		endDrag();
		if (moving.length === 0) return;

		await runBatch(
			moving,
			(from) => from.slice(from.lastIndexOf('/') + 1),
			(from) => {
				const name = from.slice(from.lastIndexOf('/') + 1);
				return browser.move(from, targetPath === '.' ? name : `${targetPath}/${name}`);
			},
			'Moved'
		);
		clearSelection();
	}

	async function act<T>(fn: () => Promise<T>, success?: string) {
		error = null;
		notice = null;
		try {
			await fn();
			if (success) notice = success;
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function newFolder() {
		const name = prompt('Folder name');
		if (!name) return;
		const target = path === '.' ? name : `${path}/${name}`;
		await act(() => browser.mkdir(target), `Created ${name}`);
	}

	async function renameEntry(entry: FileEntry) {
		const next = prompt(`Rename "${entry.name}" to`, entry.name);
		if (!next || next === entry.name) return;
		const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
		const to = parent ? `${parent}/${next}` : next;
		await act(() => browser.move(entry.path, to), `Renamed to ${next}`);
	}

	async function removeEntry(entry: FileEntry) {
		// Deliberately says where it goes. "Delete" that turns out to be
		// recoverable is a pleasant surprise; "delete" the user believed was
		// permanent is a reason not to click it at all.
		if (!confirm(`Move "${entry.name}" to the recycle bin?`)) return;
		await act(async () => {
			const res = await browser.remove(entry.path);
			notice = `Moved ${entry.name} to the recycle bin — ${res.hint}.`;
		});
	}

	async function showPreview(entry: FileEntry) {
		error = null;
		try {
			const res = await browser.preview(entry.path);
			preview = { name: entry.name, text: res.text, truncated: res.truncated };
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function onUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // let the same file be picked again after an error
		if (!file) return;
		if (!browser.upload) return;
		await act(() => browser.upload!(path, file), `Uploaded ${file.name}`);
	}

	function formatSize(bytes: number | null): string {
		if (bytes === null) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}
</script>

<div class="space-y-4">
	<div>
		<h4 class="text-sm font-medium">Your files on the server</h4>
		<p class="text-xs text-muted-foreground">
			Files you and the model create in your own storage on Redstart Nest. Only you can see these —
			other accounts have their own. Deleted items go to the recycle bin.
		</p>
	</div>

	{#if browsers.length > 1}
		<!-- One tab per place files actually live. Two of them exist on the server
		     because two capabilities write to separately configured folders, and
		     inside Twig there is a third on the user's own machine — so a file's
		     location depends on which tool made it. The description says which;
		     the labels alone cannot. -->
		<div class="space-y-1.5">
			<div class="flex flex-wrap gap-1.5">
				{#each browsers as b (b.id)}
					<Button
						variant={b.id === space ? 'secondary' : 'ghost'}
						size="sm"
						onclick={() => openSpace(b.id)}
					>
						{b.label}
					</Button>
				{/each}
			</div>
			{#if browser?.description}
				<p class="text-xs text-muted-foreground">{browser.description}</p>
			{/if}
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<!-- Up doubles as a drop target, so dragging something OUT of a folder is
		     possible without navigating away from it first. -->
		<button
			type="button"
			class="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors
				{atRoot
				? 'cursor-not-allowed border-transparent text-muted-foreground/40'
				: 'cursor-pointer border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground'}
				{!atRoot && dropTarget === parentPath ? 'border-primary bg-primary/10 text-foreground' : ''}"
			disabled={atRoot}
			onclick={() => navigate(parentPath)}
			ondragover={(e) => !atRoot && onDragOver(e, parentPath)}
			ondragleave={onDragLeave}
			ondrop={(e) => !atRoot && onDrop(e, parentPath)}
			aria-label="Go up one folder"
		>
			<ArrowUp class="h-3 w-3 shrink-0" />
			Up
		</button>

		<div class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
			<button
				type="button"
				class="cursor-pointer rounded px-1 py-0.5 transition-colors hover:text-foreground
					{dropTarget === '.' ? 'bg-primary/10 text-foreground' : ''}"
				onclick={() => navigate('.')}
				ondragover={(e) => onDragOver(e, '.')}
				ondragleave={onDragLeave}
				ondrop={(e) => onDrop(e, '.')}
			>
				Home
			</button>
			{#each crumbs as crumb, i (i)}
				<ChevronRight class="h-3 w-3 shrink-0" />
				<button
					type="button"
					class="cursor-pointer rounded px-1 py-0.5 transition-colors hover:text-foreground
						{dropTarget === crumbPath(i) ? 'bg-primary/10 text-foreground' : ''}"
					onclick={() => navigate(crumbPath(i))}
					ondragover={(e) => onDragOver(e, crumbPath(i))}
					ondragleave={onDragLeave}
					ondrop={(e) => onDrop(e, crumbPath(i))}
				>
					{crumb}
				</button>
			{/each}
		</div>
	</div>

	<div class="flex flex-wrap gap-1.5">
		{#if browser?.upload}
			<Button variant="outline" size="sm" onclick={() => uploadInput?.click()}>
				<Upload class="h-3.5 w-3.5" /> Upload
			</Button>
		{/if}
		<Button variant="outline" size="sm" onclick={newFolder}>
			<FolderPlus class="h-3.5 w-3.5" /> New folder
		</Button>
		<input
			bind:this={uploadInput}
			type="file"
			class="hidden"
			onchange={onUpload}
			aria-label="Upload a file"
		/>
	</div>

	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{/if}
	{#if notice}
		<p class="text-xs text-muted-foreground">{notice}</p>
	{/if}

	{#if selected.size > 0}
		<div
			class="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs"
		>
			<span class="flex-1">
				{selected.size} selected — drag any of them to move the whole set.
			</span>
			<Button variant="ghost" size="sm" onclick={clearSelection}>Clear</Button>
		</div>
	{/if}

	<!-- The list is itself a drop zone for files dragged in from the OS, which
	     land in the folder currently open. Row-level drops stopPropagation so a
	     file dropped ON a folder goes into that folder instead. -->
	<div
		class="rounded-md border transition-colors {uploadTarget !== null
			? 'border-primary bg-primary/5'
			: 'border-border/60'}"
		role="region"
		aria-label="Files in this folder"
		ondragover={(e) => onDragOver(e, path)}
		ondragleave={onDragLeave}
		ondrop={(e) => onDrop(e, path)}
	>
		{#if uploadTarget !== null}
			<p
				class="flex items-center gap-2 border-b border-primary/30 px-3 py-2 text-xs text-foreground"
			>
				<Upload class="h-3.5 w-3.5 shrink-0" />
				Drop to upload into {uploadTarget === '.' ? 'this folder' : uploadTarget}
			</p>
		{/if}
		{#if loading}
			<p class="flex items-center gap-2 p-4 text-sm text-muted-foreground">
				<Loader class="h-4 w-4 animate-spin" /> Loading…
			</p>
		{:else if entries.length === 0}
			<p class="p-4 text-sm text-muted-foreground">This folder is empty.</p>
		{:else}
			<ul class="divide-y divide-border/60">
				{#each entries as entry (entry.path)}
					<!-- The row is the drag handle (grab anywhere) and, for folders, the
					     drop target. Both live on the <li> so the whole row highlights
					     rather than only the name. -->
					<li
						class="flex items-center gap-2 px-3 py-2 text-sm transition-colors
							{draggingPaths.includes(entry.path) ? 'opacity-40' : ''}
							{selected.has(entry.path) ? 'bg-muted/50' : ''}
							{entry.type === 'folder' && (dropTarget === entry.path || uploadTarget === entry.path)
							? 'bg-primary/10 ring-1 ring-primary/40 ring-inset'
							: ''}"
						draggable="true"
						ondragstart={(e) => startDrag(e, entry)}
						ondragend={endDrag}
						ondragover={(e) => entry.type === 'folder' && onDragOver(e, entry.path)}
						ondragleave={() => entry.type === 'folder' && onDragLeave()}
						ondrop={(e) => entry.type === 'folder' && onDrop(e, entry.path)}
					>
						<Checkbox
							checked={selected.has(entry.path)}
							onCheckedChange={() => toggleSelect(entry.path)}
							aria-label="Select {entry.name}"
							class="shrink-0"
						/>

						{#if entry.type === 'folder'}
							<Folder class="h-4 w-4 shrink-0 text-muted-foreground" />
							<button
								type="button"
								class="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
								onclick={() => navigate(entry.path)}
							>
								{entry.name}
							</button>
						{:else}
							<FileIcon class="h-4 w-4 shrink-0 text-muted-foreground" />
							{#if entry.previewable}
								<button
									type="button"
									class="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline"
									onclick={() => showPreview(entry)}
								>
									{entry.name}
								</button>
							{:else}
								<span class="min-w-0 flex-1 truncate">{entry.name}</span>
							{/if}
							<span class="shrink-0 text-xs text-muted-foreground">{formatSize(entry.size)}</span>
						{/if}

						<div class="flex shrink-0 items-center gap-0.5">
							<!-- Local files are already on this machine — there is nothing to
							     download, so the control is absent rather than inert. -->
							{#if entry.type === 'file' && browser?.downloadUrl}
								<a
									href={browser.downloadUrl(entry.path)}
									download={entry.name}
									class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
									aria-label="Download {entry.name}"
								>
									<Download class="h-3.5 w-3.5" />
								</a>
							{/if}
							<button
								type="button"
								class="cursor-pointer rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
								onclick={() => renameEntry(entry)}
							>
								Rename
							</button>
							<button
								type="button"
								class="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
								onclick={() => removeEntry(entry)}
								aria-label="Delete {entry.name}"
							>
								<Trash2 class="h-3.5 w-3.5" />
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	{#if preview}
		<div class="rounded-md border border-border/60">
			<div class="flex items-center justify-between border-b border-border/60 px-3 py-2">
				<span class="truncate text-sm font-medium">{preview.name}</span>
				<button
					type="button"
					class="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
					onclick={() => (preview = null)}
					aria-label="Close preview"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</div>
			<pre class="max-h-96 overflow-auto p-3 text-xs whitespace-pre-wrap">{preview.text}</pre>
			{#if preview.truncated}
				<p class="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
					Preview truncated — download the file to see all of it.
				</p>
			{/if}
		</div>
	{/if}
</div>
