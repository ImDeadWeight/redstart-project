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
import { ContextCompactionService } from '$lib/services/context-compaction.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { config } from '$lib/stores/settings.svelte';
import { agenticStore } from '$lib/stores/agentic.svelte';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { isRouterMode } from '$lib/stores/server.svelte';
import { selectedModelName, modelsStore } from '$lib/stores/models.svelte';
import {
	getApiOptions as computeApiOptions,
	getConversationModel as computeConversationModel
} from '$lib/stores/chat/chat-options';
import { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';
import { ChatRuntimeState } from '$lib/stores/chat/chat-runtime.svelte';
import * as messageRepo from '$lib/stores/chat/chat-message-repo';
import {
	normalizeModelName,
	filterByLeafNodeId,
	findDescendantMessages,
	findLeafNode,
	findMessageById,
	isAbortError,
	generateConversationTitle
} from '$lib/utils';
import { classifyContinueIntent } from '$lib/utils/agentic';
import type {
	ChatMessageTimings,
	ChatMessagePromptProgress,
	ChatStreamCallbacks,
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

	private preEncodeAbortController: AbortController | null = null;

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
		if (!content.trim() && (!extras || extras.length === 0)) return;
		const activeConv = conversationsStore.activeConversation;

		// If agentic loop is running, inject as a steering message instead of starting a new flow
		if (activeConv && agenticStore.isRunning(activeConv.id)) {
			agenticStore.injectSteeringMessage(activeConv.id, content, extras);
			return;
		}

		// If non-agentic streaming is active, queue as a pending message to send after completion
		if (activeConv && this.runtime.isChatLoadingInternal(activeConv.id)) {
			this.injectPendingMessage(activeConv.id, content, extras);
			return;
		}

		// Cancel any in-flight pre-encode request
		this.cancelPreEncode();

		// Consume MCP resource attachments - converts them to extras and clears the live store
		const resourceExtras = mcpStore.consumeResourceAttachmentsAsExtras();
		const allExtras = resourceExtras.length > 0 ? [...(extras || []), ...resourceExtras] : extras;

		let isNewConversation = false;
		if (!activeConv) {
			await conversationsStore.createConversation();
			isNewConversation = true;
		}
		const currentConv = conversationsStore.activeConversation;
		if (!currentConv) return;
		this.ui.showErrorDialog(null);
		this.runtime.setChatLoading(currentConv.id, true);
		this.runtime.clearChatStreaming(currentConv.id);
		try {
			let parentIdForUserMessage: string | undefined;
			if (isNewConversation) {
				const rootId = await DatabaseService.createRootMessage(currentConv.id);
				const currentConfig = config();
				const systemPrompt = currentConfig.systemMessage?.toString().trim();
				if (systemPrompt) {
					const systemMessage = await DatabaseService.createSystemMessage(
						currentConv.id,
						systemPrompt,
						rootId
					);
					conversationsStore.addMessageToActive(systemMessage);
					parentIdForUserMessage = systemMessage.id;
				} else parentIdForUserMessage = rootId;
			}
			const userMessage = await this.addMessage(
				MessageRole.USER,
				content,
				MessageType.TEXT,
				parentIdForUserMessage ?? '-1',
				allExtras
			);
			if (isNewConversation && content)
				await conversationsStore.updateConversationName(
					currentConv.id,
					generateConversationTitle(content, Boolean(config().titleGenerationUseFirstLine))
				);
			const assistantMessage = await messageRepo.createAssistantMessage(userMessage.id);
			conversationsStore.addMessageToActive(assistantMessage);
			await this.streamChatCompletion(
				conversationsStore.activeMessages.slice(0, -1),
				assistantMessage
			);
		} catch (error) {
			if (isAbortError(error)) {
				this.runtime.setChatLoading(currentConv.id, false);
				return;
			}
			console.error('Failed to send message:', error);
			this.runtime.setChatLoading(currentConv.id, false);
			const dialogType =
				error instanceof Error && error.name === 'TimeoutError'
					? ErrorDialogType.TIMEOUT
					: ErrorDialogType.SERVER;
			const contextInfo = (
				error as Error & { contextInfo?: { n_prompt_tokens: number; n_ctx: number } }
			).contextInfo;
			this.ui.showErrorDialog({
				type: dialogType,
				message: error instanceof Error ? error.message : 'Unknown error',
				contextInfo
			});
		}
	}

	private async streamChatCompletion(
		allMessages: DatabaseMessage[],
		assistantMessage: DatabaseMessage,
		onComplete?: (content: string) => Promise<void>,
		onError?: (error: Error) => void,
		modelOverride?: string | null
	): Promise<void> {
		// Proactive context compaction: if the assembled history would overflow
		// the model's context window, fold the oldest turns into a running
		// summary before anything is sent (see ContextCompactionService). This
		// single choke point covers both the agentic and plain streaming paths.
		// The rewrite affects only the API payload — the stored conversation and
		// visible history are untouched.
		({ messages: allMessages } = await ContextCompactionService.maybeCompact(
			assistantMessage.convId,
			allMessages
		));

		let effectiveModel = modelOverride;

		if (isRouterMode() && !effectiveModel) {
			const conversationModel = this.getConversationModel(allMessages);
			effectiveModel = selectedModelName() || conversationModel;
		}

		if (isRouterMode() && effectiveModel) {
			if (!modelsStore.getModelProps(effectiveModel))
				await modelsStore.fetchModelProps(effectiveModel);
		}

		// Mutable state for the current message being streamed
		let currentMessageId = assistantMessage.id;
		let streamedContent = '';
		let streamedReasoningContent = '';
		let resolvedModel: string | null = null;
		let modelPersisted = false;
		const convId = assistantMessage.convId;

		const recordModel = (modelName: string | null | undefined, persistImmediately = true): void => {
			if (!modelName) return;
			const n = normalizeModelName(modelName);
			if (!n || n === resolvedModel) return;
			resolvedModel = n;
			const idx = conversationsStore.findMessageIndex(currentMessageId);
			conversationsStore.updateMessageAtIndex(idx, { model: n });
			if (persistImmediately && !modelPersisted) {
				modelPersisted = true;
				DatabaseService.updateMessage(currentMessageId, { model: n }).catch(() => {
					modelPersisted = false;
					resolvedModel = null;
				});
			}
		};

		let completionIdRecorded = false;
		const recordCompletionId = (id: string): void => {
			if (!id || completionIdRecorded) return;
			completionIdRecorded = true;
			const idx = conversationsStore.findMessageIndex(currentMessageId);
			conversationsStore.updateMessageAtIndex(idx, { completionId: id });
			DatabaseService.updateMessage(currentMessageId, { completionId: id }).catch(() => {
				completionIdRecorded = false;
			});
		};

		const updateStreamingUI = () => {
			this.runtime.setChatStreaming(convId, streamedContent, currentMessageId);
			const idx = conversationsStore.findMessageIndex(currentMessageId);
			conversationsStore.updateMessageAtIndex(idx, { content: streamedContent });
		};

		const cleanupStreamingState = () => {
			this.runtime.setStreamingActive(false);
			this.runtime.setChatLoading(convId, false);
			this.runtime.clearChatStreaming(convId);
			this.runtime.setProcessingState(convId, null);
		};

		this.runtime.setStreamingActive(true);
		this.setActiveProcessingConversation(convId);
		const abortController = this.runtime.getOrCreateAbortController(convId);

		const streamCallbacks: ChatStreamCallbacks = {
			onChunk: (chunk: string) => {
				streamedContent += chunk;
				updateStreamingUI();
				this.runtime.setChatReasoning(convId, false);
			},
			onReasoningChunk: (chunk: string) => {
				streamedReasoningContent += chunk;
				// mark streaming state so a stop mid-thinking can persist the partial reasoning
				this.runtime.setChatStreaming(convId, streamedContent, currentMessageId);
				const idx = conversationsStore.findMessageIndex(currentMessageId);
				conversationsStore.updateMessageAtIndex(idx, {
					reasoningContent: streamedReasoningContent
				});
				this.runtime.setChatReasoning(convId, true);
			},
			onToolCallsStreaming: (toolCalls) => {
				const idx = conversationsStore.findMessageIndex(currentMessageId);
				conversationsStore.updateMessageAtIndex(idx, {
					toolCalls: JSON.stringify(toolCalls)
				});
			},
			onAttachments: (messageId: string, extras: DatabaseMessageExtra[]) => {
				if (!extras.length) return;
				const idx = conversationsStore.findMessageIndex(messageId);
				if (idx === -1) return;
				const msg = conversationsStore.activeMessages[idx];
				const updatedExtras = [...(msg.extra || []), ...extras];
				conversationsStore.updateMessageAtIndex(idx, { extra: updatedExtras });
				DatabaseService.updateMessage(messageId, { extra: updatedExtras }).catch(console.error);
			},
			onModel: (modelName: string) => recordModel(modelName),
			onCompletionId: (id: string) => recordCompletionId(id),
			onTurnComplete: (intermediateTimings: ChatMessageTimings) => {
				// Update the first assistant message with cumulative agentic timings
				const idx = conversationsStore.findMessageIndex(assistantMessage.id);
				conversationsStore.updateMessageAtIndex(idx, { timings: intermediateTimings });
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
					convId
				);
			},
			onAssistantTurnComplete: async (
				content: string,
				reasoningContent: string | undefined,
				timings: ChatMessageTimings | undefined,
				toolCalls: import('$lib/types/api').ApiChatCompletionToolCall[] | undefined
			) => {
				const updateData: Record<string, unknown> = {
					content,
					reasoningContent: reasoningContent || undefined,
					toolCalls: toolCalls ? JSON.stringify(toolCalls) : '',
					timings
				};
				if (resolvedModel && !modelPersisted) updateData.model = resolvedModel;
				await DatabaseService.updateMessage(currentMessageId, updateData);
				const idx = conversationsStore.findMessageIndex(currentMessageId);
				const uiUpdate: Partial<DatabaseMessage> = {
					content,
					reasoningContent: reasoningContent || undefined,
					toolCalls: toolCalls ? JSON.stringify(toolCalls) : ''
				};
				if (timings) uiUpdate.timings = timings;
				if (resolvedModel) uiUpdate.model = resolvedModel;
				conversationsStore.updateMessageAtIndex(idx, uiUpdate);
				await conversationsStore.updateCurrentNode(currentMessageId);
			},
			createToolResultMessage: async (
				toolCallId: string,
				content: string,
				extras?: DatabaseMessageExtra[]
			) => {
				const msg = await DatabaseService.createMessageBranch(
					{
						convId,
						type: MessageType.TEXT,
						role: MessageRole.TOOL,
						content,
						toolCallId,
						timestamp: Date.now(),
						toolCalls: '',
						children: [],
						extra: extras
					},
					currentMessageId
				);
				conversationsStore.addMessageToActive(msg);
				await conversationsStore.updateCurrentNode(msg.id);
				return msg;
			},
			createAssistantMessage: async () => {
				// Reset streaming state for new message
				streamedContent = '';
				streamedReasoningContent = '';

				const lastMsg =
					conversationsStore.activeMessages[conversationsStore.activeMessages.length - 1];
				const msg = await DatabaseService.createMessageBranch(
					{
						convId,
						type: MessageType.TEXT,
						role: MessageRole.ASSISTANT,
						content: '',
						timestamp: Date.now(),
						toolCalls: '',
						children: [],
						model: resolvedModel
					},
					lastMsg.id
				);
				conversationsStore.addMessageToActive(msg);
				currentMessageId = msg.id;
				return msg;
			},
			onFlowComplete: (finalTimings?: ChatMessageTimings) => {
				if (finalTimings) {
					const idx = conversationsStore.findMessageIndex(assistantMessage.id);

					conversationsStore.updateMessageAtIndex(idx, { timings: finalTimings });
					DatabaseService.updateMessage(assistantMessage.id, {
						timings: finalTimings
					}).catch(console.error);
				}

				cleanupStreamingState();

				if (onComplete) onComplete(streamedContent);
				if (isRouterMode()) modelsStore.fetchRouterModels().catch(console.error);
				// Pre-encode conversation in KV cache for faster next turn
				if (config().preEncodeConversation) {
					this.triggerPreEncode(
						allMessages,
						assistantMessage,
						streamedContent,
						effectiveModel,
						!!config().excludeReasoningFromContext
					);
				}
			},
			onError: async (error: Error) => {
				this.runtime.setStreamingActive(false);
				if (isAbortError(error)) {
					cleanupStreamingState();
					// If aborted with a pending message (e.g. "Send immediately"), re-send it
					const pending = this.ui.consumePendingMessage(convId);
					if (pending) {
						this.sendMessage(pending.content, pending.extras);
					}
					return;
				}
				console.error('Streaming error:', error);
				// keep whatever was streamed so far, the message stays in memory and in DB
				await this.savePartialResponseIfNeeded(convId);
				cleanupStreamingState();
				this.clearPendingMessage(convId);

				const contextInfo = (
					error as Error & { contextInfo?: { n_prompt_tokens: number; n_ctx: number } }
				).contextInfo;
				this.ui.showErrorDialog({
					type: error.name === 'TimeoutError' ? ErrorDialogType.TIMEOUT : ErrorDialogType.SERVER,
					message: error.message,
					contextInfo
				});
				if (onError) onError(error);
			}
		};

		const perChatOverrides = conversationsStore.activeConversation?.mcpServerOverrides;

		{
			const agenticResult = await agenticStore.runAgenticFlow({
				conversationId: convId,
				messages: allMessages,
				options: {
					...this.getApiOptions(),
					...(effectiveModel ? { model: effectiveModel } : {})
				},
				callbacks: streamCallbacks,
				signal: abortController.signal,
				perChatOverrides
			});
			if (agenticResult.handled) {
				// Check if there's a pending steering message to re-send
				const pending = agenticStore.consumePendingSteeringMessage(convId);
				if (pending) {
					await this.sendMessage(pending.content, pending.extras);
				}
				return;
			}
		}

		await ChatService.sendMessage(
			allMessages,
			{
				...this.getApiOptions(),
				...(effectiveModel ? { model: effectiveModel } : {}),
				stream: true,
				onChunk: streamCallbacks.onChunk,
				onReasoningChunk: streamCallbacks.onReasoningChunk,
				onModel: streamCallbacks.onModel,
				onCompletionId: streamCallbacks.onCompletionId,
				onTimings: streamCallbacks.onTimings,
				onComplete: async (
					finalContent?: string,
					reasoningContent?: string,
					timings?: ChatMessageTimings,
					toolCalls?: string
				) => {
					const content = streamedContent || finalContent || '';
					const reasoning = streamedReasoningContent || reasoningContent;
					const updateData: Record<string, unknown> = {
						content,
						reasoningContent: reasoning || undefined,
						toolCalls: toolCalls || '',
						timings
					};
					if (resolvedModel && !modelPersisted) updateData.model = resolvedModel;
					await DatabaseService.updateMessage(currentMessageId, updateData);
					const idx = conversationsStore.findMessageIndex(currentMessageId);
					const uiUpdate: Partial<DatabaseMessage> = {
						content,
						reasoningContent: reasoning || undefined,
						toolCalls: toolCalls || ''
					};
					if (timings) uiUpdate.timings = timings;
					if (resolvedModel) uiUpdate.model = resolvedModel;
					conversationsStore.updateMessageAtIndex(idx, uiUpdate);
					await conversationsStore.updateCurrentNode(currentMessageId);
					cleanupStreamingState();
					if (onComplete) await onComplete(content);
					if (isRouterMode()) modelsStore.fetchRouterModels().catch(console.error);

					// Check if there's a pending message queued during streaming
					const pending = this.ui.consumePendingMessage(convId);
					if (pending) {
						await this.sendMessage(pending.content, pending.extras);
					}
				},
				onError: streamCallbacks.onError
			},
			convId,
			abortController.signal
		);
	}

	async stopGeneration(): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;
		await this.stopGenerationForChat(activeConv.id);
	}
	async stopGenerationForChat(convId: string): Promise<void> {
		await this.savePartialResponseIfNeeded(convId);
		this.runtime.setStreamingActive(false);
		this.runtime.abortRequest(convId);
		this.runtime.setChatLoading(convId, false);
		this.runtime.clearChatStreaming(convId);
		this.runtime.setProcessingState(convId, null);
		this.clearPendingMessage(convId);
	}

	private async savePartialResponseIfNeeded(convId?: string): Promise<void> {
		const conversationId = convId || conversationsStore.activeConversation?.id;
		if (!conversationId) return;
		const streamingState = this.runtime.getChatStreaming(conversationId);
		if (!streamingState) return;
		const messages =
			conversationId === conversationsStore.activeConversation?.id
				? conversationsStore.activeMessages
				: await conversationsStore.getConversationMessages(conversationId);
		if (!messages.length) return;
		const lastMessage = messages[messages.length - 1];
		if (lastMessage?.role !== MessageRole.ASSISTANT) return;

		const partialContent = streamingState.response;
		const partialReasoning = lastMessage.reasoningContent || '';

		// nothing to persist when both content and reasoning are empty (e.g. stop before any token)
		if (!partialContent.trim() && !partialReasoning.trim()) return;

		try {
			const updateData: {
				content: string;
				reasoningContent?: string;
				timings?: ChatMessageTimings;
			} = {
				content: partialContent
			};
			if (partialReasoning) {
				updateData.reasoningContent = partialReasoning;
			}
			const lastKnownState = this.getProcessingState(conversationId);
			if (lastKnownState) {
				updateData.timings = {
					prompt_n: lastKnownState.promptTokens || 0,
					prompt_ms: lastKnownState.promptMs,
					predicted_n: lastKnownState.tokensDecoded || 0,
					cache_n: lastKnownState.cacheTokens || 0,
					predicted_ms:
						lastKnownState.tokensPerSecond && lastKnownState.tokensDecoded
							? (lastKnownState.tokensDecoded / lastKnownState.tokensPerSecond) * 1000
							: undefined
				};
			}
			await DatabaseService.updateMessage(lastMessage.id, updateData);
			lastMessage.content = partialContent;
			if (updateData.timings) lastMessage.timings = updateData.timings;
		} catch (error) {
			lastMessage.content = partialContent;
			console.error('Failed to save partial response:', error);
		}
	}

	async updateMessage(messageId: string, newContent: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;
		if (this.runtime.isChatLoadingInternal(activeConv.id)) await this.stopGeneration();
		const result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.USER);
		if (!result) return;
		const { message: messageToUpdate, index: messageIndex } = result;
		const originalContent = messageToUpdate.content;
		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const rootMessage = allMessages.find((m) => m.type === 'root' && m.parent === null);
			const isFirstUserMessage = rootMessage && messageToUpdate.parent === rootMessage.id;
			conversationsStore.updateMessageAtIndex(messageIndex, { content: newContent });
			await DatabaseService.updateMessage(messageId, { content: newContent });
			if (isFirstUserMessage && newContent.trim())
				await conversationsStore.updateConversationTitleWithConfirmation(
					activeConv.id,
					generateConversationTitle(newContent, Boolean(config().titleGenerationUseFirstLine))
				);
			const messagesToRemove = conversationsStore.activeMessages.slice(messageIndex + 1);
			for (const message of messagesToRemove) await DatabaseService.deleteMessage(message.id);
			conversationsStore.sliceActiveMessages(messageIndex + 1);
			conversationsStore.updateConversationTimestamp();
			this.runtime.setChatLoading(activeConv.id, true);
			this.runtime.clearChatStreaming(activeConv.id);
			const assistantMessage = await messageRepo.createAssistantMessage();
			conversationsStore.addMessageToActive(assistantMessage);
			await conversationsStore.updateCurrentNode(assistantMessage.id);
			await this.streamChatCompletion(
				conversationsStore.activeMessages.slice(0, -1),
				assistantMessage,
				undefined,
				() => {
					conversationsStore.updateMessageAtIndex(conversationsStore.findMessageIndex(messageId), {
						content: originalContent
					});
				}
			);
		} catch (error) {
			if (!isAbortError(error)) console.error('Failed to update message:', error);
		}
	}

	async regenerateMessage(messageId: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv || this.runtime.isChatLoadingInternal(activeConv.id)) return;
		this.cancelPreEncode();
		const result = messageRepo.getMessageByIdWithRole(messageId, MessageRole.ASSISTANT);
		if (!result) return;
		const { index: messageIndex } = result;
		try {
			const messagesToRemove = conversationsStore.activeMessages.slice(messageIndex);
			for (const message of messagesToRemove) await DatabaseService.deleteMessage(message.id);
			conversationsStore.sliceActiveMessages(messageIndex);
			conversationsStore.updateConversationTimestamp();
			this.runtime.setChatLoading(activeConv.id, true);
			this.runtime.clearChatStreaming(activeConv.id);
			const parentMessageId =
				conversationsStore.activeMessages.length > 0
					? conversationsStore.activeMessages[conversationsStore.activeMessages.length - 1].id
					: undefined;
			const assistantMessage = await messageRepo.createAssistantMessage(parentMessageId);
			conversationsStore.addMessageToActive(assistantMessage);
			await this.streamChatCompletion(
				conversationsStore.activeMessages.slice(0, -1),
				assistantMessage
			);
		} catch (error) {
			if (!isAbortError(error)) console.error('Failed to regenerate message:', error);
			this.runtime.setChatLoading(activeConv?.id || '', false);
		}
	}

	async regenerateMessageWithBranching(messageId: string, modelOverride?: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv || this.runtime.isChatLoadingInternal(activeConv.id)) return;
		this.cancelPreEncode();
		try {
			const idx = conversationsStore.findMessageIndex(messageId);
			if (idx === -1) return;
			const msg = conversationsStore.activeMessages[idx];
			if (msg.role !== MessageRole.ASSISTANT) return;
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const parentMessage = findMessageById(allMessages, msg.parent);
			if (!parentMessage) return;
			this.runtime.setChatLoading(activeConv.id, true);
			this.runtime.clearChatStreaming(activeConv.id);
			const newAssistantMessage = await DatabaseService.createMessageBranch(
				{
					convId: msg.convId,
					type: msg.type,
					timestamp: Date.now(),
					role: msg.role,
					content: '',
					toolCalls: '',
					children: [],
					model: null
				},
				parentMessage.id
			);
			await conversationsStore.updateCurrentNode(newAssistantMessage.id);
			conversationsStore.updateConversationTimestamp();
			await conversationsStore.refreshActiveMessages();
			const conversationPath = filterByLeafNodeId(
				allMessages,
				parentMessage.id,
				false
			) as DatabaseMessage[];
			const modelToUse = modelOverride || msg.model || undefined;
			await this.streamChatCompletion(
				conversationPath,
				newAssistantMessage,
				undefined,
				undefined,
				modelToUse
			);
		} catch (error) {
			if (!isAbortError(error))
				console.error('Failed to regenerate message with branching:', error);
			this.runtime.setChatLoading(activeConv?.id || '', false);
		}
	}

	async getDeletionInfo(messageId: string): Promise<{
		totalCount: number;
		userMessages: number;
		assistantMessages: number;
		messageTypes: string[];
	}> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv)
			return { totalCount: 0, userMessages: 0, assistantMessages: 0, messageTypes: [] };
		const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
		const messageToDelete = findMessageById(allMessages, messageId);

		// For system messages, don't count descendants as they will be preserved (reparented to root)
		if (messageToDelete?.role === MessageRole.SYSTEM) {
			const messagesToDelete = allMessages.filter((m) => m.id === messageId);
			let userMessages = 0,
				assistantMessages = 0;
			const messageTypes: string[] = [];

			for (const msg of messagesToDelete) {
				if (msg.role === MessageRole.USER) {
					userMessages++;
					if (!messageTypes.includes('user message')) messageTypes.push('user message');
				} else if (msg.role === MessageRole.ASSISTANT) {
					assistantMessages++;
					if (!messageTypes.includes('assistant response')) messageTypes.push('assistant response');
				}
			}

			return { totalCount: 1, userMessages, assistantMessages, messageTypes };
		}

		const descendants = findDescendantMessages(allMessages, messageId);
		const allToDelete = [messageId, ...descendants];
		const messagesToDelete = allMessages.filter((m) => allToDelete.includes(m.id));
		let userMessages = 0,
			assistantMessages = 0;
		const messageTypes: string[] = [];

		for (const msg of messagesToDelete) {
			if (msg.role === MessageRole.USER) {
				userMessages++;
				if (!messageTypes.includes('user message')) messageTypes.push('user message');
			} else if (msg.role === MessageRole.ASSISTANT) {
				assistantMessages++;
				if (!messageTypes.includes('assistant response')) messageTypes.push('assistant response');
			}
		}

		return { totalCount: allToDelete.length, userMessages, assistantMessages, messageTypes };
	}

	async deleteMessage(messageId: string): Promise<void> {
		const activeConv = conversationsStore.activeConversation;
		if (!activeConv) return;
		try {
			const allMessages = await conversationsStore.getConversationMessages(activeConv.id);
			const messageToDelete = findMessageById(allMessages, messageId);

			if (!messageToDelete) return;

			const currentPath = filterByLeafNodeId(allMessages, activeConv.currNode || '', false);
			const isInCurrentPath = currentPath.some((m) => m.id === messageId);

			if (isInCurrentPath && messageToDelete.parent) {
				const siblings = allMessages.filter(
					(m) => m.parent === messageToDelete.parent && m.id !== messageId
				);

				if (siblings.length > 0) {
					const latestSibling = siblings.reduce((latest, sibling) =>
						sibling.timestamp > latest.timestamp ? sibling : latest
					);

					await conversationsStore.updateCurrentNode(findLeafNode(allMessages, latestSibling.id));
				} else if (messageToDelete.parent) {
					await conversationsStore.updateCurrentNode(
						findLeafNode(allMessages, messageToDelete.parent)
					);
				}
			}

			await DatabaseService.deleteMessageCascading(activeConv.id, messageId);
			await conversationsStore.refreshActiveMessages();

			conversationsStore.updateConversationTimestamp();
		} catch (error) {
			console.error('Failed to delete message:', error);
		}
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
		this.cancelPreEncode();
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
			await this.streamChatCompletion(conversationPath, newAssistantMessage);
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

			await this.streamChatCompletion(conversationPath, assistantMessage);
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

	private cancelPreEncode(): void {
		if (this.preEncodeAbortController) {
			this.preEncodeAbortController.abort();
			this.preEncodeAbortController = null;
		}
	}

	private async triggerPreEncode(
		allMessages: DatabaseMessage[],
		assistantMessage: DatabaseMessage,
		assistantContent: string,
		model?: string | null,
		excludeReasoning?: boolean
	): Promise<void> {
		this.cancelPreEncode();
		this.preEncodeAbortController = new AbortController();

		const signal = this.preEncodeAbortController.signal;

		try {
			const allIdle = await ChatService.areAllSlotsIdle(model, signal);
			if (!allIdle || signal.aborted) return;

			const messagesWithAssistant: DatabaseMessage[] = [
				...allMessages,
				{ ...assistantMessage, content: assistantContent }
			];

			await ChatService.preEncode(messagesWithAssistant, model, excludeReasoning, signal);
		} catch (err) {
			if (!isAbortError(err)) {
				console.warn('[ChatStore] Pre-encode failed:', err);
			}
		}
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
