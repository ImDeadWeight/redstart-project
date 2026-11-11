<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Trash2,
		Pencil,
		Pin,
		X,
		LogOut,
		FolderKanban,
		FolderInput,
		ChevronRight,
		Plus
	} from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { projectsStore } from '$lib/stores/projects.svelte';
	import { Button } from '$lib/components/ui/button';
	import { DialogConfirmation } from '$lib/components/app';
	import SidebarNavigationActions from './SidebarNavigationActions.svelte';
	import SidebarNavigationConversationItem from './SidebarNavigationConversationItem.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import Label from '$lib/components/ui/label/label.svelte';
	import ScrollArea from '$lib/components/ui/scroll-area/scroll-area.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import Input from '$lib/components/ui/input/input.svelte';
	import { ROUTES } from '$lib/constants/routes';
	import { RouterService } from '$lib/services/router.service';
	import {
		conversationsStore,
		conversations,
		buildConversationTree
	} from '$lib/stores/conversations.svelte';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { authStore } from '$lib/stores/auth.svelte';
	import { getPreviewText } from '$lib/utils';
	import { APP_NAME } from '$lib/constants';

	const sidebar = Sidebar.useSidebar();

	let currentChatId = $derived(page.params.id);
	let isSearchModeActive = $state(false);
	let searchQuery = $state('');
	let showDeleteDialog = $state(false);
	let deleteWithForks = $state(false);
	let showEditDialog = $state(false);
	let selectedConversation = $state<DatabaseConversation | null>(null);
	let editedName = $state('');
	let selectedConversationNamePreview = $derived.by(() =>
		selectedConversation ? getPreviewText(selectedConversation.name) : ''
	);

	let filteredConversations = $derived.by(() => {
		if (isSearchModeActive) {
			if (searchQuery.trim().length > 0) {
				return conversations().filter((conversation: { name: string }) =>
					conversation.name.toLowerCase().includes(searchQuery.toLowerCase())
				);
			}

			return [];
		}

		return conversations();
	});

	let conversationTree = $derived(buildConversationTree(filteredConversations));

	let pinnedConversations = $derived.by(() => {
		return conversationTree.filter(({ conversation }) => conversation.pinned);
	});

	// A chat in a known project is listed under that project, not in Recent,
	// so nothing appears twice (projects-plan Phase 2). One pointing at a
	// project this client does not know (deleted elsewhere, list not loaded
	// yet) stays in Recent rather than vanishing. Pinned wins over both.
	function inKnownProject(c: DatabaseConversation): boolean {
		return !!c.projectId && !!projectsStore.byId(c.projectId);
	}

	let unpinnedConversations = $derived.by(() => {
		return conversationTree.filter(
			({ conversation }) => !conversation.pinned && !inKnownProject(conversation)
		);
	});

	let projectGroups = $derived.by(() =>
		projectsStore.projects.map((project) => ({
			project,
			chats: buildConversationTree(
				conversations().filter((c) => c.projectId === project.id && !c.pinned)
			)
		}))
	);

	// Which projects are open in the sidebar. The one holding the open chat
	// opens itself; the rest stay as the user left them.
	let expandedProjects = $state<Record<string, boolean>>({});
	$effect(() => {
		const active = conversations().find((c) => c.id === currentChatId);
		if (active?.projectId && expandedProjects[active.projectId] === undefined) {
			expandedProjects[active.projectId] = true;
		}
	});

	$effect(() => {
		void projectsStore.ensureLoaded();
	});

	// The move-to-project chooser.
	let showMoveDialog = $state(false);
	let moveTarget = $state<string>('');

	function handleMoveConversation(id: string) {
		const conversation = conversations().find((conv) => conv.id === id);
		if (!conversation) return;
		selectedConversation = conversation;
		moveTarget = conversation.projectId ?? '';
		showMoveDialog = true;
	}

	async function handleConfirmMove() {
		const conversation = selectedConversation;
		showMoveDialog = false;
		if (!conversation) return;
		const target = moveTarget || null;
		if ((conversation.projectId ?? null) === target) return;
		try {
			await conversationsStore.moveToProject(conversation.id, target);
			const name = target ? projectsStore.byId(target)?.name : null;
			toast.success(name ? `Moved to ${name}` : 'Moved out of its project');
			if (target) expandedProjects[target] = true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not move the chat');
		} finally {
			selectedConversation = null;
		}
	}

	let selectedConversationHasDescendants = $derived.by(() => {
		if (!selectedConversation) return false;

		const allConvs = conversations();
		const queue = [selectedConversation.id];

		while (queue.length > 0) {
			const parentId = queue.pop()!;

			for (const c of allConvs) {
				if (c.forkedFromConversationId === parentId) return true;
			}
		}

		return false;
	});

	async function handleDeleteConversation(id: string) {
		const conversation = conversations().find((conv) => conv.id === id);
		if (conversation) {
			selectedConversation = conversation;
			deleteWithForks = false;
			showDeleteDialog = true;
		}
	}

	async function handleEditConversation(id: string) {
		const conversation = conversations().find((conv) => conv.id === id);
		if (conversation) {
			selectedConversation = conversation;
			editedName = conversation.name;
			showEditDialog = true;
		}
	}

	function handleConfirmDelete() {
		if (selectedConversation) {
			const convId = selectedConversation.id;
			const withForks = deleteWithForks;
			showDeleteDialog = false;

			setTimeout(() => {
				conversationsStore.deleteConversation(convId, {
					deleteWithForks: withForks
				});
			}, 100); // Wait for animation to finish
		}
	}

	function handleConfirmEdit() {
		if (!editedName.trim() || !selectedConversation) return;

		showEditDialog = false;

		conversationsStore.renameConversationByUser(selectedConversation.id, editedName);
		selectedConversation = null;
	}

	export function handleMobileSidebarItemClick() {
		if (sidebar.isMobile) {
			sidebar.toggle();
		}
	}

	let chatSidebarActions: { activateSearch?: () => void } | undefined = $state();
	let openedForSearch = $state(false);

	export function activateSearchMode() {
		if (!sidebar.open) {
			openedForSearch = true;
		}
		chatSidebarActions?.activateSearch?.();
	}

	function handleSearchDeactivated() {
		if (openedForSearch) {
			openedForSearch = false;
			sidebar.toggle();
		}
	}

	$effect(() => {
		if (!sidebar.open) {
			isSearchModeActive = false;
			searchQuery = '';
			openedForSearch = false;
		}
	});

	export function editActiveConversation() {
		if (currentChatId) {
			const activeConversation = filteredConversations.find((conv) => conv.id === currentChatId);

			if (activeConversation) {
				const event = new CustomEvent('edit-active-conversation', {
					detail: { conversationId: currentChatId }
				});
				document.dispatchEvent(event);
			}
		}
	}

	async function selectConversation(id: string) {
		if (isSearchModeActive) {
			isSearchModeActive = false;
			searchQuery = '';
		}

		handleMobileSidebarItemClick();
		await goto(RouterService.chat(id));
	}

	function handleStopGeneration(id: string) {
		chatStore.stopGenerationForChat(id);
	}

	async function handleLogout() {
		handleMobileSidebarItemClick();
		await authStore.logout();
	}
