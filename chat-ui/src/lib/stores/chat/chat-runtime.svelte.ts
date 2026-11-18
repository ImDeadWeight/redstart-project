/**
 * chat-runtime - Per-conversation transient runtime state for the chat store.
 *
 * Owns the loading / reasoning / streaming maps, the active-conversation
 * processing state, abort controllers, and the inactive-conversation-state GC.
 * Holds no send/API logic; the facade and send controller drive it.
 */

import { SvelteMap } from 'svelte/reactivity';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import {
	getContextTotal as computeContextTotal,
	parseTimingData as computeTimingData
} from '$lib/stores/chat/chat-options';
import {
	MAX_INACTIVE_CONVERSATION_STATES,
	INACTIVE_CONVERSATION_STATE_MAX_AGE_MS
} from '$lib/constants';
import type { ChatMessagePromptProgress } from '$lib/types/chat';
import type { ApiProcessingState, DatabaseMessage } from '$lib/types';
import { MessageRole } from '$lib/enums';

interface ConversationStateEntry {
	lastAccessed: number;
}

export class ChatRuntimeState {
	activeProcessingState = $state<ApiProcessingState | null>(null);
	currentResponse = $state('');
	isLoading = $state(false);
	// true while the active conversation streams reasoning content but no visible content yet
	isReasoning = $state(false);
	chatLoadingStates = new SvelteMap<string, boolean>();
	chatReasoningStates = new SvelteMap<string, boolean>();
	chatStreamingStates = new SvelteMap<string, { response: string; messageId: string }>();
	private abortControllers = new SvelteMap<string, AbortController>();
	private processingStates = new SvelteMap<string, ApiProcessingState | null>();
	private conversationStateTimestamps = new SvelteMap<string, ConversationStateEntry>();
	private activeConversationId = $state<string | null>(null);
	private isStreamingActive = $state(false);

	setChatLoading(convId: string, loading: boolean): void {
		this.touchConversationState(convId);
		if (loading) {
			this.chatLoadingStates.set(convId, true);
			if (convId === conversationsStore.activeConversation?.id) this.isLoading = true;
		} else {
			this.chatLoadingStates.delete(convId);
			if (convId === conversationsStore.activeConversation?.id) this.isLoading = false;
			this.setChatReasoning(convId, false);
		}
	}

	setChatReasoning(convId: string, reasoning: boolean): void {
		if (reasoning) {
			this.chatReasoningStates.set(convId, true);
			if (convId === conversationsStore.activeConversation?.id) this.isReasoning = true;
		} else {
			this.chatReasoningStates.delete(convId);
			if (convId === conversationsStore.activeConversation?.id) this.isReasoning = false;
		}
	}
	setChatStreaming(convId: string, response: string, messageId: string): void {
		this.touchConversationState(convId);
		this.chatStreamingStates.set(convId, { response, messageId });
		if (convId === conversationsStore.activeConversation?.id) this.currentResponse = response;
	}
	clearChatStreaming(convId: string): void {
		this.chatStreamingStates.delete(convId);
		if (convId === conversationsStore.activeConversation?.id) this.currentResponse = '';
	}
	getChatStreaming(convId: string): { response: string; messageId: string } | undefined {
		return this.chatStreamingStates.get(convId);
	}
	syncLoadingStateForChat(convId: string): void {
		this.isLoading = this.chatLoadingStates.get(convId) || false;
		this.isReasoning = this.chatReasoningStates.get(convId) || false;
		const s = this.chatStreamingStates.get(convId);
		this.currentResponse = s?.response || '';
		this.isStreamingActive = s !== undefined;
		this.setActiveProcessingConversation(convId);
		// Sync streaming content to activeMessages so UI displays current content
		if (s?.response && s?.messageId) {
			const idx = conversationsStore.findMessageIndex(s.messageId);
			if (idx !== -1) {
				conversationsStore.updateMessageAtIndex(idx, { content: s.response });
			}
		}
	}

	clearUIState(): void {
		this.isLoading = false;
		this.currentResponse = '';
		this.isStreamingActive = false;
	}

	setActiveProcessingConversation(conversationId: string | null): void {
		this.activeConversationId = conversationId;
		this.activeProcessingState = conversationId
			? this.processingStates.get(conversationId) || null
			: null;
	}

	getProcessingState(conversationId: string): ApiProcessingState | null {
		return this.processingStates.get(conversationId) || null;
	}

	setProcessingState(conversationId: string, state: ApiProcessingState | null): void {
		if (state === null) this.processingStates.delete(conversationId);
		else this.processingStates.set(conversationId, state);
		if (conversationId === this.activeConversationId) this.activeProcessingState = state;
	}

	clearProcessingState(conversationId: string): void {
		this.processingStates.delete(conversationId);
		if (conversationId === this.activeConversationId) this.activeProcessingState = null;
	}

	getActiveProcessingState(): ApiProcessingState | null {
		return this.activeProcessingState;
	}

	getCurrentProcessingStateSync(): ApiProcessingState | null {
		return this.activeProcessingState;
	}

	setStreamingActive(active: boolean): void {
		this.isStreamingActive = active;
	}

	isStreaming(): boolean {
		return this.isStreamingActive;
	}

