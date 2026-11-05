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
import type { DatabaseConversation } from '$lib/types/database';

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
		await this.updateNaming(convId, { name });
	}

	/** The user typed this name; the model will not rename the conversation after this. */
	async renameByUser(convId: string, name: string): Promise<void> {
		await this.updateNaming(convId, { name, nameSetByUser: true });
	}

	/**
	 * The model's name for the conversation (chat-title.service). Dropped if the
	 * user renamed it while the model was thinking of one.
	 */
	async applyAutoTitle(convId: string, name: string, titledAt: number): Promise<void> {
		if (this.find(convId)?.nameSetByUser) return;
		await this.updateNaming(convId, { name, autoTitledAt: titledAt });
	}

	/**
	 * The first prompt changed (edited, or another branch chosen), so the title
	 * may no longer fit.
	 * - A name the user typed stays.
	 * - A name the model gave stays for now and is marked stale, so the model
	 *   names the conversation afresh after its next answer. Swapping it back to
	 *   the raw prompt would only make the title worse in the meantime.
	 * - Otherwise the title is still the first prompt's text, so it follows the
	 *   new prompt.
	 * @returns True if the title or its state was updated
	 */
	async updateConversationTitleWithConfirmation(
		convId: string,
		newTitle: string
	): Promise<boolean> {
		try {
			const conv = this.find(convId);
			if (conv?.nameSetByUser) return false;
			if (conv?.autoTitledAt !== undefined && conv?.autoTitledAt !== null) {
				await this.updateNaming(convId, { autoTitledAt: null });
				return true;
			}
			await this.updateConversationName(convId, newTitle);
			return true;
		} catch (error) {
			console.error('Failed to update conversation title with confirmation:', error);
			return false;
		}
	}

	private find(convId: string): DatabaseConversation | undefined {
		if (this.core.activeConversation?.id === convId) return this.core.activeConversation;
		return this.core.conversations.find((c) => c.id === convId);
	}

	/** Writes naming fields to the server, then to the list and the open conversation. */
	private async updateNaming(
		convId: string,
		changes: Pick<Partial<DatabaseConversation>, 'name' | 'nameSetByUser' | 'autoTitledAt'>
	): Promise<void> {
		try {
			await DatabaseService.updateConversation(convId, changes);

			const convIndex = this.core.conversations.findIndex((c) => c.id === convId);

			if (convIndex !== -1) {
				this.core.conversations[convIndex] = { ...this.core.conversations[convIndex], ...changes };
				this.core.conversations = [...this.core.conversations];
			}

			if (this.core.activeConversation?.id === convId) {
				this.core.activeConversation = { ...this.core.activeConversation, ...changes };
			}
		} catch (error) {
			console.error('Failed to update conversation name:', error);
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
