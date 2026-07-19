/**
 * chatStore - Reactive State Store for Chat Operations
 *
 * Manages chat lifecycle, streaming, message operations, and processing state.
 *
 * **Architecture & Relationships:**
 * - **ChatService**: Stateless API layer (sendMessage, streaming)
 * - **chatStore** (this): Reactive state + business logic
 * - **conversationsStore**: Conversation persistence and navigation
 *
 * @see ChatService in services/chat.service.ts for API operations
 */

import { DatabaseService } from '$lib/services/database.service';
import { ChatService } from '$lib/services/chat.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { config } from '$lib/stores/settings.svelte';
import {
	getApiOptions as computeApiOptions,
	getConversationModel as computeConversationModel
} from '$lib/stores/chat/chat-options';
import { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';
import { ChatRuntimeState } from '$lib/stores/chat/chat-runtime.svelte';
import * as messageRepo from '$lib/stores/chat/chat-message-repo';
import { ChatSendController } from '$lib/stores/chat/chat-send.svelte';
import { ChatMessageOps } from '$lib/stores/chat/chat-message-ops.svelte';
import {
	filterByLeafNodeId,
	findMessageById,
	isAbortError,
	generateConversationTitle
} from '$lib/utils';
import { classifyContinueIntent } from '$lib/utils/agentic';
import type {
	ChatMessageTimings,
	ChatMessagePromptProgress,
	ErrorDialogState
} from '$lib/types/chat';
import type {
	ApiProcessingState,
	DatabaseMessage,
	DatabaseMessageExtra
} from '$lib/types';
import { ContinueIntentKind, ErrorDialogType, MessageRole, MessageType } from '$lib/enums';

class ChatStore {
	readonly ui = new ChatUiState();

	readonly runtime = new ChatRuntimeState();
	readonly send = new ChatSendController(this.runtime, this.ui);
	readonly ops = new ChatMessageOps(this.runtime, this.ui, this.send);

	/** Reactive UI state (error dialog, edit mode, drafts, pending-message queue). */
	get errorDialogState(): ErrorDialogState | null {
		return this.ui.errorDialogState;
	}

	get pendingEditMessageId(): string | null {
		return this.ui.pendingEditMessageId;
	}

	/** Reactive runtime state, forwarded from ChatRuntimeState (read + write). */
	get isLoading(): boolean {
		return this.runtime.isLoading;
	}
	set isLoading(value: boolean) {
		this.runtime.isLoading = value;
	}

	get isReasoning(): boolean {
		return this.runtime.isReasoning;
	}
	set isReasoning(value: boolean) {
		this.runtime.isReasoning = value;
	}

	get currentResponse(): string {
		return this.runtime.currentResponse;
	}
	set currentResponse(value: string) {
		this.runtime.currentResponse = value;
	}

	get activeProcessingState(): ApiProcessingState | null {
		return this.runtime.activeProcessingState;
	}
	set activeProcessingState(value: ApiProcessingState | null) {
		this.runtime.activeProcessingState = value;
	}

	syncLoadingStateForChat(convId: string): void {
		this.runtime.syncLoadingStateForChat(convId);
	}

	clearUIState(): void {
		this.runtime.clearUIState();
	}

	setActiveProcessingConversation(conversationId: string | null): void {
		this.runtime.setActiveProcessingConversation(conversationId);
	}

	getProcessingState(conversationId: string): ApiProcessingState | null {
		return this.runtime.getProcessingState(conversationId);
	}

	clearProcessingState(conversationId: string): void {
		this.runtime.clearProcessingState(conversationId);
	}

	getActiveProcessingState(): ApiProcessingState | null {
		return this.runtime.getActiveProcessingState();
	}

	getCurrentProcessingStateSync(): ApiProcessingState | null {
		return this.runtime.getCurrentProcessingStateSync();
	}

	isStreaming(): boolean {
		return this.runtime.isStreaming();
	}

	abortCurrentFlow(convId: string): void {
		this.runtime.abortCurrentFlow(convId);
	}

	dismissErrorDialog(): void {
		this.ui.dismissErrorDialog();
	}

	clearEditMode(): void {
		this.ui.clearEditMode();
	}

	isEditing(): boolean {
		return this.ui.isEditing();
	}

	setEditModeActive(handler: (files: File[]) => void): void {
		this.ui.setEditModeActive(handler);
	}

	getAddFilesHandler(): ((files: File[]) => void) | null {
		return this.ui.getAddFilesHandler();
	}

	clearPendingEditMessageId(): void {
		this.ui.clearPendingEditMessageId();
	}

	savePendingDraft(message: string, files: ChatUploadedFile[]): void {
		this.ui.savePendingDraft(message, files);
	}

	consumePendingDraft(): { message: string; files: ChatUploadedFile[] } | null {
		return this.ui.consumePendingDraft();
	}

	hasPendingDraft(): boolean {
		return this.ui.hasPendingDraft();
	}

	getAllLoadingChats(): string[] {
		return this.runtime.getAllLoadingChats();
	}

	getAllStreamingChats(): string[] {
		return this.runtime.getAllStreamingChats();
	}

	getChatStreamingPublic(convId: string): { response: string; messageId: string } | undefined {
		return this.runtime.getChatStreamingPublic(convId);
	}

	isChatLoadingPublic(convId: string): boolean {
		return this.runtime.isChatLoadingPublic(convId);
	}

	isChatReasoningPublic(convId: string): boolean {
		return this.runtime.isChatReasoningPublic(convId);
	}

	hasPendingMessage(convId: string): boolean {
		return this.ui.hasPendingMessage(convId);
	}

	pendingMessageContent(convId: string): string | null {
		return this.ui.pendingMessageContent(convId);
	}

	pendingMessageExtras(convId: string): DatabaseMessageExtra[] | undefined {
		return this.ui.pendingMessageExtras(convId);
	}

	injectPendingMessage(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		this.ui.injectPendingMessage(convId, content, extras);
	}

	clearPendingMessage(convId: string): void {
		this.ui.clearPendingMessage(convId);
	}

	cleanupOldConversationStates(activeConversationIds?: string[]): number {
		return this.runtime.cleanupOldConversationStates(activeConversationIds);
	}

	getTrackedConversationCount(): number {
		return this.runtime.getTrackedConversationCount();
	}

	async addMessage(
		role: MessageRole,
		content: string,
		type: MessageType = MessageType.TEXT,
		parent: string = '-1',
		extras?: DatabaseMessageExtra[]
	): Promise<DatabaseMessage> {
		return messageRepo.addMessage(role, content, type, parent, extras);
	}

	async addSystemPrompt(): Promise<void> {
		return messageRepo.addSystemPrompt(this.ui);
	}

	async removeSystemPromptPlaceholder(messageId: string): Promise<boolean> {
		return messageRepo.removeSystemPromptPlaceholder(messageId);
	}

	async sendMessage(content: string, extras?: DatabaseMessageExtra[]): Promise<void> {
		return this.send.sendMessage(content, extras);
	}

	async stopGeneration(): Promise<void> {
		return this.send.stopGeneration();
	}

	async stopGenerationForChat(convId: string): Promise<void> {
		return this.send.stopGenerationForChat(convId);
	}

	async updateMessage(messageId: string, newContent: string): Promise<void> {
		return this.ops.updateMessage(messageId, newContent);
	}

	async regenerateMessage(messageId: string): Promise<void> {
		return this.ops.regenerateMessage(messageId);
	}

	async regenerateMessageWithBranching(messageId: string, modelOverride?: string): Promise<void> {
		return this.ops.regenerateMessageWithBranching(messageId, modelOverride);
	}

	async getDeletionInfo(messageId: string): Promise<{
		totalCount: number;
		userMessages: number;
		assistantMessages: number;
		messageTypes: string[];
	}> {
		return this.ops.getDeletionInfo(messageId);
	}

	async deleteMessage(messageId: string): Promise<void> {
		return this.ops.deleteMessage(messageId);
	}

	/**
	 * Open a fresh assistant turn anchored at the last tool result of a resolved
	 * agentic round and let streamChatCompletion route through runAgenticFlow.
	 * Used by continueAssistantMessage when classifyContinueIntent returns
	 * next_turn, meaning the target assistant already has its tool_calls paired
	 * with trailing tool results and the next thing to generate is a brand new
	 * turn rather than a token level continuation.
	 */
	private async continueAsNextAgenticTurn(anchorIndex: number): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;
		const anchor = conversationsStore.activeMessages[anchorIndex];
		if (!anchor) return;
		this.send.cancelPreEncode();
		this.runtime.setChatLoading(activeConv.id, true);
		this.runtime.clearChatStreaming(activeConv.id);
		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const anchorMessage = findMessageById(allMessages, anchor.id);
			if (!anchorMessage) {
				this.runtime.setChatLoading(activeConv.id, false);
				return;
			}
			const newAssistantMessage = await DatabaseService.createMessageBranch(
				{
					convId: activeConv.id,
					type: MessageType.TEXT,
					timestamp: Date.now(),
					role: MessageRole.ASSISTANT,
					content: '',
					toolCalls: '',
					children: [],
					model: null
				},
				anchorMessage.id
			);
			await conversationsStore.updateCurrentNode(newAssistantMessage.id);
			conversationsStore.updateConversationTimestamp();
			await conversationsStore.refreshActiveMessages();
			const conversationPath = filterByLeafNodeId(
				allMessages,
				anchorMessage.id,
				false
			) as DatabaseMessage[];
			await this.send.streamChatCompletion(conversationPath, newAssistantMessage);
		} catch (error) {
			if (!isAbortError(error)) console.error('Failed to continue agentic turn:', error);
			this.runtime.setChatLoading(activeConv.id, false);
		}
	}

	async continueAssistantMessage(messageId: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv || this.runtime.isChatLoadingInternal(activeConv.id)) return;
		const result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.ASSISTANT);

		if (!result) return;

		const { message: msg, index: idx } = result;

		// Decide which resume path applies. tool_calls without tool results can
		// not be resumed mid sequence by continue_final_message, branch instead.
		// tool_calls already paired with tool results need a fresh next turn,
		// not a token level continuation of the target assistant.
		const intent = classifyContinueIntent(conversationsStore.activeMessages, idx);
		if (intent.kind === ContinueIntentKind.RERUN_TURN) {
			return this.regenerateMessageWithBranching(messageId);
		}
		if (intent.kind === ContinueIntentKind.NEXT_TURN) {
			return this.continueAsNextAgenticTurn(intent.truncateAfter);
		}

		try {
			this.ui.showErrorDialog(null);
			this.runtime.setChatLoading(activeConv.id, true);
			this.runtime.clearChatStreaming(activeConv.id);

			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const dbMessage = findMessageById(allMessages, messageId);

			if (!dbMessage) {
				this.runtime.setChatLoading(activeConv.id, false);
				return;
			}

			const originalContent = dbMessage.content;
			const originalReasoning = dbMessage.reasoningContent || '';
			// Hand the persisted DatabaseMessage straight to sendMessage so its
			// internal converter preserves tool_calls and extras when present.
			// Reconstructing a bare {role, content} here would drop those fields
			// and break continue_final_message for messages with tool calls.
			const contextWithContinue = conversationsStore.activeMessages.slice(0, idx + 1);

			let appendedContent = '';
			let appendedReasoning = '';
			let hasReceivedContent = false;

			const updateStreamingContent = (fullContent: string) => {
				this.runtime.setChatStreaming(msg.convId, fullContent, msg.id);
				conversationsStore.updateMessageAtIndex(idx, { content: fullContent });
			};

			const abortController = this.runtime.getOrCreateAbortController(msg.convId);

			await ChatService.sendMessage(
				contextWithContinue,
				{
					...this.getApiOptions(),
					continueFinalMessage: true,
					onChunk: (chunk: string) => {
						appendedContent += chunk;
						hasReceivedContent = true;
						updateStreamingContent(originalContent + appendedContent);
						this.runtime.setChatReasoning(msg.convId, false);
					},
					onReasoningChunk: (chunk: string) => {
						appendedReasoning += chunk;
						hasReceivedContent = true;
						// mark streaming state so a stop mid-thinking can persist the partial reasoning
						this.runtime.setChatStreaming(msg.convId, originalContent + appendedContent, msg.id);
						conversationsStore.updateMessageAtIndex(idx, {
							reasoningContent: originalReasoning + appendedReasoning
						});
						this.runtime.setChatReasoning(msg.convId, true);
					},
					onTimings: (timings?: ChatMessageTimings, promptProgress?: ChatMessagePromptProgress) => {
						const tokensPerSecond =
							timings?.predicted_ms && timings?.predicted_n
								? (timings.predicted_n / timings.predicted_ms) * 1000
								: 0;
						this.updateProcessingStateFromTimings(
							{
								prompt_n: timings?.prompt_n || 0,
								prompt_ms: timings?.prompt_ms,
								predicted_n: timings?.predicted_n || 0,
								predicted_per_second: tokensPerSecond,
								cache_n: timings?.cache_n || 0,
								prompt_progress: promptProgress
							},
							msg.convId
						);
					},
					onComplete: async (
						finalContent?: string,
						reasoningContent?: string,
						timings?: ChatMessageTimings
					) => {
						const finalAppendedContent = hasReceivedContent ? appendedContent : finalContent || '';
						const finalAppendedReasoning = hasReceivedContent
							? appendedReasoning
							: reasoningContent || '';
						const fullContent = originalContent + finalAppendedContent;
						const fullReasoning = originalReasoning + finalAppendedReasoning || undefined;

						await DatabaseService.updateMessage(msg.id, {
							content: fullContent,
							reasoningContent: fullReasoning,
							timestamp: Date.now(),
							timings
						});

						conversationsStore.updateMessageAtIndex(idx, {
							content: fullContent,
							reasoningContent: fullReasoning,
							timestamp: Date.now(),
							timings
						});

						conversationsStore.updateConversationTimestamp();

						this.runtime.setChatLoading(msg.convId, false);
						this.runtime.clearChatStreaming(msg.convId);
						this.runtime.setProcessingState(msg.convId, null);
					},
					onError: async (error: Error) => {
						if (isAbortError(error)) {
							if (hasReceivedContent && appendedContent) {
								await DatabaseService.updateMessage(msg.id, {
									content: originalContent + appendedContent,
									reasoningContent: originalReasoning + appendedReasoning || undefined,
									timestamp: Date.now()
								});

								conversationsStore.updateMessageAtIndex(idx, {
									content: originalContent + appendedContent,
									reasoningContent: originalReasoning + appendedReasoning || undefined,
									timestamp: Date.now()
								});
							}

							this.runtime.setChatLoading(msg.convId, false);
							this.runtime.clearChatStreaming(msg.convId);
							this.runtime.setProcessingState(msg.convId, null);

							return;
						}

						console.error('Continue generation error:', error);
						// keep whatever was appended so far, the message stays in memory and in DB
						await DatabaseService.updateMessage(msg.id, {
							content: originalContent + appendedContent,
							reasoningContent: originalReasoning + appendedReasoning || undefined,
							timestamp: Date.now()
						});
						conversationsStore.updateMessageAtIndex(idx, {
							content: originalContent + appendedContent,
							reasoningContent: originalReasoning + appendedReasoning || undefined,
							timestamp: Date.now()
						});

						this.runtime.setChatLoading(msg.convId, false);
						this.runtime.clearChatStreaming(msg.convId);
						this.runtime.setProcessingState(msg.convId, null);
						this.ui.showErrorDialog({
							type:
								error.name === 'TimeoutError' ? ErrorDialogType.TIMEOUT : ErrorDialogType.SERVER,
							message: error.message
						});
					}
				},

				msg.convId,
				abortController.signal
			);
		} catch (error) {
			if (!isAbortError(error)) console.error('Failed to continue message:', error);
			if (activeConv) this.runtime.setChatLoading(activeConv.id, false);
		}
	}

	async editAssistantMessage(
		messageId: string,
		newContent: string,
		shouldBranch: boolean
	): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv || this.runtime.isChatLoadingInternal(activeConv.id)) return;

		const result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.ASSISTANT);
		if (!result) return;

		const { message: msg, index: idx } = result;

		try {
			if (shouldBranch) {
				const newMessage = await DatabaseService.createMessageBranch(
					{
						convId: msg.convId,
						type: msg.type,
						timestamp: Date.now(),
						role: msg.role,
						content: newContent,
						toolCalls: msg.toolCalls || '',
						children: [],
						model: msg.model
					},
					msg.parent!
				);

				await conversationsStore.updateCurrentNode(newMessage.id);
			} else {
				await DatabaseService.updateMessage(msg.id, { content: newContent });
				conversationsStore.updateMessageAtIndex(idx, { content: newContent });
			}

			conversationsStore.updateConversationTimestamp();

			await conversationsStore.refreshActiveMessages();
		} catch (error) {
			console.error('Failed to edit assistant message:', error);
		}
	}

	async editUserMessagePreserveResponses(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;

		const result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.USER);
		if (!result) return;

		const { message: msg, index: idx } = result;
		try {
			const updateData: Partial<DatabaseMessage> = { content: newContent };

			if (newExtras !== undefined) updateData.extra = JSON.parse(JSON.stringify(newExtras));

			await DatabaseService.updateMessage(messageId, updateData);

			conversationsStore.updateMessageAtIndex(idx, updateData);

			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);

			if (rootMessage && msg.parent === rootMessage.id && newContent.trim()) {
				await conversationsStore.updateConversationTitleWithConfirmation(
					activeConv.id,
					generateConversationTitle(newContent, Boolean(config().titleGenerationUseFirstLine))
				);
			}

			conversationsStore.updateConversationTimestamp();
		} catch (error) {
			console.error('Failed to edit user message:', error);
		}
	}

	async editMessageWithBranching(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv || this.runtime.isChatLoadingInternal(activeConv.id)) return;
		let result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.USER);
		if (!result) result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.SYSTEM);
		if (!result) return;
		const { message: msg, index: idx } = result;
		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
			const isFirstUserMessage =
				msg.role === MessageRole.USER && rootMessage && msg.parent === rootMessage.id;
			const extrasToUse =
				newExtras !== undefined
					? JSON.parse(JSON.stringify(newExtras))
					: msg.extra
						? JSON.parse(JSON.stringify(msg.extra))
						: undefined;

			let messageIdForResponse: string;

			const dbMsg = findMessageById(allMessages, msg.id);
			const hasChildren = dbMsg ? dbMsg.children.length > 0 : msg.children.length > 0;

			if (!hasChildren) {
				// No responses after this message — update in place instead of branching
				const updates: Partial<DatabaseMessage> = {
					content: newContent,
					timestamp: Date.now(),
					extra: extrasToUse
				};
				await DatabaseService.updateMessage(msg.id, updates);
				conversationsStore.updateMessageAtIndex(idx, updates);
				messageIdForResponse = msg.id;
			} else {
				// Has children — create a new branch as sibling
				const parentId = msg.parent || rootMessage?.id;
				if (!parentId) return;
				const newMessage = await DatabaseService.createMessageBranch(
					{
						convId: msg.convId,
						type: msg.type,
						timestamp: Date.now(),
						role: msg.role,
						content: newContent,
						toolCalls: msg.toolCalls || '',
						children: [],
						extra: extrasToUse,
						model: msg.model
					},
					parentId
				);
				await conversationsStore.updateCurrentNode(newMessage.id);
				messageIdForResponse = newMessage.id;
			}

			conversationsStore.updateConversationTimestamp();
			if (isFirstUserMessage && newContent.trim())
				await conversationsStore.updateConversationTitleWithConfirmation(
					activeConv.id,
					generateConversationTitle(newContent, Boolean(config().titleGenerationUseFirstLine))
				);
			await conversationsStore.refreshActiveMessages();
			if (msg.role === MessageRole.USER)
				await this.generateResponseForMessage(messageIdForResponse);
		} catch (error) {
			console.error('Failed to edit message with branching:', error);
		}
	}

	private async generateResponseForMessage(userMessageId: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;

		this.ui.showErrorDialog(null);
		this.runtime.setChatLoading(activeConv.id, true);
		this.runtime.clearChatStreaming(activeConv.id);

		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const conversationPath = filterByLeafNodeId(
				allMessages,
				userMessageId,
				false
			) as DatabaseMessage[];
			const assistantMessage = await DatabaseService.createMessageBranch(
				{
					convId: activeConv.id,
					type: MessageType.TEXT,
					timestamp: Date.now(),
					role: MessageRole.ASSISTANT,
					content: '',
					toolCalls: '',
					children: [],
					model: null
				},
				userMessageId
			);

			conversationsStore.addMessageToActive(assistantMessage);

			await this.send.streamChatCompletion(conversationPath, assistantMessage);
		} catch (error) {
			console.error('Failed to generate response:', error);
			this.runtime.setChatLoading(activeConv.id, false);
		}
	}

	updateProcessingStateFromTimings(
		timingData: {
			prompt_n: number;
			prompt_ms?: number;
			predicted_n: number;
			predicted_per_second: number;
			cache_n: number;
			prompt_progress?: ChatMessagePromptProgress;
		},
		conversationId?: string
	): void {
		this.runtime.updateProcessingStateFromTimings(timingData, conversationId);
	}

	restoreProcessingStateFromMessages(messages: DatabaseMessage[], conversationId: string): void {
		this.runtime.restoreProcessingStateFromMessages(messages, conversationId);
	}

	getConversationModel(messages: DatabaseMessage[]): string | null {
		return computeConversationModel(messages);
	}

	private getApiOptions(): Record<string, unknown> {
		return computeApiOptions();
	}

}

