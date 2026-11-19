/**
 * conversation-messages - the active conversation's visible message path
 *
 * Owns appending, updating, slicing and removing messages on the active path,
 * recomputing that path from the conversation tree, and walking between sibling
 * branches. Reads and writes the message array and the active conversation
 * through the injected core state.
 *
 * It also takes conversation-title, because navigateToSibling re-titles a
 * conversation when switching branches changes its first user message. That
 * edge is why 6c had to land before 6a.
 *
 * The one piece of state it owns is the callback chatStore registers to be told
 * a message changed — registered rather than imported, because chatStore
 * imports the conversations store and the reverse would be a cycle.
 */

import { DatabaseService } from '$lib/services/database.service';
import { config } from '$lib/stores/settings.svelte';
import { filterByLeafNodeId, findLeafNode, generateConversationTitle } from '$lib/utils';
import { MessageRole } from '$lib/enums';
import type { ConversationCoreState } from './conversation-core.svelte';
import type { ConversationTitle } from './conversation-title.svelte';

export class ConversationMessages {
	constructor(
		private readonly core: ConversationCoreState,
		private readonly title: ConversationTitle
	) {}

	private messageUpdateCallback:
		| ((messageId: string, updates: Partial<DatabaseMessage>) => void)
		| null = null;

	/**
	 * Register a callback for message updates from other stores.
	 * Called by chatStore during initialization.
	 */
	registerMessageUpdateCallback(
		callback: (messageId: string, updates: Partial<DatabaseMessage>) => void
	): void {
		this.messageUpdateCallback = callback;
	}

	/**
	 * Adds a message to the active messages array
	 */
	addMessageToActive(message: DatabaseMessage): void {
		this.core.activeMessages.push(message);
	}

	/**
	 * Updates a message at a specific index in active messages
	 */
	updateMessageAtIndex(index: number, updates: Partial<DatabaseMessage>): void {
		if (index !== -1 && this.core.activeMessages[index]) {
			this.core.activeMessages[index] = { ...this.core.activeMessages[index], ...updates };
		}
	}

	/**
	 * Finds the index of a message in active messages
	 */
	findMessageIndex(messageId: string): number {
		return this.core.activeMessages.findIndex((m) => m.id === messageId);
	}

	/**
	 * Removes messages from active messages starting at an index
	 */
	sliceActiveMessages(startIndex: number): void {
		this.core.activeMessages = this.core.activeMessages.slice(0, startIndex);
	}

	/**
	 * Removes a message from active messages by index
	 */
	removeMessageAtIndex(index: number): DatabaseMessage | undefined {
		if (index !== -1) {
			return this.core.activeMessages.splice(index, 1)[0];
		}
		return undefined;
	}

	/**
	 * Refreshes active messages based on currNode after branch navigation.
	 */
	async refreshActiveMessages(): Promise<void> {
		if (!this.core.activeConversation) return;

		const allMessages = await DatabaseService.getConversationMessages(this.core.activeConversation.id);

		if (allMessages.length === 0) {
			this.core.activeMessages = [];
			return;
		}

		const leafNodeId =
			this.core.activeConversation.currNode ||
			allMessages.reduce((latest, msg) => (msg.timestamp > latest.timestamp ? msg : latest)).id;

		const currentPath = filterByLeafNodeId(allMessages, leafNodeId, false) as DatabaseMessage[];

		this.core.activeMessages = currentPath;
	}

	/**
	 * Gets all messages for a specific conversation
	 * @param convId - The conversation ID
	 * @returns Array of messages
	 */
	async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
		return await DatabaseService.getConversationMessages(convId);
	}

	/**
	 * Updates the current node of the active conversation
	 * @param nodeId - The new current node ID
	 */
	async updateCurrentNode(nodeId: string): Promise<void> {
		if (!this.core.activeConversation) return;

		await DatabaseService.updateCurrentNode(this.core.activeConversation.id, nodeId);
		this.core.activeConversation = { ...this.core.activeConversation, currNode: nodeId };
	}

	/**
	 * Navigates to a specific sibling branch by updating currNode and refreshing messages.
	 * @param siblingId - The sibling message ID to navigate to
	 */
	async navigateToSibling(siblingId: string): Promise<void> {
		if (!this.core.activeConversation) return;

		const allMessages = await DatabaseService.getConversationMessages(this.core.activeConversation.id);
		const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
		const currentFirstUserMessage = this.core.activeMessages.find(
			(m) => m.role === MessageRole.USER && m.parent === rootMessage?.id
		);

		const currentLeafNodeId = findLeafNode(allMessages, siblingId);

		await DatabaseService.updateCurrentNode(this.core.activeConversation.id, currentLeafNodeId);
		this.core.activeConversation = { ...this.core.activeConversation, currNode: currentLeafNodeId };
		await this.refreshActiveMessages();

		if (rootMessage && this.core.activeMessages.length > 0) {
			const newFirstUserMessage = this.core.activeMessages.find(
				(m) => m.role === MessageRole.USER && m.parent === rootMessage.id
			);

			if (
				newFirstUserMessage &&
				newFirstUserMessage.content.trim() &&
				(!currentFirstUserMessage ||
					newFirstUserMessage.id !== currentFirstUserMessage.id ||
					newFirstUserMessage.content.trim() !== currentFirstUserMessage.content.trim())
			) {
				await this.title.updateConversationTitleWithConfirmation(
					this.core.activeConversation.id,
					generateConversationTitle(
						newFirstUserMessage.content,
						Boolean(config().titleGenerationUseFirstLine)
					)
				);
			}
		}
	}
}
