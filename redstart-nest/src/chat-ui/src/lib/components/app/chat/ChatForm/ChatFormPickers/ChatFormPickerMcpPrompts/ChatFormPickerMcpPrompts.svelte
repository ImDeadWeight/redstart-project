<script lang="ts">
	/**
	 * The `/` picker. Lists the client's built-in commands first (projects-plan
	 * D2, rows built by ChatForm from $lib/slash-commands) and the MCP prompts
	 * after them — Nest's workflows, plus any other server's prompts. The
	 * prompt half came from llama.cpp's web UI; commands were added beside it,
	 * so a command row is picked through `onCommandPick` and never loads a
	 * prompt.
	 */
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { mcpStore } from '$lib/stores/mcp.svelte';
	import { debounce, uuid } from '$lib/utils';
	import { KeyboardKey } from '$lib/enums';
	import type { MCPPromptInfo, GetPromptResult, MCPServerSettingsEntry } from '$lib/types';
	import { SvelteMap } from 'svelte/reactivity';
	import {
		ChatFormPickerPopover,
		ChatFormPickerList,
		ChatFormPickerListItem,
		ChatFormPickerItemHeader,
		ChatFormPickerListItemSkeleton,
		ChatFormPromptPickerArgumentForm
	} from '$lib/components/app/chat';
	import Badge from '$lib/components/ui/badge/badge.svelte';
	import { usage, type SlashPickerItem } from '$lib/slash-commands';

	interface Props {
		class?: string;
		isOpen?: boolean;
		searchQuery?: string;
		onClose?: () => void;
		onPromptLoadStart?: (
			placeholderId: string,
			promptInfo: MCPPromptInfo,
			args?: Record<string, string>
		) => void;
		onPromptLoadComplete?: (placeholderId: string, result: GetPromptResult) => void;
		onPromptLoadError?: (placeholderId: string, error: string) => void;
		/** Built-in command rows, listed above the prompts. */
		commandItems?: SlashPickerItem[];
		/** False while a command is being typed (`/model gpt`): prompts hide. */
		showPrompts?: boolean;
		onCommandPick?: (item: SlashPickerItem) => void;
	}

	type Row = { kind: 'builtin'; item: SlashPickerItem } | { kind: 'prompt'; prompt: MCPPromptInfo };

	let {
		class: className = '',
		isOpen = false,
		searchQuery = '',
		onClose,
		onPromptLoadStart,
		onPromptLoadComplete,
		onPromptLoadError,
		commandItems = [],
		showPrompts = true,
		onCommandPick
	}: Props = $props();

	let prompts = $state<MCPPromptInfo[]>([]);
	let isLoading = $state(false);
	let selectedPrompt = $state<MCPPromptInfo | null>(null);
	let promptArgs = $state<Record<string, string>>({});
	let selectedIndex = $state(0);
	let internalSearchQuery = $state('');
	let promptError = $state<string | null>(null);
	let selectedIndexBeforeArgumentForm = $state<number | null>(null);

	let suggestions = $state<Record<string, string[]>>({});
	let loadingSuggestions = $state<Record<string, boolean>>({});
	let activeAutocomplete = $state<string | null>(null);
	let autocompleteIndex = $state(0);

	let serverSettingsMap = $derived.by(() => {
		const servers = mcpStore.getServers();
		const map = new SvelteMap<string, MCPServerSettingsEntry>();

		for (const server of servers) {
			map.set(server.id, server);
		}

		return map;
	});

	$effect(() => {
		if (isOpen) {
			loadPrompts();
			selectedIndex = 0;
		} else {
			selectedPrompt = null;
			promptArgs = {};
			promptError = null;
		}
	});

	$effect(() => {
		if (rows.length > 0 && selectedIndex >= rows.length) {
			selectedIndex = 0;
		}
	});

	async function loadPrompts() {
		isLoading = true;

		try {
			const perChatOverrides = conversationsStore.getAllMcpServerOverrides();

			const initialized = await mcpStore.ensureInitialized(perChatOverrides);

			if (!initialized) {
				prompts = [];

				return;
			}

			prompts = await mcpStore.getAllPrompts();
		} catch (error) {
			console.error('[ChatFormPickerMcpPrompts] Failed to load prompts:', error);
			prompts = [];
		} finally {
			isLoading = false;
		}
	}

	function handlePromptClick(prompt: MCPPromptInfo) {
		const args = prompt.arguments ?? [];

		if (args.length > 0) {
			selectedIndexBeforeArgumentForm = selectedIndex;
			selectedPrompt = prompt;
			promptArgs = {};
			promptError = null;

			requestAnimationFrame(() => {
				const firstInput = document.querySelector(`#arg-${args[0].name}`) as HTMLInputElement;
				if (firstInput) {
					firstInput.focus();
				}
			});
		} else {
			executePrompt(prompt, {});
		}
	}

	async function executePrompt(prompt: MCPPromptInfo, args: Record<string, string>) {
		promptError = null;

		const placeholderId = uuid();

		const nonEmptyArgs = Object.fromEntries(
			Object.entries(args).filter(([, value]) => value.trim() !== '')
		);
		const argsToPass = Object.keys(nonEmptyArgs).length > 0 ? nonEmptyArgs : undefined;

		onPromptLoadStart?.(placeholderId, prompt, argsToPass);
		onClose?.();

		try {
			const result = await mcpStore.getPrompt(prompt.serverName, prompt.name, args);
			onPromptLoadComplete?.(placeholderId, result);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error executing prompt';
			onPromptLoadError?.(placeholderId, errorMessage);
		}
	}

	function handleArgumentSubmit(event: SubmitEvent) {
		event.preventDefault();

		if (selectedPrompt) {
			executePrompt(selectedPrompt, promptArgs);
		}
	}

	const fetchCompletions = debounce(async (argName: string, value: string) => {
		if (!selectedPrompt || value.length < 1) {
			suggestions[argName] = [];

			return;
		}

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log('[ChatFormPickerMcpPrompts] Fetching completions for:', {
				serverName: selectedPrompt.serverName,
				promptName: selectedPrompt.name,
				argName,
				value
			});
		}

		loadingSuggestions[argName] = true;

		try {
			const result = await mcpStore.getPromptCompletions(
				selectedPrompt.serverName,
				selectedPrompt.name,
				argName,
				value
			);

			if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
				console.log('[ChatFormPickerMcpPrompts] Autocomplete result:', {
					argName,
					value,
					result,
					suggestionsCount: result?.values.length ?? 0
				});
			}

			if (result && result.values.length > 0) {
				// Filter out empty strings from suggestions
				const filteredValues = result.values.filter((v) => v.trim() !== '');

				if (filteredValues.length > 0) {
					suggestions[argName] = filteredValues;
					activeAutocomplete = argName;
					autocompleteIndex = 0;
				} else {
					suggestions[argName] = [];
				}
			} else {
				suggestions[argName] = [];
			}
		} catch (error) {
			console.error('[ChatFormPickerMcpPrompts] Failed to fetch completions:', error);
			suggestions[argName] = [];
		} finally {
			loadingSuggestions[argName] = false;
		}
	}, 200);

	function handleArgInput(argName: string, value: string) {
		promptArgs[argName] = value;
		fetchCompletions(argName, value);
	}

	function selectSuggestion(argName: string, value: string) {
		promptArgs[argName] = value;
		suggestions[argName] = [];
		activeAutocomplete = null;
	}

	function handleArgKeydown(event: KeyboardEvent, argName: string) {
		const argSuggestions = suggestions[argName] ?? [];

		// Handle Escape - return to prompt selection list
		if (event.key === KeyboardKey.ESCAPE) {
			event.preventDefault();
			event.stopPropagation();
			handleCancelArgumentForm();
			return;
		}

		if (argSuggestions.length === 0 || activeAutocomplete !== argName) return;

		if (event.key === KeyboardKey.ARROW_DOWN) {
			event.preventDefault();
			autocompleteIndex = Math.min(autocompleteIndex + 1, argSuggestions.length - 1);
		} else if (event.key === KeyboardKey.ARROW_UP) {
			event.preventDefault();
			autocompleteIndex = Math.max(autocompleteIndex - 1, 0);
		} else if (event.key === KeyboardKey.ENTER && argSuggestions[autocompleteIndex]) {
			event.preventDefault();
			event.stopPropagation();
			selectSuggestion(argName, argSuggestions[autocompleteIndex]);
		}
	}

	function handleArgBlur(argName: string) {
		// Delay to allow click on suggestion
		setTimeout(() => {
			if (activeAutocomplete === argName) {
				suggestions[argName] = [];
				activeAutocomplete = null;
			}
		}, 150);
	}

	function handleArgFocus(argName: string) {
		if ((suggestions[argName]?.length ?? 0) > 0) {
			activeAutocomplete = argName;
		}
	}

	function handleCancelArgumentForm() {
		// Restore the previously selected prompt index
		if (selectedIndexBeforeArgumentForm !== null) {
			selectedIndex = selectedIndexBeforeArgumentForm;
			selectedIndexBeforeArgumentForm = null;
		}
		selectedPrompt = null;
		promptArgs = {};
		promptError = null;
	}

	export function handleKeydown(event: KeyboardEvent): boolean {
		if (!isOpen) return false;

		if (event.key === KeyboardKey.ESCAPE) {
			event.preventDefault();
			if (selectedPrompt) {
				// Return to prompt selection list, keeping the selected prompt active
				handleCancelArgumentForm();
			} else {
				onClose?.();
			}

			return true;
		}

		if (event.key === KeyboardKey.ARROW_DOWN) {
			event.preventDefault();
			if (rows.length > 0) {
				selectedIndex = (selectedIndex + 1) % rows.length;
			}

			return true;
		}

		if (event.key === KeyboardKey.ARROW_UP) {
			event.preventDefault();
			if (rows.length > 0) {
				selectedIndex = selectedIndex === 0 ? rows.length - 1 : selectedIndex - 1;
			}

			return true;
		}

		if (event.key === KeyboardKey.ENTER && !selectedPrompt) {
			// Nothing listed: let Enter through, so `/something` that matches
			// no command or prompt still sends as a message.
			const row = rows[selectedIndex];
			if (!row) return false;
			event.preventDefault();
			handleRowClick(row);

			return true;
		}

		return false;
	}

	let filteredPrompts = $derived.by(() => {
		const sortedServers = mcpStore.getServersSorted();
		const serverOrderMap = new Map(sortedServers.map((server, index) => [server.id, index]));

		const sortedPrompts = [...prompts].sort((a, b) => {
			const orderA = serverOrderMap.get(a.serverName) ?? Number.MAX_SAFE_INTEGER;
			const orderB = serverOrderMap.get(b.serverName) ?? Number.MAX_SAFE_INTEGER;
			return orderA - orderB;
		});

		const query = (searchQuery || internalSearchQuery).toLowerCase();
		if (!query) return sortedPrompts;

		return sortedPrompts.filter(
			(prompt) =>
				prompt.name.toLowerCase().includes(query) ||
				prompt.title?.toLowerCase().includes(query) ||
				prompt.description?.toLowerCase().includes(query)
		);
	});

	let rows = $derived<Row[]>([
		...commandItems.map((item) => ({ kind: 'builtin' as const, item })),
		...(showPrompts ? filteredPrompts.map((prompt) => ({ kind: 'prompt' as const, prompt })) : [])
	]);

	function handleRowClick(row: Row) {
		if (row.kind === 'builtin') onCommandPick?.(row.item);
		else handlePromptClick(row.prompt);
	}

	function rowKey(row: Row): string {
		if (row.kind === 'prompt') return 'prompt:' + row.prompt.serverName + ':' + row.prompt.name;
		const { item } = row;
		return item.kind === 'option'
			? `option:${item.command.name}:${item.option.value}`
			: `command:${item.command.name}`;
	}

	let showSearchInput = $derived(showPrompts && prompts.length > 3);
