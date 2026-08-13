/**
 * conversationsStore - Reactive State Store for Conversations
 *
 * Manages conversation lifecycle, persistence, navigation, and MCP server overrides.
 *
 * **Architecture & Relationships:**
 * - **DatabaseService**: Stateless IndexedDB layer
 * - **conversationsStore** (this): Reactive state + business logic
 * - **chatStore**: Chat-specific state (streaming, loading)
 *
 * **Key Responsibilities:**
 * - Conversation CRUD (create, load, delete)
 * - Message management and tree navigation
 * - MCP server per-chat overrides
 * - Import/Export functionality
 * - Title management with confirmation
 *
 * @see DatabaseService in services/database.ts for IndexedDB operations
 */

import { goto } from '$app/navigation';
import { browser } from '$app/environment';
import { toast } from 'svelte-sonner';
import { DatabaseService } from '$lib/services/database.service';
import { MigrationService } from '$lib/services/migration.service';
import { filterByLeafNodeId } from '$lib/utils';
import type { McpServerOverride } from '$lib/types/database';
import { ReasoningEffort } from '$lib/enums';

import { ROUTES } from '$lib/constants/routes';
import { RouterService } from '$lib/services/router.service';
import { ConversationCoreState } from '$lib/stores/conversations/conversation-core.svelte';
import { ConversationMcpOverrides } from '$lib/stores/conversations/conversation-mcp-overrides.svelte';
import { ConversationTitle } from '$lib/stores/conversations/conversation-title.svelte';
import { ConversationMessages } from '$lib/stores/conversations/conversation-messages.svelte';
import { ConversationIO } from '$lib/stores/conversations/conversation-io';
import { ConversationPrefs } from '$lib/stores/conversations/conversation-prefs.svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

export interface ConversationTreeItem {
	conversation: DatabaseConversation;
	depth: number;
}

class ConversationsStore {
	/**
	 *
	 *
	 * State
	 *
	 *
	 */

	/**
	 * Shared conversation state, owned by a sub-store so the other conversation
	 * concerns can be injected with it rather than reaching back into this
	 * facade. Forwarded below with getters and setters, never copied.
	 */
	readonly core = new ConversationCoreState();

	/** List of all conversations */
	get conversations(): DatabaseConversation[] {
		return this.core.conversations;
	}
	set conversations(value: DatabaseConversation[]) {
		this.core.conversations = value;
	}

	/** Currently active conversation */
	get activeConversation(): DatabaseConversation | null {
		return this.core.activeConversation;
	}
	set activeConversation(value: DatabaseConversation | null) {
		this.core.activeConversation = value;
	}

	/** Messages in the active conversation (filtered by currNode path) */
	get activeMessages(): DatabaseMessage[] {
		return this.core.activeMessages;
	}
	set activeMessages(value: DatabaseMessage[]) {
		this.core.activeMessages = value;
	}

	/** Whether the store has been initialized */
	get isInitialized(): boolean {
		return this.core.isInitialized;
	}
	set isInitialized(value: boolean) {
		this.core.isInitialized = value;
	}

	/**
	 * Per-chat MCP server enablement, and the defaults a not-yet-created
	 * conversation inherits.
	 */
	readonly mcpOverrides = new ConversationMcpOverrides(this.core);

	/** Naming, the confirmation around it, and the timestamp bump. */
	readonly title = new ConversationTitle(this.core);

	/**
	 * The active conversation's visible message path. Declared after `title`
	 * because navigateToSibling re-titles on a branch switch.
	 */
	readonly messages = new ConversationMessages(this.core, this.title);

	/** Export and import. The import delegations below re-run the reload it no longer does. */
	readonly io = new ConversationIO(this.core);

	/** Thinking, reasoning effort and prompt mode, per conversation. */
	readonly prefs = new ConversationPrefs(this.core);

	/** Defaults a not-yet-created conversation inherits. Consumers assign to these. */
	get pendingThinkingEnabled(): boolean {
		return this.prefs.pendingThinkingEnabled;
	}
	set pendingThinkingEnabled(value: boolean) {
		this.prefs.pendingThinkingEnabled = value;
	}

	get pendingReasoningEffort(): ReasoningEffort {
		return this.prefs.pendingReasoningEffort;
	}
	set pendingReasoningEffort(value: ReasoningEffort) {
		this.prefs.pendingReasoningEffort = value;
	}