export const chatStore = new ChatStore();

export const activeProcessingState = () => chatStore.activeProcessingState;
export const currentResponse = () => chatStore.currentResponse;
export const errorDialog = () => chatStore.errorDialogState;
export const getAddFilesHandler = () => chatStore.getAddFilesHandler();
export const getAllLoadingChats = () => chatStore.getAllLoadingChats();
export const getAllStreamingChats = () => chatStore.getAllStreamingChats();
export const getChatStreaming = (convId: string) => chatStore.getChatStreamingPublic(convId);
export const isChatLoading = (convId: string) => chatStore.isChatLoadingPublic(convId);
export const isChatStreaming = () => chatStore.isStreaming();
export const isEditing = () => chatStore.isEditing();
export const isLoading = () => chatStore.isLoading;
export const isReasoning = () => chatStore.isReasoning;
export const pendingEditMessageId = () => chatStore.pendingEditMessageId;
export const chatHasPendingMessage = (convId: string) => chatStore.hasPendingMessage(convId);
export const chatPendingMessageContent = (convId: string) =>
	chatStore.pendingMessageContent(convId);
export const chatPendingMessageExtras = (convId: string) => chatStore.pendingMessageExtras(convId);
export const chatClearPendingMessage = (convId: string) => chatStore.clearPendingMessage(convId);
export const chatInjectPendingMessage = (
	convId: string,
	content: string,
	extras?: DatabaseMessageExtra[]
) => chatStore.injectPendingMessage(convId, content, extras);
