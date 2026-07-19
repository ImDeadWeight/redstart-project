/**
 * chat-send - The send/streaming pipeline for the chat store.
 *
 * Drives sendMessage, streamChatCompletion, generation stop/save, and KV-cache
 * pre-encoding. Depends on ChatRuntimeState + ChatUiState (passed in) plus the
 * stateless services and helpers it imports directly. Never imports the facade.
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
import * as messageRepo from '$lib/stores/chat/chat-message-repo';
import { normalizeModelName, isAbortError, generateConversationTitle } from '$lib/utils';
import { ErrorDialogType, MessageRole, MessageType } from '$lib/enums';
import type {
	ChatMessageTimings,
	ChatMessagePromptProgress,
	ChatStreamCallbacks
} from '$lib/types/chat';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types';
import type { ChatRuntimeState } from '$lib/stores/chat/chat-runtime.svelte';
import type { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';

export class ChatSendController {
	private preEncodeAbortController: AbortController | null = null;

	constructor(
		private readonly runtime: ChatRuntimeState,
		private readonly ui: ChatUiState
	) {}

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
			this.ui.injectPendingMessage(activeConv.id, content, extras);
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
			const userMessage = await messageRepo.addMessage(
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

	async streamChatCompletion(
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
			const conversationModel = computeConversationModel(allMessages);
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
		this.runtime.setActiveProcessingConversation(convId);
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
				this.runtime.updateProcessingStateFromTimings(
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
				this.ui.clearPendingMessage(convId);

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
					...computeApiOptions(),
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
				...computeApiOptions(),
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
		this.ui.clearPendingMessage(convId);
	}

	async savePartialResponseIfNeeded(convId?: string): Promise<void> {
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
			const lastKnownState = this.runtime.getProcessingState(conversationId);
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

	cancelPreEncode(): void {
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
