/**
 * Admin-owned system prompt blocks and the derived data-handling facts.
 * See redstart-system-prompt-spec.md §3 (block contract) and §7 (egress).
 */

/** The three admin-authored blocks. Everything else is derived or code-owned. */
export interface PromptBlockEdits {
	context?: string;
	policy?: string;
	style?: string;
}

export interface PromptBlocks extends PromptBlockEdits {
	/** ISO timestamp of the last write, or null if never written. */
	updatedAt: string | null;
	/** Username of the admin who last wrote, or null. Provenance only. */
	updatedBy: string | null;
}

export interface PromptBlocksResponse {
	blocks: PromptBlocks;
	limits: {
		maxBlockChars: number;
		/** Soft budget (spec §10) — surfaced to admins, never enforced. */
		tokenBudget: number;
	};
	/** Live preview of what the gateway would compose right now. */
	composed: {
		tokens: number;
		overBudget: boolean;
		/** Emitted block names, in spec order. Last is always `precedence`. */
		blocks: string[];
		prompt: string;
	};
	/** Whether the current account may write. The server gates regardless. */
	canEdit: boolean;
}

/**
 * Which admin policy and mode a conversation ran under (spec §5), so past
 * behaviour stays explicable after the deployment's policy changes.
 *
 * Records identity, not content: block names, mode, provenance and a hash —
 * not the admin prose itself, which can reach 24KB. It answers "did policy
 * change since this conversation?" but not "what exactly did it say?". It is
 * also written by the client, so it is a record, not an attestation.
 */
export interface PromptSnapshot {
	/** Bumped when the block contract changes. */
	version: number;
	composedAt: number;
	mode: string | null;
	/** Block names emitted at the time, in spec order. */
	blocks: string[];
	/** When the admin blocks were last edited, and by whom. */
	adminUpdatedAt: string | null;
	adminUpdatedBy: string | null;
	/** Stable digest of the composed prompt, for change detection. */
	promptHash: string;
}

/**
 * A task mode offered by the deployment (spec §9). Only `id` travels back to
 * the server; the instruction text is server-owned and never exposed.
 */
export interface PromptMode {
	id: string;
	label: string;
	summary: string;
}

/** A tool server or web destination that receives data leaving this machine. */
export interface EgressDestination {
	name: string;
	host: string | null;
}

export interface EgressFacts {
	inference: { local: boolean; detail: string };
	webDomains: string[];
	remoteToolServers: EgressDestination[];
	localStores: string[];
	hasEgress: boolean;
	/**
	 * Whether Redstart has any recorded retention/training terms for the
	 * external destinations above. Currently always false — reporting the
	 * absence is the point (spec §7).
	 */
	externalTermsKnown: boolean;
}
