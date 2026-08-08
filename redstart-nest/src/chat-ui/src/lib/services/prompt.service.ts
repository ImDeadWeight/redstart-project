import { apiFetch } from '$lib/utils';
import { API_PROMPT } from '$lib/constants';
import type {
	PromptBlocksResponse,
	PromptBlockEdits,
	EgressFacts,
	PromptMode,
	PromptSnapshot
} from '$lib/types';

/**
 * Bump when the block contract changes (spec §3), so a snapshot recorded under
 * an older contract can be recognised rather than misread.
 */
export const PROMPT_SNAPSHOT_VERSION = 1;

/**
 * FNV-1a. Not cryptographic — this only answers "is this the same composed
 * prompt as before?", so collision resistance is not the property needed.
 */
function digest(text: string): string {
	let hash = 0x811c9dc5;

	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Admin-owned system prompt blocks (system-prompt spec §3).
 *
 * These live on the Redstart gateway, not in localStorage like the rest of
 * Settings: they are a deployment-wide policy floor, and a floor a user can
 * edit is a preference. The server enforces the admin gate on write — this
 * service only reflects it so the UI can render read-only.
 */
export class PromptService {
	/** Blocks, limits, the live composed preview, and whether this user may edit. */
	static async getBlocks(): Promise<PromptBlocksResponse> {
		return apiFetch<PromptBlocksResponse>(API_PROMPT.BLOCKS);
	}

	/** Replace one or more blocks. Admin-only; a non-admin receives 403. */
	static async saveBlocks(edits: PromptBlockEdits): Promise<PromptBlocksResponse['blocks']> {
		const result = await apiFetch<{ blocks: PromptBlocksResponse['blocks'] }>(API_PROMPT.BLOCKS, {
			method: 'PUT',
			body: JSON.stringify(edits)
		});

		return result.blocks;
	}

	/**
	 * Task modes this deployment offers (spec §9). Only the `id` is ever sent
	 * back; `label` and `summary` are for the picker. The instruction text
	 * itself is server-owned and deliberately not exposed.
	 */
	static async getModes(): Promise<PromptMode[]> {
		const result = await apiFetch<{ modes: PromptMode[] }>(API_PROMPT.MODES);

		return result.modes;
	}

	/**
	 * Record which admin policy and mode a conversation is starting under
	 * (spec §5), so its behaviour stays explicable after policy later changes.
	 *
	 * Returns null rather than throwing when the route is unavailable — an
	 * older Nest has no `/prompt-blocks`, and a missing provenance record must
	 * never stop someone sending a message.
	 */
	static async captureSnapshot(mode: string | null): Promise<PromptSnapshot | null> {
		try {
			const data = await PromptService.getBlocks();

			return {
				version: PROMPT_SNAPSHOT_VERSION,
				composedAt: Date.now(),
				mode,
				blocks: data.composed.blocks,
				adminUpdatedAt: data.blocks.updatedAt,
				adminUpdatedBy: data.blocks.updatedBy,
				promptHash: digest(data.composed.prompt)
			};
		} catch {
			return null;
		}
	}

	/**
	 * The data-handling facts the prompt's disclosure is derived from
	 * (spec §7) — served as data so "where does my data go?" has a checkable
	 * answer rather than a sentence the model paraphrases.
	 */
	static async getEgress(): Promise<EgressFacts> {
		return apiFetch<EgressFacts>(API_PROMPT.EGRESS);
	}
}
