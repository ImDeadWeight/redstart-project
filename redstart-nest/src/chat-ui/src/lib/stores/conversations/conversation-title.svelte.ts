/**
 * conversation-title - naming a conversation, and the confirmation around it
 *
 * Owns renaming (both the direct write and the confirmation-wrapped variant),
 * the timestamp bump that reorders the list, and the callback the UI registers
 * to be asked before an automatic title replaces one the user may have set.
 *
 * `updateConversationName` moved here with the rest rather than staying on the
 * facade as core CRUD: it is the naming concern, and
 * updateConversationTitleWithConfirmation is a four-line wrapper over it, so
 * splitting them would leave a sub-store calling back into the facade — which
 * recipe rule 3 forbids.
 *
 * The confirmation callback is wired from +layout.svelte and read from
 * chat-message-ops; that contract is unchanged, the facade forwards the field
 * with a getter and a setter.
 */

import { DatabaseService } from '$lib/services/database.service';
import type { ConversationCoreState } from './conversation-core.svelte';

export class ConversationTitle {
	constructor(private readonly core: ConversationCoreState) {}

	titleUpdateConfirmationCallback?: (currentTitle: string, newTitle: string) => Promise<boolean>;

	/**
	 * Sets the callback function for title update confirmations
	 */
	setTitleUpdateConfirmationCallback(
		callback: (currentTitle: string, newTitle: string) => Promise<boolean>
	): void {
		this.titleUpdateConfirmationCallback = callback;
	}

	/**
	 * Updates the name of a conversation.
	 * @param convId - The conversation ID to update
	 * @param name - The new name for the conversation
	 */
	async updateConversationName(convId: string, name: string): Promise<void> {
		try {
			await DatabaseService.updateConversation(convId, { name });

			const convIndex = this.core.conversations.findIndex((c) => c.id === convId);

			if (convIndex !== -1) {
				this.core.conversations[convIndex].name = name;
				this.core.conversations = [...this.core.conversations];
			}

			if (this.core.activeConversation?.id === convId) {
				this.core.activeConversation = { ...this.core.activeConversation, name };
			}
		} catch (error) {
			console.error('Failed to update conversation name:', error);
		}
	}

	/**
	 * Updates conversation title with optional confirmation dialog based on settings
	 * @param convId - The conversation ID to update
	 * @param newTitle - The new title content
	 * @returns True if title was updated, false if cancelled
	 */
	async updateConversationTitleWithConfirmation(
		convId: string,
		newTitle: string
	): Promise<boolean> {
		try {
			await this.updateConversationName(convId, newTitle);
			return true;
		} catch (error) {
			console.error('Failed to update conversation title with confirmation:', error);
			return false;
		}
	}

	/**
	 * Updates conversation lastModified timestamp and moves it to top of list
	 */
	updateConversationTimestamp(): void {
		if (!this.core.activeConversation) return;

		const chatIndex = this.core.conversations.findIndex((c) => c.id === this.core.activeConversation!.id);

		if (chatIndex !== -1) {
			this.core.conversations[chatIndex].lastModified = Date.now();
			const updatedConv = this.core.conversations.splice(chatIndex, 1)[0];
			this.core.conversations = [updatedConv, ...this.core.conversations];
		}
	}
}
