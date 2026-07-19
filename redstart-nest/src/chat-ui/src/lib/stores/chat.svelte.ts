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

import { getConversationModel as computeConversationModel } from '$lib/stores/chat/chat-options';
import { ChatUiState } from '$lib/stores/chat/chat-ui-state.svelte';
import { ChatRuntimeState } from '$lib/stores/chat/chat-runtime.svelte';
import * as messageRepo from '$lib/stores/chat/chat-message-repo';
import { ChatSendController } from '$lib/stores/chat/chat-send.svelte';
import { ChatMessageOps } from '$lib/stores/chat/chat-message-ops.svelte';
import type { ChatMessagePromptProgress, ErrorDialogState } from '$lib/types/chat';
import type { ApiProcessingState, DatabaseMessage, DatabaseMessageExtra } from '$lib/types';
import { MessageRole, MessageType } from '$lib/enums';

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

	async continueAssistantMessage(messageId: string): Promise<void> {
		return this.ops.continueAssistantMessage(messageId);
	}

	async editAssistantMessage(
		messageId: string,
		newContent: string,
		shouldBranch: boolean
	): Promise<void> {
		return this.ops.editAssistantMessage(messageId, newContent, shouldBranch);
	}

	async editUserMessagePreserveResponses(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		return this.ops.editUserMessagePreserveResponses(messageId, newContent, newExtras);
	}

	async editMessageWithBranching(
		messageId: string,
		newContent: string,
		newExtras?: DatabaseMessageExtra[]
	): Promise<void> {
		return this.ops.editMessageWithBranching(messageId, newContent, newExtras);
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
