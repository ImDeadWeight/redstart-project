/**
 * chat-send - The send/streaming pipeline for the chat store.
 *
 * Drives sendMessage, streamChatCompletion, and generation stop/save. Depends
 * on ChatRuntimeState + ChatUiState (passed in) plus the stateless services and
 * helpers it imports directly. Never imports the facade.
 */

import { DatabaseService } from '$lib/services/database.service';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { MessageRole } from '$lib/enums';
import type { ChatMessageTimings } from '$lib/types/chat';
import type { ChatRuntimeState } from '$lib/stores/chat/chat-runtime.svelte';
import type { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';

export class ChatSendController {
	constructor(
		private readonly runtime: ChatRuntimeState,
		private readonly ui: ChatUiState
	) {}

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
}
