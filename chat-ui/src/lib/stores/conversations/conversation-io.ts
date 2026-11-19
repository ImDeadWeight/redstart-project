/**
 * conversation-io - export and import
 *
 * Filenames, the download blob, and reading a conversation archive back in.
 * Reads the active conversation and its messages through the injected core
 * state; it owns no state of its own, so it is a plain .ts.
 *
 * **One deliberate departure from a pure move.** Both import methods ended with
 * `await this.loadConversations()`, a facade method that stays behind — and a
 * sub-store may not call back into the facade (recipe rule 3). The reload now
 * happens in the facade's delegation instead, immediately after this module
 * returns. That is behaviour-identical from a caller's point of view: the
 * promise a caller awaits is the facade's, and it does not settle until the
 * reload has run. The alternative was a conversation-repo module for one
 * method; see the plan's Appendix G.
 */

import { toast } from 'svelte-sonner';
import { DatabaseService } from '$lib/services/database.service';
import { HtmlInputType, FileExtensionText } from '$lib/enums';
import {
	ISO_DATE_TIME_SEPARATOR,
	ISO_DATE_TIME_SEPARATOR_REPLACEMENT,
	ISO_TIMESTAMP_SLICE_LENGTH,
	EXPORT_CONV_ID_TRIM_LENGTH,
	EXPORT_CONV_NONALNUM_REPLACEMENT,
	EXPORT_CONV_NAME_SUFFIX_MAX_LENGTH,
	ISO_TIME_SEPARATOR,
	ISO_TIME_SEPARATOR_REPLACEMENT,
	NON_ALPHANUMERIC_REGEX,
	MULTIPLE_UNDERSCORE_REGEX
} from '$lib/constants';
import type { ConversationCoreState } from './conversation-core.svelte';

export class ConversationIO {
	constructor(private readonly core: ConversationCoreState) {}

	/**
	 * Generates a sanitized filename for a conversation export
	 * @param conversation - The conversation metadata
	 * @param msgs - Optional array of messages belonging to the conversation
	 * @returns The generated filename string
	 */
	generateConversationFilename(
		conversation: { id?: string; name?: string },
		msgs?: DatabaseMessage[]
	): string {
		const conversationName = (conversation.name ?? '').trim().toLowerCase();

		const sanitizedName = conversationName
			.replace(NON_ALPHANUMERIC_REGEX, EXPORT_CONV_NONALNUM_REPLACEMENT)
			.replace(MULTIPLE_UNDERSCORE_REGEX, '_')
			.substring(0, EXPORT_CONV_NAME_SUFFIX_MAX_LENGTH);

		// If we have messages, use the timestamp of the newest message
		const referenceDate = msgs?.length
			? new Date(Math.max(...msgs.map((m) => m.timestamp)))
			: new Date();

		const iso = referenceDate.toISOString().slice(0, ISO_TIMESTAMP_SLICE_LENGTH);
		const formattedDate = iso
			.replace(ISO_DATE_TIME_SEPARATOR, ISO_DATE_TIME_SEPARATOR_REPLACEMENT)
			.replaceAll(ISO_TIME_SEPARATOR, ISO_TIME_SEPARATOR_REPLACEMENT);
		const trimmedConvId = conversation.id?.slice(0, EXPORT_CONV_ID_TRIM_LENGTH) ?? '';
		return `${formattedDate}_conv_${trimmedConvId}_${sanitizedName}.json`;
	}

	/**
	 * Triggers a browser download of the provided exported conversation data
	 * @param data - The exported conversation payload (either a single conversation or array of them)
	 * @param filename - Filename; if omitted, a deterministic name is generated
	 */
	downloadConversationFile(data: ExportedConversations, filename?: string): void {
		// Choose the first conversation or message
		const conversation =
			'conv' in data ? data.conv : Array.isArray(data) ? data[0]?.conv : undefined;
		const msgs =
			'messages' in data ? data.messages : Array.isArray(data) ? data[0]?.messages : undefined;

		if (!conversation) {
			console.error('Invalid data: missing conversation');
			return;
		}

		let downloadFilename: string;

		if (filename) {
			downloadFilename = filename;
		} else if (Array.isArray(data) && data.length > 1) {
			downloadFilename = `${new Date().toISOString().split(ISO_DATE_TIME_SEPARATOR)[0]}_conversations.json`;
		} else {
			downloadFilename = this.generateConversationFilename(conversation, msgs);
		}

		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = downloadFilename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	/**
	 * Downloads a conversation as JSON file.
	 * @param convId - The conversation ID to download
	 */
	async downloadConversation(convId: string): Promise<void> {
		let conversation: DatabaseConversation | null;
		let messages: DatabaseMessage[];

		if (this.core.activeConversation?.id === convId) {
			conversation = this.core.activeConversation;
			messages = this.core.activeMessages;
		} else {
			conversation = await DatabaseService.getConversation(convId);
			if (!conversation) return;
			messages = await DatabaseService.getConversationMessages(convId);
		}

		this.downloadConversationFile({ conv: conversation, messages });
	}

	/**
	 * Imports conversations from a JSON file
	 * Opens file picker and processes the selected file
	 * @returns The list of imported conversations
	 */
	async importConversations(): Promise<DatabaseConversation[]> {
		return new Promise((resolve, reject) => {
			const input = document.createElement('input');
			input.type = HtmlInputType.FILE;
			input.accept = FileExtensionText.JSON;

			input.onchange = async (e) => {
				const file = (e.target as HTMLInputElement)?.files?.[0];

				if (!file) {
					reject(new Error('No file selected'));
					return;
				}

				try {
					const text = await file.text();
					const parsedData = JSON.parse(text);
					let importedData: ExportedConversations;

					if (Array.isArray(parsedData)) {
						importedData = parsedData;
					} else if (
						parsedData &&
						typeof parsedData === 'object' &&
						'conv' in parsedData &&
						'messages' in parsedData
					) {
						importedData = [parsedData];
					} else {
						throw new Error('Invalid file format');
					}

					const result = await DatabaseService.importConversations(importedData);
					toast.success(`Imported ${result.imported} conversation(s), skipped ${result.skipped}`);


					const importedConversations = (
						Array.isArray(importedData) ? importedData : [importedData]
					).map((item) => item.conv);

					resolve(importedConversations);
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : 'Unknown error';
					console.error('Failed to import conversations:', err);
					toast.error('Import failed', { description: message });
					reject(new Error(`Import failed: ${message}`));
				}
			};

			input.click();
		});
	}

	/**
	 * Imports conversations from provided data (without file picker)
	 * @param data - Array of conversation data with messages
	 * @returns Import result with counts
	 */
	async importConversationsData(
		data: ExportedConversations
	): Promise<{ imported: number; skipped: number }> {
		const result = await DatabaseService.importConversations(data);
		return result;
	}
}
