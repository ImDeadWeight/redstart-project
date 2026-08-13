/**
 * conversation-core - the state every conversation concern reads
 *
 * Owns the conversation list, the active conversation, that conversation's
 * visible message path, and the init flag. It knows nothing about persistence,
 * MCP overrides, titles, import/export or navigation: it is the shared
 * substrate those concerns are injected with, mirroring the role
 * ChatRuntimeState plays in stores/chat/.
 */

export class ConversationCoreState {
	/** List of all conversations */
	conversations = $state<DatabaseConversation[]>([]);

	/** Currently active conversation */
	activeConversation = $state<DatabaseConversation | null>(null);

	/** Messages in the active conversation (filtered by currNode path) */
	activeMessages = $state<DatabaseMessage[]>([]);

	/** Whether the store has been initialized */
	isInitialized = $state(false);
}
