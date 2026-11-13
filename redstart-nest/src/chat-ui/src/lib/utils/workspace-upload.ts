/**
 * workspace-upload - attachments into the conversation's workspace
 *
 * chat-tooling Phase 1: "analyse this CSV" needs the file ON DISK where
 * run_python can open it, and chat-ui otherwise only ever reads attachments
 * client-side into the message text. When Nest serves run_python, each
 * attachment is ALSO uploaded through the existing files API to
 * `chats/<conversationId>/` in the caller's Documents space (the server puts
 * that inside their own per-account folder), and the message tells the model
 * where it is.
 *
 * Additive, never instead: the client-side text extraction still happens, so
 * a model without the tool, or a failed upload, sees exactly what it did before.
 */

import { FilesService } from '$lib/services/files.service';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { attachmentNote } from '$lib/agent-core';

export const PYTHON_TOOL = 'run_python';

/** Data files that are only useful to code, accepted only while run_python is served. */
export const WORKSPACE_ONLY_EXTENSIONS = ['.xlsx', '.xls', '.parquet', '.feather', '.npy', '.npz', '.sqlite', '.db'];

export function workspaceAvailable(): boolean {
	return mcpStore.hasTool(PYTHON_TOOL);
}

export function isWorkspaceOnlyFile(name: string): boolean {
	const lower = name.toLowerCase();
	return WORKSPACE_ONLY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Upload files to the conversation's workspace. Returns the line to append to
 * the user's message, or null when nothing was uploaded. Never throws: an
 * upload failure is reported in that line, so the model does not go looking
 * for a file that is not there.
 */
export async function uploadToWorkspace(conversationId: string, files: File[]): Promise<string | null> {
	if (!files.length) return null;
	const dir = `chats/${conversationId}`;
	const saved: string[] = [];
	const failed: string[] = [];
	for (const file of files) {
		try {
			await FilesService.upload('documents', dir, file);
			saved.push(file.name);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// The same name already there is the same attachment sent twice
			// (an edit, a regenerate): it is in the workspace, which is all
			// the model needs to know.
			if (/already exists/i.test(message)) saved.push(file.name);
			else failed.push(`${file.name} (${message})`);
		}
	}
	// The note is built by the shared core, which the agent bench also uses,
	// so the bench measures exactly what a chat user's model is told. It
	// names how each OFFERED tool reaches the files (see attachment-note.mjs).
	return attachmentNote({
		saved,
		failed,
		conversationId,
		hasTool: (name) => mcpStore.hasTool(name)
	});
}
