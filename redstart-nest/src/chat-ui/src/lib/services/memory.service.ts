import { apiFetch } from '$lib/utils';
import { getAuthHeaders } from '$lib/utils/api-headers';
import { resolveApiPath } from '$lib/utils/api-fetch';

/**
 * Client for the user's own memories (chat-tooling Phase 3), served by Nest's
 * /memories routes. Like FilesService, no signature names a user: the server
 * scopes everything to the authenticated credential.
 *
 * Every call takes an optional `projectId`: a project's own memories
 * (projects-plan D13) instead of the user's. Nest answers 404 for a project
 * the caller may not read.
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

function scoped(path: string, projectId?: string | null): string {
	return projectId ? `${path}?projectId=${encodeURIComponent(projectId)}` : path;
}

export class MemoryService {
	static async list(projectId?: string | null): Promise<Memory[]> {
		const res = await apiFetch<{ memories: Memory[] }>(scoped('/memories', projectId));
		return res.memories ?? [];
	}

	/**
	 * A memory the user typed (the composer's /remember, or the project page),
	 * never web-marked. `duplicate` is true when an identical memory already
	 * existed and nothing was created. Nest refuses this (403) when the user's
	 * role has memory off.
	 */
	static async create(
		text: string,
		conversationId?: string | null,
		projectId?: string | null
	): Promise<Memory & { duplicate: boolean }> {
		return apiFetch<Memory & { duplicate: boolean }>(scoped('/memories', projectId), {
			method: 'POST',
			body: JSON.stringify({ text, conversationId: conversationId ?? null })
		});
	}

	static async update(id: string, text: string, projectId?: string | null): Promise<Memory> {
		return apiFetch<Memory>(scoped(`/memories/${encodeURIComponent(id)}`, projectId), {
			method: 'PUT',
			body: JSON.stringify({ text })
		});
	}

	/** 204 has no body, which apiFetch would try to parse; a plain fetch instead. */
	static async remove(id: string, projectId?: string | null): Promise<void> {
		const res = await fetch(
			resolveApiPath(scoped(`/memories/${encodeURIComponent(id)}`, projectId)),
			{
				method: 'DELETE',
				headers: getAuthHeaders()
			}
		);
		if (!res.ok && res.status !== 404) throw new Error(`Could not forget it (${res.status})`);
	}
}