	getOrCreateAbortController(convId: string): AbortController {
		let c = this.abortControllers.get(convId);
		if (!c || c.signal.aborted) {
			c = new AbortController();
			this.abortControllers.set(convId, c);
		}
		return c;
	}

	abortRequest(convId?: string): void {
		if (convId) {
			const c = this.abortControllers.get(convId);
			if (c) {
				c.abort();
				this.abortControllers.delete(convId);
			}
		} else {
			for (const c of this.abortControllers.values()) c.abort();
			this.abortControllers.clear();
		}
	}

	/**
	 * Abort the current agentic flow signal without clearing loading state.
	 * Used by "Send immediately" to force the agentic loop to exit so that
	 * the pending steering message can be re-sent.
	 */
	abortCurrentFlow(convId: string): void {
		const c = this.abortControllers.get(convId);
		if (c) {
			c.abort();
			this.abortControllers.delete(convId);
		}
	}

	getAllLoadingChats(): string[] {
		return Array.from(this.chatLoadingStates.keys());
	}

	getAllStreamingChats(): string[] {
		return Array.from(this.chatStreamingStates.keys());
	}

	getChatStreamingPublic(convId: string): { response: string; messageId: string } | undefined {
		return this.getChatStreaming(convId);
	}

	isChatLoadingPublic(convId: string): boolean {
		return this.chatLoadingStates.get(convId) || false;
	}

	isChatReasoningPublic(convId: string): boolean {
		return this.chatReasoningStates.get(convId) || false;
	}

	isChatLoadingInternal(convId: string): boolean {
		return this.chatLoadingStates.has(convId) || this.chatStreamingStates.has(convId);
	}

	private touchConversationState(convId: string): void {
		this.conversationStateTimestamps.set(convId, { lastAccessed: Date.now() });
	}

	cleanupOldConversationStates(activeConversationIds?: string[]): number {
		const now = Date.now();
		const activeIdsList = activeConversationIds ?? [];
		const preserveIds = this.activeConversationId
			? [...activeIdsList, this.activeConversationId]
			: activeIdsList;
		const allConvIds = [
			...new Set([
				...this.chatLoadingStates.keys(),
				...this.chatStreamingStates.keys(),
				...this.abortControllers.keys(),
				...this.processingStates.keys(),
				...this.conversationStateTimestamps.keys()
			])
		];
		const cleanupCandidates: Array<{ convId: string; lastAccessed: number }> = [];
		for (const convId of allConvIds) {
			if (preserveIds.includes(convId)) continue;
			if (this.chatLoadingStates.get(convId)) continue;
			if (this.chatStreamingStates.has(convId)) continue;
			const ts = this.conversationStateTimestamps.get(convId);
			cleanupCandidates.push({ convId, lastAccessed: ts?.lastAccessed ?? 0 });
		}
		cleanupCandidates.sort((a, b) => a.lastAccessed - b.lastAccessed);
		let cleanedUp = 0;
		for (const { convId, lastAccessed } of cleanupCandidates) {
			if (
				cleanupCandidates.length - cleanedUp > MAX_INACTIVE_CONVERSATION_STATES ||
				now - lastAccessed > INACTIVE_CONVERSATION_STATE_MAX_AGE_MS
			) {
				this.cleanupConversationState(convId);
				cleanedUp++;
			}
		}
		return cleanedUp;
	}
	private cleanupConversationState(convId: string): void {
		const c = this.abortControllers.get(convId);
		if (c && !c.signal.aborted) c.abort();
		this.chatLoadingStates.delete(convId);
		this.chatStreamingStates.delete(convId);
		this.abortControllers.delete(convId);
		this.processingStates.delete(convId);
		this.conversationStateTimestamps.delete(convId);
	}
	getTrackedConversationCount(): number {
		return new Set([
			...this.chatLoadingStates.keys(),
			...this.chatStreamingStates.keys(),
			...this.abortControllers.keys(),
			...this.processingStates.keys()
		]).size;
	}

	private getContextTotal(): number | null {
		const activeConvId = this.activeConversationId;
		const activeState = activeConvId ? this.getProcessingState(activeConvId) : null;
		return computeContextTotal(activeState);
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
		const processingState = this.parseTimingData(timingData);

		if (processingState === null) {
			console.warn('Failed to parse timing data - skipping update');
			return;
		}

		const targetId = conversationId || this.activeConversationId;
		if (targetId) {
			this.setProcessingState(targetId, processingState);
		}
	}

	private parseTimingData(timingData: Record<string, unknown>): ApiProcessingState | null {
		return computeTimingData(timingData, this.getContextTotal());
	}

	restoreProcessingStateFromMessages(messages: DatabaseMessage[], conversationId: string): void {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === MessageRole.ASSISTANT && message.timings) {
				const restoredState = this.parseTimingData({
					prompt_n: message.timings.prompt_n || 0,
					prompt_ms: message.timings.prompt_ms,
					predicted_n: message.timings.predicted_n || 0,
					predicted_per_second:
						message.timings.predicted_n && message.timings.predicted_ms
							? (message.timings.predicted_n / message.timings.predicted_ms) * 1000
							: 0,
					cache_n: message.timings.cache_n || 0
				});
				if (restoredState) {
					this.setProcessingState(conversationId, restoredState);
					return;
				}
			}
		}
	}
}
