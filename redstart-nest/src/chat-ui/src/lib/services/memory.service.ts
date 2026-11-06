import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for the user's own memories (chat-tooling Phase 3), served by Nest's
 * /memories routes. Like FilesService, no signature names a user: the server
 * scopes everything to the authenticated credential.
 */

export interface Memory {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
	source: { conversationId: string | null };
	/** Saved in a turn that had read web content: shown with a warning. */
	fromWebTurn: boolean;
}

export class MemoryService {
	static async list(): Promise<Memory[]> {
		const res = await apiFetch<{ memories: Memory[] }>('/memories');
		return res.memories ?? [];
	}

	static async update(id: string, text: string): Promise<Memory> {
		return apiFetch<Memory>(`/memories/${encodeURIComponent(id)}`, {
			method: 'PUT',
			body: JSON.stringify({ text })
		});
	}

	/** 204 has no body, which apiFetch would try to parse; a plain fetch instead. */
	static async remove(id: string): Promise<void> {
		const res = await fetch(resolveApiPath(`/memories/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			headers: getAuthHeaders()
		});
		if (!res.ok && res.status !== 404) throw new Error(`Could not forget it (${res.status})`);
	}
}
