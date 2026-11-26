<script lang="ts">
	/**
	 * One project (projects-plan Phase 2): its chats, its instructions, its own
	 * memory and its files folder, plus New chat and Delete.
	 *
	 * A project can be shared (2026-11-24): `project.access` says what the
	 * signed-in account may do. Viewers see everything read-only; editors also
	 * change it; the owner (or an admin who manages every project) also shares,
	 * hands over and deletes it. Nest answers 404 to anyone it isn't shared
	 * with. Chats listed here are the viewer's own — chats are never shared.
	 * Deleting moves each person's chats in it out to their ordinary list,
	 * deletes its memories and leaves its files folder on the server.
	 */
	import { goto } from '$app/navigation';
	import {
		FolderKanban,
		Loader,
		MessageSquare,
		Plus,
		Trash2,
		Brain,
		FileText,
		Upload,
		Download,
		X,
		Pencil,
		Share2,
		Eye,
		AppWindow
	} from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { DialogConfirmation } from '$lib/components/app';
	import { ROUTES } from '$lib/constants/routes';
	import { RouterService } from '$lib/services/router.service';
	import {
		ProjectService,
		canEditProject,
		canManageProject,
		type Project
	} from '$lib/services/project.service';
	import ProjectShareDialog from './ProjectShareDialog.svelte';
	import { ArtifactsGallery } from '$lib/components/app/artifacts';
	import { ProjectTasks } from '$lib/components/app/tasks';
	import { MemoryService, type Memory } from '$lib/services/memory.service';
	import { FilesService, type FileEntry } from '$lib/services/files.service';
	import { projectsStore } from '$lib/stores/projects.svelte';
	import { conversations } from '$lib/stores/conversations.svelte';

	interface Props {
		id: string;
	}

	let { id }: Props = $props();

	let project = $state<Project | null>(null);
	let loading = $state(true);
	let notFound = $state(false);

	let instructionsDraft = $state('');
	let savingInstructions = $state(false);
	let renaming = $state(false);
	let nameDraft = $state('');

	let memories = $state<Memory[]>([]);
	let memoryDraft = $state('');
	let memoryError = $state('');

	let files = $state<FileEntry[]>([]);
	let filesError = $state('');
	let uploading = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();

	let showDelete = $state(false);
	let showShare = $state(false);

	const canEdit = $derived(canEditProject(project));
	const canManage = $derived(canManageProject(project));
	// An older Nest sends no members or access: read that as the owner's own project.
	const shared = $derived(
		!!project && ((project.members?.length ?? 0) > 0 || (project.access ?? 'owner') !== 'owner')
	);

	let chats = $derived(
		conversations()
			.filter((c) => c.projectId === id)
			.sort((a, b) => b.lastModified - a.lastModified)
	);
	let instructionsChanged = $derived(!!project && instructionsDraft !== project.instructions);

	$effect(() => {
		void load(id);
	});

	async function load(projectId: string) {
		loading = true;
		notFound = false;
		try {
			project = await ProjectService.get(projectId);
			instructionsDraft = project.instructions;
			nameDraft = project.name;
			void projectsStore.ensureLoaded();
			await Promise.all([loadMemories(), loadFiles()]);
		} catch {
			project = null;
			notFound = true;
		} finally {
			loading = false;
		}
	}

	async function loadMemories() {
		try {
			memories = await MemoryService.list(id);
			memoryError = '';
		} catch (e) {
			memoryError = e instanceof Error ? e.message : 'Could not load memories';
		}
	}

	async function loadFiles() {
		if (!project) return;
		try {
			files = (await FilesService.list(project.folder, '.')).entries;
			filesError = '';
		} catch (e) {
			files = [];
			filesError =
				e instanceof Error ? e.message : 'Files are not available (no Documents folder?)';
		}
	}

	async function saveInstructions() {
		if (!project) return;
		savingInstructions = true;
		try {
			project = await projectsStore.update(id, { instructions: instructionsDraft });
			instructionsDraft = project.instructions;
			toast.success('Instructions saved');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			savingInstructions = false;
		}
	}

	// AGENTS.md (master plan Phase 5): an imported file goes into the draft, not
	// straight to the server, so it is read before Save replaces anything.
	let agentsMdInput = $state<HTMLInputElement | null>(null);

	async function importAgentsMd(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		const text = (await file.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
		const max = projectsStore.limits?.maxInstructionsChars;
		if (max && text.length > max) {
			toast.error(`That AGENTS.md is ${text.length} characters; instructions are at most ${max}.`);
			return;
		}
		instructionsDraft = text;
		toast.success('AGENTS.md loaded. Review it, then Save to replace the instructions.');
	}

	async function exportAgentsMd() {
		try {
			await ProjectService.exportAgentsMd(id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not export');
		}
	}

	async function saveName() {
		if (!project || !nameDraft.trim() || nameDraft.trim() === project.name) {
			renaming = false;
			return;
		}
		try {
			project = await projectsStore.update(id, { name: nameDraft.trim() });
			renaming = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not rename');
		}
	}

	async function addMemory() {
		const text = memoryDraft.trim();
		if (!text) return;
		try {
			const m = await MemoryService.create(text, null, id);
			memoryDraft = '';
			if (m.duplicate) toast.info('Already remembered');
			await loadMemories();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not save that memory');
		}
	}

	async function forget(memory: Memory) {
		try {
			await MemoryService.remove(memory.id, id);
			memories = memories.filter((m) => m.id !== memory.id);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not forget it');
		}
	}

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const picked = Array.from(input.files ?? []);
		input.value = '';
		if (!project || picked.length === 0) return;
		uploading = true;
		try {
			for (const file of picked) {
				await FilesService.upload(project.folder, '.', file);
			}
			toast.success(
				picked.length === 1 ? `Added ${picked[0].name}` : `Added ${picked.length} files`
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Upload failed');
		} finally {
			uploading = false;
			await loadFiles();
		}
	}

	async function confirmDelete() {
		showDelete = false;
		try {
			const r = await projectsStore.remove(id);
			toast.success(
				r.chatsMovedOut === 1
					? 'Project deleted. Its chat is in your chat list.'
					: `Project deleted. Its ${r.chatsMovedOut} chats are in your chat list.`
			);
			await goto(ROUTES.PROJECTS);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the project');
		}
	}

	function formatDate(ts: number) {
		return new Date(ts).toLocaleDateString();
	}
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6 md:pt-28">
	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader class="h-4 w-4 animate-spin" /> Loading project…
		</div>
	{:else if notFound || !project}
		<div class="space-y-2">
			<p class="text-sm text-muted-foreground">
				This project doesn't exist, or isn't shared with you.
			</p>
			<a class="text-sm underline" href={ROUTES.PROJECTS}>All projects</a>
		</div>
	{:else}
		<div class="flex items-center gap-3">
			<FolderKanban class="h-6 w-6 shrink-0" />

			<div class="min-w-0 flex-1">
				{#if renaming}
					<Input
						bind:value={nameDraft}
						maxlength={projectsStore.limits?.maxNameChars}
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') saveName();
							if (e.key === 'Escape') renaming = false;
						}}
						onblur={saveName}
						aria-label="Project name"
					/>
				{:else}
					<button
						class="group flex max-w-full items-center gap-2 text-left"
						onclick={() => canEdit && (renaming = true)}
						title={canEdit ? 'Rename' : undefined}
						disabled={!canEdit}
					>
						<h1 class="truncate text-lg font-semibold">{project.name}</h1>
						{#if canEdit}<Pencil
								class="h-3.5 w-3.5 shrink-0 opacity-0 group-hover:opacity-60"
							/>{/if}
					</button>
				{/if}
				<div class="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
					<a class="hover:underline" href={ROUTES.PROJECTS}>All projects</a>
					{#if project.access && project.access !== 'owner' && project.ownerName}
						<span>· shared by {project.ownerName}</span>
					{/if}
					{#if project.access === 'viewer'}
						<span class="flex items-center gap-1"><Eye class="h-3 w-3" /> you can view</span>
					{:else if project.access === 'editor'}
						<span>· you can edit</span>
					{:else if project.access === 'admin'}
						<span>· you manage every project</span>
					{:else if project.members?.length}
						<span>· shared with {project.members.length}</span>
					{/if}
				</div>
			</div>

			<Button size="sm" onclick={() => goto(RouterService.newChatInProject(id))}>
				<Plus class="h-3 w-3" /> New chat
			</Button>
			{#if canManage}
				<Button size="sm" variant="outline" onclick={() => (showShare = true)}>
					<Share2 class="h-3 w-3" /> Share
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => (showDelete = true)}
					aria-label="Delete project"
				>
					<Trash2 class="h-4 w-4" />
				</Button>
			{/if}
		</div>

		<section class="space-y-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium">
				<MessageSquare class="h-4 w-4" />
				{shared ? 'Your chats' : 'Chats'}
			</h2>
			{#if chats.length === 0}
				<div class="text-sm text-muted-foreground italic">
					No chats yet. Start one with New chat, or move a chat here from its menu in the sidebar.
				</div>
			{:else}
				<ul class="divide-y rounded-lg border">
					{#each chats as chat (chat.id)}
						<li>
							<a
								href={RouterService.chat(chat.id)}
								class="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-accent/50"
							>
								<span class="truncate">{chat.name}</span>
								<span class="shrink-0 text-xs text-muted-foreground"
									>{formatDate(chat.lastModified)}</span
								>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Tasks (tasks plan Phase 1): everyone in the project sees them; editors
		     add and assign them; whoever has one can finish it. -->
		<ProjectTasks projectId={project.id} canAdd={canEdit} />

		<section class="space-y-2">
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-sm font-medium">Instructions</h2>
				<div class="flex gap-1" class:hidden={!canEdit}>
					<input
						type="file"
						accept=".md,text/markdown,text/plain"
						class="hidden"
						bind:this={agentsMdInput}
						onchange={importAgentsMd}
					/>
					<Button
						size="sm"
						variant="ghost"
						onclick={() => agentsMdInput?.click()}
						title="Load an AGENTS.md file into the instructions (review, then Save)"
					>
						<Upload class="h-3 w-3" /> AGENTS.md
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onclick={exportAgentsMd}
						disabled={!project?.instructions}
						title="Download the saved instructions as AGENTS.md, for other agents"
					>
						<Download class="h-3 w-3" /> AGENTS.md
					</Button>
				</div>
			</div>
			<Textarea
				bind:value={instructionsDraft}
				readonly={!canEdit}
				rows={6}
				maxlength={projectsStore.limits?.maxInstructionsChars}
				placeholder="What every chat in this project should know or do."
			/>
			<div class="flex items-center justify-between gap-2">
				<span class="text-xs text-muted-foreground">
					Added to every chat in this project. They guide the assistant's work here but can't change
					its rules or permissions.
				</span>
				{#if canEdit}
					<Button
						size="sm"
						onclick={saveInstructions}
						disabled={!instructionsChanged || savingInstructions}
					>
						{#if savingInstructions}<Loader class="h-4 w-4 animate-spin" />{/if} Save
					</Button>
				{/if}
			</div>
		</section>

		<section class="space-y-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium">
				<Brain class="h-4 w-4" /> Project memory
			</h2>
			<p class="text-xs text-muted-foreground">
				Facts about this project, shared by its chats{shared ? ' and everyone in it' : ''}. The
				assistant can add to it{canEdit ? '' : ' when an editor is chatting'}; it's deleted with the
				project.
			</p>
			{#if memoryError}
				<div class="text-sm text-destructive">{memoryError}</div>
			{/if}
			<div class="flex gap-2" class:hidden={!canEdit}>
				<Input
					bind:value={memoryDraft}
					placeholder="The billing service deploys on Fridays"
					maxlength={500}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && addMemory()}
				/>
				<Button size="sm" variant="outline" onclick={addMemory} disabled={!memoryDraft.trim()}>
					<Plus class="h-3 w-3" /> Add
				</Button>
			</div>
			{#if memories.length > 0}
				<ul class="space-y-1">
					{#each memories as memory (memory.id)}
						<li class="flex items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent/30">
							<span class="flex-1">{memory.text}</span>
							{#if canEdit}
								<button
									class="text-muted-foreground hover:text-foreground"
									onclick={() => forget(memory)}
									aria-label="Forget"
								>
									<X class="h-3.5 w-3.5" />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h2 class="flex items-center gap-1.5 text-sm font-medium">
					<FileText class="h-4 w-4" /> Files
				</h2>
				{#if !filesError && canEdit}
					<input bind:this={fileInput} type="file" multiple class="hidden" onchange={upload} />
					<Button
						size="sm"
						variant="outline"
						onclick={() => fileInput?.click()}
						disabled={uploading}
					>
						{#if uploading}<Loader class="h-3 w-3 animate-spin" />{:else}<Upload
								class="h-3 w-3"
							/>{/if} Add files
					</Button>
				{/if}
			</div>
			<p class="text-xs text-muted-foreground">
				The project's own folder{shared ? ', shared by everyone in it' : ''}. Chats in this project
				search these first.
			</p>
			{#if filesError}
				<div class="text-sm text-muted-foreground">{filesError}</div>
			{:else if files.length === 0}
				<div class="text-sm text-muted-foreground italic">No files yet.</div>
			{:else}
				<ul class="space-y-1">
					{#each files as file (file.path)}
						<li class="flex items-center gap-2 px-2 py-1 text-sm">
							<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<span class="truncate">{file.name}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Artifacts in the project (artifacts plan §10). A viewer's New makes
		     one of their own (D6); the gallery says what each person may do. -->
		<section class="space-y-2">
			<h2 class="flex items-center gap-1.5 text-sm font-medium">
				<AppWindow class="h-4 w-4" />
				Artifacts
			</h2>
			<ArtifactsGallery projectId={project.id} canAdd={canEdit} compact />
		</section>
	{/if}
</div>

{#if project && canManage}
	<ProjectShareDialog
		bind:open={showShare}
		{project}
		onChanged={(p) => {
			project = p;
			void projectsStore.refresh();
		}}
	/>
{/if}

<DialogConfirmation
	bind:open={showDelete}
	title="Delete project"
	description={project
		? `Delete "${project.name}"? Everyone's chats in it move back to their own chat lists, and its project memory is deleted. Its tasks stay, outside any project. Its files stay in its folder on the server.`
		: ''}
	confirmText="Delete project"
	cancelText="Cancel"
	variant="destructive"
	icon={Trash2}
	onConfirm={confirmDelete}
	onCancel={() => (showDelete = false)}
/>