</script>

<ChatFormPickerPopover
	bind:isOpen
	class={className}
	srLabel="Open prompt picker"
	{onClose}
	onKeydown={handleKeydown}
>
	{#if selectedPrompt}
		{@const prompt = selectedPrompt}
		{@const server = serverSettingsMap.get(prompt.serverName)}
		{@const serverLabel = server ? mcpStore.getServerLabel(server) : prompt.serverName}

		<div class="p-4">
			<ChatFormPickerItemHeader
				{server}
				{serverLabel}
				title={prompt.title || prompt.name}
				description={prompt.description}
			>
				{#snippet titleExtra()}
					{#if prompt.arguments?.length}
						<Badge variant="secondary">
							{prompt.arguments.length} arg{prompt.arguments.length > 1 ? 's' : ''}
						</Badge>
					{/if}
				{/snippet}
			</ChatFormPickerItemHeader>

			<ChatFormPromptPickerArgumentForm
				prompt={selectedPrompt}
				{promptArgs}
				{suggestions}
				{loadingSuggestions}
				{activeAutocomplete}
				{autocompleteIndex}
				{promptError}
				onArgInput={handleArgInput}
				onArgKeydown={handleArgKeydown}
				onArgBlur={handleArgBlur}
				onArgFocus={handleArgFocus}
				onSelectSuggestion={selectSuggestion}
				onSubmit={handleArgumentSubmit}
				onCancel={handleCancelArgumentForm}
			/>
		</div>
	{:else}
		<ChatFormPickerList
			items={rows}
			isLoading={isLoading && showPrompts && commandItems.length === 0}
			{selectedIndex}
			bind:searchQuery={internalSearchQuery}
			{showSearchInput}
			searchPlaceholder="Search prompts..."
			emptyMessage={showPrompts
				? 'No matching command or workflow. Add workflows from Workflows in the sidebar.'
				: 'No matching command.'}
			itemKey={rowKey}
		>
			{#snippet item(row, index, isSelected)}
				{@const previous = index > 0 ? rows[index - 1] : undefined}
				{#if row.kind === 'builtin' && index === 0}
					<div class="px-3 pt-1 pb-1 text-xs font-medium text-muted-foreground">Commands</div>
				{:else if row.kind === 'prompt' && (index === 0 || previous?.kind === 'builtin')}
					<div class="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">Workflows</div>
				{/if}
				{#if row.kind === 'builtin'}
					{@const builtin = row.item}
					<ChatFormPickerListItem
						dataIndex={index}
						{isSelected}
						onclick={() => handleRowClick(row)}
					>
						<div class="min-w-0 flex-1">
							{#if builtin.kind === 'option'}
								<div class="flex items-center gap-2">
									<span class="font-medium">{builtin.option.label}</span>
									<span class="text-xs text-muted-foreground">/{builtin.command.name}</span>
								</div>
								{#if builtin.option.description}
									<p class="mt-0.5 truncate text-sm text-muted-foreground">
										{builtin.option.description}
									</p>
								{/if}
							{:else}
								<div class="flex items-center gap-2">
									<span class="font-mono text-sm font-medium">{usage(builtin.command)}</span>
								</div>
								<p class="mt-0.5 truncate text-sm text-muted-foreground">
									{builtin.command.summary}
								</p>
							{/if}
						</div>
					</ChatFormPickerListItem>
				{:else}
					{@const prompt = row.prompt}
					{@const server = serverSettingsMap.get(prompt.serverName)}
					{@const serverLabel = server ? mcpStore.getServerLabel(server) : prompt.serverName}

					<ChatFormPickerListItem
						dataIndex={index}
						{isSelected}
						onclick={() => handleRowClick(row)}
					>
						<ChatFormPickerItemHeader
							{server}
							{serverLabel}
							title={prompt.title || prompt.name}
							description={prompt.description}
						>
							{#snippet titleExtra()}
								{#if prompt.arguments?.length}
									<Badge variant="secondary">
										{prompt.arguments.length} arg{prompt.arguments.length > 1 ? 's' : ''}
									</Badge>
								{/if}
							{/snippet}
						</ChatFormPickerItemHeader>
					</ChatFormPickerListItem>
				{/if}
			{/snippet}

			{#snippet skeleton()}
				<ChatFormPickerListItemSkeleton titleWidth="w-32" showBadge />
			{/snippet}
		</ChatFormPickerList>
	{/if}
</ChatFormPickerPopover>