	get pendingPromptMode(): string | null {
		return this.prefs.pendingPromptMode;
	}
	set pendingPromptMode(value: string | null) {
		this.prefs.pendingPromptMode = value;
	}

	getThinkingEnabled(): boolean {
		return this.prefs.getThinkingEnabled();
	}

	async setThinkingEnabled(enabled: boolean): Promise<void> {
		return this.prefs.setThinkingEnabled(enabled);
	}

	getReasoningEffort(): ReasoningEffort {
		return this.prefs.getReasoningEffort();
	}

	async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
		return this.prefs.setReasoningEffort(effort);
	}

	getPromptMode(): string | null {
		return this.prefs.getPromptMode();
	}

	async setPromptMode(mode: string | null): Promise<void> {
		return this.prefs.setPromptMode(mode);
	}

	/**
	 * Registered from +layout.svelte, read from chat-message-ops. Forwarded with
	 * a getter *and* a setter — consumers assign to it directly.
	 */
	get titleUpdateConfirmationCallback():
		| ((currentTitle: string, newTitle: string) => Promise<boolean>)
		| undefined {
		return this.title.titleUpdateConfirmationCallback;
	}
	set titleUpdateConfirmationCallback(
		value: ((currentTitle: string, newTitle: string) => Promise<boolean>) | undefined
	) {
		this.title.titleUpdateConfirmationCallback = value;
	}

	setTitleUpdateConfirmationCallback(
		callback: (currentTitle: string, newTitle: string) => Promise<boolean>
	): void {
		this.title.setTitleUpdateConfirmationCallback(callback);
	}

	async updateConversationName(convId: string, name: string): Promise<void> {
		return this.title.updateConversationName(convId, name);
	}

	async updateConversationTitleWithConfirmation(
		convId: string,
		newTitle: string
	): Promise<boolean> {
		return this.title.updateConversationTitleWithConfirmation(convId, newTitle);
	}

	updateConversationTimestamp(): void {
		this.title.updateConversationTimestamp();
	}

	/** Pending MCP server overrides for new conversations (before first message) */
	get pendingMcpServerOverrides(): McpServerOverride[] {
		return this.mcpOverrides.pendingMcpServerOverrides;
	}
	set pendingMcpServerOverrides(value: McpServerOverride[]) {
		this.mcpOverrides.pendingMcpServerOverrides = value;
	}

	/** Callback for title update confirmation dialog */
	/**
	 * Callback for updating message content in chatStore.
	 * Registered by chatStore to enable cross-store updates without circular dependency.
	 */
	/**
	 *
	 *
	 * Lifecycle
	 *
	 *
	 */

	/**
	 * Initialize the store by loading conversations from database.
	 * Must be called once after app startup.
	 */
	async init(): Promise<void> {
		if (!browser) return;
		if (this.isInitialized) return;

		try {
			await MigrationService.runAllMigrations();

			await this.loadConversations();
			this.isInitialized = true;
		} catch (error) {
			console.error('Failed to initialize conversations:', error);
		}
	}

	/**
	 * Alias for init() for backward compatibility.
	 */
	async initialize(): Promise<void> {
		return this.init();
	}

	/**
	 *
	 *
	 * Message Array Operations
	 *
	 *
	 */

	/**
	 *
	 *
	 * Conversation CRUD
	 *
	 *
	 */

	/**
	 * Loads all conversations from the database
	 */
	registerMessageUpdateCallback(
		callback: (messageId: string, updates: Partial<DatabaseMessage>) => void
	): void {
		this.messages.registerMessageUpdateCallback(callback);
	}

	addMessageToActive(message: DatabaseMessage): void {
		this.messages.addMessageToActive(message);
	}

	updateMessageAtIndex(index: number, updates: Partial<DatabaseMessage>): void {
		this.messages.updateMessageAtIndex(index, updates);
	}

	findMessageIndex(messageId: string): number {
		return this.messages.findMessageIndex(messageId);
	}

	sliceActiveMessages(startIndex: number): void {
		this.messages.sliceActiveMessages(startIndex);
	}

	removeMessageAtIndex(index: number): DatabaseMessage | undefined {
		return this.messages.removeMessageAtIndex(index);
	}

	async refreshActiveMessages(): Promise<void> {
		return this.messages.refreshActiveMessages();
	}

	async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
		return this.messages.getConversationMessages(convId);
	}

	async updateCurrentNode(nodeId: string): Promise<void> {
		return this.messages.updateCurrentNode(nodeId);
	}

	async navigateToSibling(siblingId: string): Promise<void> {
		return this.messages.navigateToSibling(siblingId);
	}

	async loadConversations(): Promise<void> {
		const conversations = await DatabaseService.getAllConversations();
		this.conversations = conversations;
	}

	/**
	 * Creates a new conversation and navigates to it
	 * @param name - Optional name for the conversation
	 * @returns The ID of the created conversation
	 */
	async createConversation(name?: string): Promise<string> {
		const conversationName = name || `Chat ${new Date().toLocaleString()}`;
		const conversation = await DatabaseService.createConversation(conversationName);

		if (this.pendingMcpServerOverrides.length > 0) {
			// Deep clone to plain objects (Svelte 5 $state uses Proxies which can't be cloned to IndexedDB)
			const plainOverrides = this.pendingMcpServerOverrides.map((o) => ({
				serverId: o.serverId,
				enabled: o.enabled
			}));
			conversation.mcpServerOverrides = plainOverrides;
			await DatabaseService.updateConversation(conversation.id, {
				mcpServerOverrides: plainOverrides
			});
			this.pendingMcpServerOverrides = [];
		}

		// Inherit global thinking default into the new conversation
		conversation.thinkingEnabled = this.pendingThinkingEnabled;
		await DatabaseService.updateConversation(conversation.id, {
			thinkingEnabled: this.pendingThinkingEnabled
		});

		this.conversations = [conversation, ...this.conversations];
		this.activeConversation = conversation;
		this.activeMessages = [];

		await goto(RouterService.chat(conversation.id));

		return conversation.id;
	}

	/**
	 * Loads a specific conversation and its messages
	 * @param convId - The conversation ID to load
	 * @returns True if conversation was loaded successfully
	 */
	async loadConversation(convId: string): Promise<boolean> {
		try {
			const conversation = await DatabaseService.getConversation(convId);

			if (!conversation) {
				return false;
			}

			this.pendingMcpServerOverrides = [];
			this.pendingThinkingEnabled = false;
			this.activeConversation = conversation;

			if (conversation.currNode) {
				const allMessages = await DatabaseService.getConversationMessages(convId);
				const filteredMessages = filterByLeafNodeId(
					allMessages,
					conversation.currNode,
					false
				) as DatabaseMessage[];
				this.activeMessages = filteredMessages;
			} else {
				const messages = await DatabaseService.getConversationMessages(convId);
				this.activeMessages = messages;
			}

			return true;
		} catch (error) {
			console.error('Failed to load conversation:', error);
			return false;
		}
	}

	/**
	 * Clears the active conversation and messages.
	 */
	clearActiveConversation(): void {
		this.activeConversation = null;
		this.activeMessages = [];
		// reload defaults so new chats inherit persisted state
		this.pendingMcpServerOverrides = ConversationMcpOverrides.loadMcpDefaults();
		this.pendingThinkingEnabled = ConversationPrefs.loadThinkingDefaults();
	}

	/**
	 * Deletes a conversation and all its messages
	 * @param convId - The conversation ID to delete
	 */
	async deleteConversation(convId: string, options?: { deleteWithForks?: boolean }): Promise<void> {
		try {
			await DatabaseService.deleteConversation(convId, options);

			if (options?.deleteWithForks) {
				// Collect all descendants recursively
				const idsToRemove = new SvelteSet([convId]);
				const queue = [convId];
				while (queue.length > 0) {
					const parentId = queue.pop()!;
					for (const c of this.conversations) {
						if (c.forkedFromConversationId === parentId && !idsToRemove.has(c.id)) {
							idsToRemove.add(c.id);
							queue.push(c.id);
						}
					}
				}
				this.conversations = this.conversations.filter((c) => !idsToRemove.has(c.id));

				if (this.activeConversation && idsToRemove.has(this.activeConversation.id)) {
					this.clearActiveConversation();
					await goto(ROUTES.NEW_CHAT);
				}
			} else {
				// Reparent direct children to deleted conv's parent (or promote to top-level)
				const deletedConv = this.conversations.find((c) => c.id === convId);
				const newParent = deletedConv?.forkedFromConversationId;
				this.conversations = this.conversations
					.filter((c) => c.id !== convId)
					.map((c) =>
						c.forkedFromConversationId === convId
							? { ...c, forkedFromConversationId: newParent }
							: c
					);

				if (this.activeConversation?.id === convId) {
					this.clearActiveConversation();
					await goto(ROUTES.NEW_CHAT);
				}
			}
		} catch (error) {
			console.error('Failed to delete conversation:', error);
		}
	}

	/**
	 * Deletes all conversations and their messages
	 */
	async deleteAll(): Promise<void> {
		try {
			const allConversations = await DatabaseService.getAllConversations();

			for (const conv of allConversations) {
				await DatabaseService.deleteConversation(conv.id);
			}

			this.clearActiveConversation();
			this.conversations = [];

			toast.success('All conversations deleted');

			await goto(ROUTES.NEW_CHAT);
		} catch (error) {
			console.error('Failed to delete all conversations:', error);
			toast.error('Failed to delete conversations');
		}
	}

	/**
	 *
	 *
	 * Message Management
	 *
	 *
	 */

	/**
	 *
	 *
	 * Title Management
	 *
	 *
	 */

	/**
	 * Toggles the pinned status of a conversation.
	 * @param convId - The conversation ID to toggle
	 * @returns The new pinned status
	 */
	async toggleConversationPin(convId: string): Promise<boolean> {
		try {
			const newPinnedState = await DatabaseService.toggleConversationPin(convId);

			const convIndex = this.conversations.findIndex((c) => c.id === convId);

			if (convIndex !== -1) {
				this.conversations[convIndex].pinned = newPinnedState;
				this.conversations = [...this.conversations];
			}

			if (this.activeConversation?.id === convId) {
				this.activeConversation = { ...this.activeConversation, pinned: newPinnedState };
			}

			return newPinnedState;
		} catch (error) {
			console.error('Failed to toggle conversation pin:', error);
			return false;
		}
	}

	/**
	 *
	 *
	 * Branch Navigation
	 *
	 *
	 */

	/**
	 *
	 *
	 * MCP Server Overrides
	 *
	 *
	 */

	/**
	 * Gets MCP server override for a specific server in the active conversation.
	 * Falls back to pending overrides if no active conversation exists.
	 * @param serverId - The server ID to check
	 * @returns The override if set, undefined if using global setting
	 */
	getMcpServerOverride(serverId: string): McpServerOverride | undefined {
		return this.mcpOverrides.getMcpServerOverride(serverId);
	}

	/**
	 * Get all MCP server overrides for the current conversation.
	 * Returns pending overrides if no active conversation.
	 */
	getAllMcpServerOverrides(): McpServerOverride[] {
		return this.mcpOverrides.getAllMcpServerOverrides();
	}

	/**
	 * Checks if an MCP server is enabled for the active conversation.
	 * @param serverId - The server ID to check
	 * @returns True if server is enabled for this conversation
	 */
	isMcpServerEnabledForChat(serverId: string): boolean {
		return this.mcpOverrides.isMcpServerEnabledForChat(serverId);
	}

	/**
	 * Sets or removes MCP server override for the active conversation.
	 * If no conversation exists, stores as pending override.
	 * @param serverId - The server ID to override
	 * @param enabled - The enabled state, or undefined to remove override
	 */
	async setMcpServerOverride(serverId: string, enabled: boolean | undefined): Promise<void> {
		return this.mcpOverrides.setMcpServerOverride(serverId, enabled);
	}

	/**
	 * Seeds the default enabled-state for a host-provisioned MCP server.
	 *
	 * No-op when any choice already exists — a saved default, or an explicit
	 * choice in the active conversation — so a user's decision, including an
	 * explicit "off", is never overwritten by re-provisioning.
	 */
	seedMcpServerDefault(serverId: string, enabled: boolean): void {
		this.mcpOverrides.seedMcpServerDefault(serverId, enabled);
	}

	/**
	 * Toggles MCP server enabled state for the active conversation.
	 * @param serverId - The server ID to toggle
	 */
	async toggleMcpServerForChat(serverId: string): Promise<void> {
		return this.mcpOverrides.toggleMcpServerForChat(serverId);
	}

	/**
	 * Removes MCP server override for the active conversation.
	 * @param serverId - The server ID to remove override for
	 */
	async removeMcpServerOverride(serverId: string): Promise<void> {
		return this.mcpOverrides.removeMcpServerOverride(serverId);
	}

	/**
	 * Clears all pending MCP server overrides.
	 */
	clearPendingMcpServerOverrides(): void {
		this.mcpOverrides.clearPendingMcpServerOverrides();
	}

	/**
	 * Forks a conversation at a specific message, creating a new conversation
	 * containing messages from root up to the target message, then navigates to it.
	 *
	 * @param messageId - The message ID to fork at
	 * @param options - Fork options (name and whether to include attachments)
	 * @returns The new conversation ID, or null if fork failed
	 */
	async forkConversation(
		messageId: string,
		options: { name: string; includeAttachments: boolean }
	): Promise<string | null> {
		if (!this.activeConversation) return null;

		try {
			const newConv = await DatabaseService.forkConversation(
				this.activeConversation.id,
				messageId,
				options
			);

			this.conversations = [newConv, ...this.conversations];

			await goto(RouterService.chat(newConv.id));

			toast.success('Conversation forked');

			return newConv.id;
		} catch (error) {
			console.error('Failed to fork conversation:', error);
			toast.error('Failed to fork conversation');

			return null;
		}
	}

	/**
	 *
	 *
	 * Import & Export
	 *
	 *
	 */

	generateConversationFilename(conversation: { id?: string; name?: string }): string {
		return this.io.generateConversationFilename(conversation);
	}

	downloadConversationFile(data: ExportedConversations, filename?: string): void {
		this.io.downloadConversationFile(data, filename);
	}

	async downloadConversation(convId: string): Promise<void> {
		return this.io.downloadConversation(convId);
	}

	/**
	 * The reload lives here rather than in conversation-io: a sub-store may not
	 * call back into this facade. Callers still see the store refreshed by the
	 * time the promise they awaited settles.
	 */
	async importConversations(): Promise<DatabaseConversation[]> {
		const imported = await this.io.importConversations();
		await this.loadConversations();
		return imported;
	}

	async importConversationsData(
		data: ExportedConversations
	): Promise<{ imported: number; skipped: number }> {
		const result = await this.io.importConversationsData(data);
		await this.loadConversations();
		return result;
	}
}