</script>

{#snippet conversationRow(conversation: DatabaseConversation, depth: number)}
	<SidebarNavigationConversationItem
		conversation={{
			id: conversation.id,
			name: conversation.name,
			lastModified: conversation.lastModified,
			currNode: conversation.currNode,
			forkedFromConversationId: conversation.forkedFromConversationId,
			pinned: conversation.pinned,
			projectId: conversation.projectId
		}}
		{depth}
		isActive={currentChatId === conversation.id}
		onSelect={selectConversation}
		onEdit={handleEditConversation}
		onDelete={handleDeleteConversation}
		onStop={handleStopGeneration}
		onMove={handleMoveConversation}
	/>
{/snippet}

<div class="flex h-full flex-col">
	<ScrollArea class="h-full flex-1">
		<Sidebar.Header class="gap-4 bg-sidebar/50 p-3 backdrop-blur-lg md:pt-4 md:pb-2">
			<div class="flex items-center justify-between gap-2">
				<a href={ROUTES.START} onclick={handleMobileSidebarItemClick}>
					<h1 class="inline-flex items-center gap-1 px-2 text-xl font-semibold">
						{APP_NAME}
					</h1>
				</a>

				<div class="flex items-center gap-1">
					<Button
						class="rounded-full md:hidden"
						variant="ghost"
						size="icon"
						onclick={() => sidebar.toggle()}
					>
						<X class="h-4 w-4" />
						<span class="sr-only">Close sidebar</span>
					</Button>
				</div>
			</div>

			<SidebarNavigationActions
				bind:this={chatSidebarActions}
				{handleMobileSidebarItemClick}
				bind:isSearchModeActive
				bind:searchQuery
				onSearchDeactivated={handleSearchDeactivated}
			/>
		</Sidebar.Header>

		{#if !isSearchModeActive && pinnedConversations.length > 0}
			<Sidebar.Group class="p-0 px-4">
				<Sidebar.GroupLabel>
					<div class="flex items-center gap-1">
						<Pin class="h-3.5 w-3.5" />
						<span>Pinned</span>
					</div>
				</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each pinnedConversations as { conversation, depth } (conversation.id)}
							<Sidebar.MenuItem class="mb-1 p-0">
								{@render conversationRow(conversation, depth)}
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}

		{#if !isSearchModeActive && projectGroups.length > 0}
			<Sidebar.Group class="mt-2 p-0 px-3">
				<Sidebar.GroupLabel>
					<div class="flex w-full items-center justify-between gap-1">
						<a href={ROUTES.PROJECTS} class="flex items-center gap-1 hover:text-foreground">
							<FolderKanban class="h-3.5 w-3.5" />
							<span>Projects</span>
						</a>
					</div>
				</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each projectGroups as { project, chats } (project.id)}
							{@const open = !!expandedProjects[project.id]}
							<Sidebar.MenuItem class="p-0">
								<div
									class="group/project flex min-h-8 items-center gap-1 rounded-lg px-1 hover:bg-foreground/10"
								>
									<button
										class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
										onclick={() => (expandedProjects[project.id] = !open)}
										aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`}
										aria-expanded={open}
									>
										<ChevronRight
											class="h-3.5 w-3.5 transition-transform {open ? 'rotate-90' : ''}"
										/>
									</button>
									<a
										href={RouterService.project(project.id)}
										onclick={handleMobileSidebarItemClick}
										class="min-w-0 flex-1 truncate py-1 text-sm font-medium"
										title={project.name}
									>
										{project.name}
									</a>
									<a
										href={RouterService.newChatInProject(project.id)}
										onclick={handleMobileSidebarItemClick}
										class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/project:opacity-100 hover:text-foreground focus:opacity-100 max-md:opacity-100"
										aria-label={`New chat in ${project.name}`}
										title="New chat in this project"
									>
										<Plus class="h-3.5 w-3.5" />
									</a>
								</div>
							</Sidebar.MenuItem>
							{#if open}
								{#each chats as { conversation, depth } (conversation.id)}
									<Sidebar.MenuItem class="mb-1 p-0 pl-5">
										{@render conversationRow(conversation, depth)}
									</Sidebar.MenuItem>
								{/each}
								{#if chats.length === 0}
									<div class="py-1 pl-8 text-xs text-muted-foreground italic">No chats yet</div>
								{/if}
							{/if}
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/if}

		<Sidebar.Group class="mt-2 h-[calc(100vh-21rem)] space-y-2 p-0 px-3">
			{#if (filteredConversations.length > 0 && isSearchModeActive) || !isSearchModeActive}
				<Sidebar.GroupLabel>
					{isSearchModeActive ? 'Search results' : 'Recent conversations'}
				</Sidebar.GroupLabel>
			{/if}

			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each isSearchModeActive ? conversationTree : unpinnedConversations as { conversation, depth } (conversation.id)}
						<Sidebar.MenuItem class="mb-1 p-0">
							{@render conversationRow(conversation, depth)}
						</Sidebar.MenuItem>
					{/each}

					{#if (isSearchModeActive ? conversationTree : unpinnedConversations).length === 0}
						<div class="px-2 py-4 text-center">
							<p class="mb-4 p-4 text-sm text-muted-foreground">
								{searchQuery.length > 0
									? 'No results found'
									: isSearchModeActive
										? 'Start typing to see results'
										: 'No conversations yet'}
							</p>
						</div>
					{/if}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</ScrollArea>

	<!--
		Pinned below the scroll area, so it stays put however long the
		conversation list grows. Sits outside ScrollArea deliberately.
	-->
	{#if authStore.user}
		<div class="border-t border-sidebar-border/50 bg-sidebar/50 p-3 backdrop-blur-lg">
			<Button
				class="w-full justify-start gap-2 px-2 backdrop-blur-none!"
				variant="ghost"
				onclick={handleLogout}
			>
				<LogOut class="h-4 w-4 shrink-0" />
				<span>Log out</span>
			</Button>
		</div>
	{/if}
</div>

<DialogConfirmation
	bind:open={showDeleteDialog}
	title="Delete Conversation"
	description={selectedConversation
		? `Are you sure you want to delete "${selectedConversationNamePreview}"? This action cannot be undone and will permanently remove all messages in this conversation.`
		: ''}
	confirmText="Delete"
	cancelText="Cancel"
	variant="destructive"
	icon={Trash2}
	onConfirm={handleConfirmDelete}
	onCancel={() => {
		showDeleteDialog = false;
		selectedConversation = null;
	}}
>
	{#if selectedConversationHasDescendants}
		<div class="flex items-center gap-2 py-2">
			<Checkbox id="delete-with-forks" bind:checked={deleteWithForks} />

			<Label for="delete-with-forks" class="text-sm">Also delete all forked conversations</Label>
		</div>
	{/if}
</DialogConfirmation>

<DialogConfirmation
	bind:open={showMoveDialog}
	title="Move to project"
	description={selectedConversation ? `Where should "${selectedConversationNamePreview}" go?` : ''}
	confirmText="Move"
	cancelText="Cancel"
	icon={FolderInput}
	onConfirm={handleConfirmMove}
	onCancel={() => {
		showMoveDialog = false;
		selectedConversation = null;
	}}
>
	<div class="max-h-64 space-y-1 overflow-y-auto py-1" role="radiogroup">
		<label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/50">
			<input type="radio" name="move-target" value="" bind:group={moveTarget} />
			<span class="text-sm">No project</span>
		</label>
		{#each projectsStore.projects as project (project.id)}
			<label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/50">
				<input type="radio" name="move-target" value={project.id} bind:group={moveTarget} />
				<FolderKanban class="h-3.5 w-3.5 text-muted-foreground" />
				<span class="truncate text-sm">{project.name}</span>
			</label>
		{/each}
		{#if projectsStore.projects.length === 0}
			<p class="px-2 py-1 text-sm text-muted-foreground">
				No projects yet. <a class="underline" href={ROUTES.PROJECTS}>Create one</a>.
			</p>
		{/if}
	</div>
</DialogConfirmation>

<DialogConfirmation
	bind:open={showEditDialog}
	title="Edit Conversation Name"
	description=""
	confirmText="Save"
	cancelText="Cancel"
	icon={Pencil}
	onConfirm={handleConfirmEdit}
	onCancel={() => {
		showEditDialog = false;
		selectedConversation = null;
	}}
	onKeydown={(event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			event.stopImmediatePropagation();
			handleConfirmEdit();
		}
	}}
>
	<Input
		class="text-foreground"
		placeholder="Enter a new name"
		type="text"
		bind:value={editedName}
	/>
</DialogConfirmation>
