/**
 * chat-ui-state - UI-facing reactive state for the chat store.
 *
 * Owns the error dialog, edit-mode flags, the pending system-prompt edit id,
 * the draft message/files stash, and the queued pending-message map. Holds no
 * knowledge of streaming/runtime; the facade wires it to the send pipeline.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { ErrorDialogState } from '$lib/types/chat';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types';

export class ChatUiState {
	errorDialogState = $state<ErrorDialogState | null>(null);
	pendingEditMessageId = $state<string | null>(null);
	private isEditModeActive = $state(false);
	private addFilesHandler: ((files: File[]) => void) | null = $state(null);
	private messageUpdateCallback:
		| ((messageId: string, updates: Partial<DatabaseMessage>) => void)
		| null = null;
	private _pendingDraftMessage = $state<string>('');
	private _pendingDraftFiles = $state<ChatUploadedFile[]>([]);

	/** Reactive: queued pending messages for non-agentic streaming */
	private _pendingMessages = new SvelteMap<
		string,
		{ content: string; extras?: DatabaseMessageExtra[] }
	>();

	showErrorDialog(state: ErrorDialogState | null): void {
		this.errorDialogState = state;
	}

	dismissErrorDialog(): void {
		this.errorDialogState = null;
	}

	clearEditMode(): void {
		this.isEditModeActive = false;
		this.addFilesHandler = null;
	}

	isEditing(): boolean {
		return this.isEditModeActive;
	}

	setEditModeActive(handler: (files: File[]) => void): void {
		this.isEditModeActive = true;
		this.addFilesHandler = handler;
	}

	getAddFilesHandler(): ((files: File[]) => void) | null {
		return this.addFilesHandler;
	}

	clearPendingEditMessageId(): void {
		this.pendingEditMessageId = null;
	}

	savePendingDraft(message: string, files: ChatUploadedFile[]): void {
		this._pendingDraftMessage = message;
		this._pendingDraftFiles = [...files];
	}

	consumePendingDraft(): { message: string; files: ChatUploadedFile[] } | null {
		if (!this._pendingDraftMessage && this._pendingDraftFiles.length === 0) return null;
		const d = { message: this._pendingDraftMessage, files: [...this._pendingDraftFiles] };
		this._pendingDraftMessage = '';
		this._pendingDraftFiles = [];
		return d;
	}

	hasPendingDraft(): boolean {
		return Boolean(this._pendingDraftMessage) || this._pendingDraftFiles.length > 0;
	}

	hasPendingMessage(convId: string): boolean {
		return this._pendingMessages.has(convId);
	}

	pendingMessageContent(convId: string): string | null {
		return this._pendingMessages.get(convId)?.content ?? null;
	}

	pendingMessageExtras(convId: string): DatabaseMessageExtra[] | undefined {
		return this._pendingMessages.get(convId)?.extras;
	}

	injectPendingMessage(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		this._pendingMessages.set(convId, { content, extras });
	}

	clearPendingMessage(convId: string): void {
		this._pendingMessages.delete(convId);
	}

	consumePendingMessage(
		convId: string
	): { content: string; extras?: DatabaseMessageExtra[] } | null {
		const msg = this._pendingMessages.get(convId);
		if (!msg) return null;
		this._pendingMessages.delete(convId);
		return msg;
	}
}