export const conversationsStore = new ConversationsStore();

// Auto-initialize in browser
if (browser) {
	conversationsStore.init();
}

export const conversations = () => conversationsStore.conversations;
export const activeConversation = () => conversationsStore.activeConversation;
export const activeMessages = () => conversationsStore.activeMessages;
export const isConversationsInitialized = () => conversationsStore.isInitialized;

/**
 * Builds a flat tree of conversations with depth levels for nested forks.
 * Accepts a pre-filtered list so search filtering stays in the component.
 */

// Pinned conversations first, then by lastModified descending
const comparePinnedThenRecent = (a: DatabaseConversation, b: DatabaseConversation) => {
	if (a.pinned && !b.pinned) return -1;
	if (!a.pinned && b.pinned) return 1;
	return b.lastModified - a.lastModified;
};

export function buildConversationTree(convs: DatabaseConversation[]): ConversationTreeItem[] {
	const childrenByParent = new SvelteMap<string, DatabaseConversation[]>();
	const forkIds = new SvelteSet<string>();

	for (const conv of convs) {
		if (conv.forkedFromConversationId) {
			forkIds.add(conv.id);

			const siblings = childrenByParent.get(conv.forkedFromConversationId) || [];

			siblings.push(conv);
			childrenByParent.set(conv.forkedFromConversationId, siblings);
		}
	}

	const result: ConversationTreeItem[] = [];
	const visited = new SvelteSet<string>();

	function walk(conv: DatabaseConversation, depth: number) {
		visited.add(conv.id);
		result.push({ conversation: conv, depth });

		const children = childrenByParent.get(conv.id);
		if (children) {
			children.sort(comparePinnedThenRecent);

			for (const child of children) {
				walk(child, depth + 1);
			}
		}
	}

	const roots = convs.filter((c) => !forkIds.has(c.id)).sort(comparePinnedThenRecent);
	for (const root of roots) {
		walk(root, 0);
	}

	for (const conv of convs) {
		if (!visited.has(conv.id)) {
			walk(conv, 1);
		}
	}

	return result;
}
