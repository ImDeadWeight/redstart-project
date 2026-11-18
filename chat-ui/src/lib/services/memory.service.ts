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

/**
 * What a memory is (agent-runtime D35). Guidance is FOLLOWED by the assistant
 * (how the user wants it to work, with a why); facts and state are data;
 * state is dated. A record saved before kinds existed comes back as fact.
 */
export type MemoryKind = 'fact' | 'guidance' | 'state';
export const MEMORY_KINDS: MemoryKind[] = ['guidance', 'fact', 'state'];
export const KIND_LABELS: Record<MemoryKind, string> = {
	guidance: 'How to work',
	fact: 'About you',
	state: 'Where things stand'
};
/** A state memory older than this is marked as possibly out of date (as the prompt does). */
export const STATE_STALE_DAYS = 60;

export interface Memory {
	id: string;
	text: string;
	createdAt: number;
	updatedAt: number;
	source: { conversationId: string | null };
	/** Saved in a turn that had read web content: shown with a warning. */
	fromWebTurn: boolean;
	/** 'review' when automatic memory saved it. */
	via?: string;
	kind?: MemoryKind;
	why?: string | null;
	/** State only: the day it describes (YYYY-MM-DD), set by the server. */
	asOf?: string;
}

/** A state memory's date, and whether it is old enough to doubt. */
export function stateAge(m: Pick<Memory, 'kind' | 'asOf' | 'updatedAt'>, now = Date.now()): { date: string; stale: boolean } | null {
	if ((m.kind ?? 'fact') !== 'state') return null;
	const t = m.asOf ? Date.parse(`${m.asOf}T00:00:00Z`) : m.updatedAt;
	if (!Number.isFinite(t)) return null;
	return { date: new Date(t).toISOString().slice(0, 10), stale: now - t > STATE_STALE_DAYS * 86_400_000 };
}

/**
 * The composer's `/remember` text, read for a kind (agent-runtime 8.1, 8.6):
 *   /remember <fact>                          a fact
 *   /remember guidance: <text> because <why>  guidance (the why is required)
 *   /remember state: <text>                   where something stands
 * The prefix is case-insensitive. Guidance with no "because" is an error the
 * composer shows, not a fact saved silently: guidance is followed, and its
 * reason is what lets the user (and the assistant) judge when it applies.
 */
export function parseRemember(
	input: string
): { ok: true; text: string; kind: MemoryKind; why?: string } | { ok: false; error: string } {
	const raw = input.trim();
	const m = /^(guidance|state|fact)\s*:\s*([\s\S]*)$/i.exec(raw);
	if (!m) return raw ? { ok: true, text: raw, kind: 'fact' } : { ok: false, error: 'Nothing to remember' };
	const kind = m[1].toLowerCase() as MemoryKind;
	const body = m[2].trim();
	if (kind !== 'guidance') return body ? { ok: true, text: body, kind } : { ok: false, error: 'Nothing to remember' };
	const b = /^([\s\S]*?)\s+because\s+([\s\S]+)$/i.exec(body);
	if (!b || !b[1].trim() || !b[2].trim()) {
		return { ok: false, error: 'Guidance needs a reason: /remember guidance: <what> because <why>' };
	}
	return { ok: true, text: b[1].trim(), kind, why: b[2].trim() };
}

/** Automatic memory (projects-plan Phase 3). */
export type AutoMemoryMode = 'off' | 'suggest' | 'auto';

export interface AutoMemorySettings {
	mode: AutoMemoryMode;
	/** False when the Memory capability is off for this account's role. */
	available: boolean;
}

/** A memory the review proposed, waiting for Save or Dismiss. */
export interface MemorySuggestion {
	id: string;
	/** forget: the review thinks a memory no longer holds (always only suggested). */
	op: 'add' | 'update' | 'forget';
	/** For a forget, the memory's own text. */
	text: string;
	kind?: MemoryKind;
	why?: string;
	/** The user's own words the review cited (D36), shown so the user can judge it. */
	quote?: string;
	scope: 'user' | 'project';
	projectId?: string;
	/** For an update or forget: the memory it acts on, and (update) that memory's text. */
	targetId?: string;
	previousText?: string | null;
	/** For a merge: the other memories folded into this one, removed when it is saved. */
	replaces?: string[];
	/** Their texts, as they were when the review ran (display only). */
	replacedTexts?: string[];
	conversationId: string | null;
	createdAt: number;
}

/** A memory the review saved (auto mode), or a suggestion once accepted. */
export interface ReviewedMemory {
	op: 'add' | 'update' | 'forget';
	/** For a forget, the memory as it was before it went. */
	memory: Memory;
	scope: 'user' | 'project';
	projectId?: string;
	/** For an update: what it replaced, which Undo restores. */
	previousText?: string | null;
	previousKind?: MemoryKind;
	previousWhy?: string | null;
	/** For a merge: the memories folded in and removed, whole, for Undo. */
	removed?: Memory[];
}

export type ReviewResult =
	| { status: 'off' | 'busy' | 'nothing' | 'failed'; mode?: AutoMemoryMode; error?: string }
	| { status: 'done'; mode: 'suggest'; suggestions: MemorySuggestion[] }
	| { status: 'done'; mode: 'auto'; saved: ReviewedMemory[] };

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
		projectId?: string | null,
		{ kind, why }: { kind?: MemoryKind; why?: string | null } = {}
	): Promise<Memory & { duplicate: boolean }> {
		return apiFetch<Memory & { duplicate: boolean }>(scoped('/memories', projectId), {
			method: 'POST',
			body: JSON.stringify({
				text,
				conversationId: conversationId ?? null,
				...(kind ? { kind } : {}),
				...(why ? { why } : {})
			})
		});
	}

	/**
	 * `kind` and `why` left undefined keep what the memory had; `why: null`
	 * clears the reason. Editing a state memory re-dates it to today.
	 */
	static async update(
		id: string,
		text: string,
		projectId?: string | null,
		{ kind, why }: { kind?: MemoryKind; why?: string | null } = {}
	): Promise<Memory> {
		return apiFetch<Memory>(scoped(`/memories/${encodeURIComponent(id)}`, projectId), {
			method: 'PUT',
			body: JSON.stringify({
				text,
				...(kind !== undefined ? { kind } : {}),
				...(why !== undefined ? { why } : {})
			})
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

	static async getSettings(): Promise<AutoMemorySettings> {
		return apiFetch<AutoMemorySettings>('/memories/settings');
	}

	static async setMode(mode: AutoMemoryMode): Promise<AutoMemorySettings> {
		return apiFetch<AutoMemorySettings>('/memories/settings', {
			method: 'PUT',
			body: JSON.stringify({ mode })
		});
	}

	static async suggestions(conversationId?: string | null): Promise<MemorySuggestion[]> {
		const q = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
		const res = await apiFetch<{ suggestions: MemorySuggestion[] }>(`/memories/suggestions${q}`);
		return res.suggestions ?? [];
	}

	static async acceptSuggestion(id: string): Promise<ReviewedMemory> {
		return apiFetch<ReviewedMemory>(`/memories/suggestions/${encodeURIComponent(id)}/accept`, {
			method: 'POST'
		});
	}

	/** Dismissed for good: the review will not propose the same text again. */
	static async dismissSuggestion(id: string): Promise<void> {
		const res = await fetch(resolveApiPath(`/memories/suggestions/${encodeURIComponent(id)}`), {
			method: 'DELETE',
			headers: getAuthHeaders()
		});
		if (!res.ok && res.status !== 404) throw new Error(`Could not dismiss it (${res.status})`);
	}

	/** Ask Nest to review a chat now; it answers `busy` while a reply is being generated. */
	static async review(conversationId: string): Promise<ReviewResult> {
		return apiFetch<ReviewResult>('/memories/review', {
			method: 'POST',
			body: JSON.stringify({ conversationId })
		});
	}
}
