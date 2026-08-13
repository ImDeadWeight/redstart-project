/**
 * conversation-prefs - per-conversation thinking, reasoning effort and prompt mode
 *
 * Three settings that follow one shape: read the active conversation's value,
 * fall back to a pending default for a chat that has not been created yet, and
 * persist the default to localStorage when it changes. Writes go to the
 * conversation row and to the injected core state.
 *
 * The three `pending*` fields are the defaults a not-yet-created conversation
 * inherits; the facade forwards them with getters and setters, since consumers
 * assign to them.
 *
 * The three pairs now share one write path (`setConversationPref`). They are
 * near-identical but NOT identical, and both differences are deliberate:
 * `promptMode` reports null rather than the pending default when a conversation
 * is open, and it persists no default. Those are parameters and an explicit
 * branch rather than something the shared shape smooths over.
 */

import { DatabaseService } from '$lib/services/database.service';
import { ReasoningEffort } from '$lib/enums';
import {
	THINKING_ENABLED_DEFAULT_LOCALSTORAGE_KEY,
	REASONING_EFFORT_DEFAULT_LOCALSTORAGE_KEY
} from '$lib/constants';
import type { ConversationCoreState } from './conversation-core.svelte';

export class ConversationPrefs {
	constructor(private readonly core: ConversationCoreState) {}

	/** Global (non-conversation-specific) thinking toggle default */
	pendingThinkingEnabled = $state(ConversationPrefs.loadThinkingDefaults());

	/** Global (non-conversation-specific) reasoning effort default */
	pendingReasoningEffort = $state<ReasoningEffort>(ConversationPrefs.loadReasoningEffortDefault());

	/**
	 * Task mode for a conversation that does not exist yet (system-prompt
	 * spec §9). Not persisted: a mode describes the work in front of you, so
	 * carrying the last one into an unrelated new chat is more surprising than
	 * helpful. Unlike thinking/effort, this deliberately has no saved default.
	 */
	pendingPromptMode = $state<string | null>(null);

	/** Load thinking-enabled default from localStorage */
	/**
	 * Widened from `private static`, exactly as seam 2 widened loadMcpDefaults and
	 * for the same caller: clearActiveConversation reloads the persisted defaults
	 * so a new chat inherits them.
	 */
	static loadThinkingDefaults(): boolean {
		if (typeof globalThis.localStorage === 'undefined') return true;
		try {
			const raw = localStorage.getItem(THINKING_ENABLED_DEFAULT_LOCALSTORAGE_KEY);
			if (!raw) return true;
			return raw === 'true';
		} catch {
			return true;
		}
	}

	/** Persist thinking-enabled default to localStorage */
	private saveThinkingDefaults(): void {
		if (typeof globalThis.localStorage === 'undefined') return;
		localStorage.setItem(
			THINKING_ENABLED_DEFAULT_LOCALSTORAGE_KEY,
			this.pendingThinkingEnabled ? 'true' : 'false'
		);
	}

	/** Load reasoning effort default from localStorage */
	private static loadReasoningEffortDefault(): ReasoningEffort {
		if (typeof globalThis.localStorage === 'undefined') return ReasoningEffort.MEDIUM;
		try {
			const raw = localStorage.getItem(REASONING_EFFORT_DEFAULT_LOCALSTORAGE_KEY);
			return (raw as ReasoningEffort) || ReasoningEffort.MEDIUM;
		} catch {
			return ReasoningEffort.MEDIUM;
		}
	}

	/** Persist reasoning effort default to localStorage */
	private saveReasoningEffortDefaults(): void {
		if (typeof globalThis.localStorage === 'undefined') return;
		localStorage.setItem(REASONING_EFFORT_DEFAULT_LOCALSTORAGE_KEY, this.pendingReasoningEffort);
	}

	/**
	 * The write half the three setters share: update the active conversation, the
	 * database row and the list entry, in that order, replacing the array so
	 * readers re-run.
	 *
	 * `whenNoConversation` is the only part that differs between the three, which
	 * is why it is a parameter rather than a flag — thinking and effort persist a
	 * default there, prompt mode deliberately does not.
	 */
	private async setConversationPref<K extends 'thinkingEnabled' | 'reasoningEffort' | 'promptMode'>(
		field: K,
		value: DatabaseConversation[K],
		whenNoConversation: () => void
	): Promise<void> {
		if (!this.core.activeConversation) {
			whenNoConversation();
			return;
		}

		this.core.activeConversation = { ...this.core.activeConversation, [field]: value };

		await DatabaseService.updateConversation(this.core.activeConversation.id, { [field]: value });

		const convIndex = this.core.conversations.findIndex(
			(c) => c.id === this.core.activeConversation!.id
		);
		if (convIndex !== -1) {
			this.core.conversations[convIndex][field] = value;
			this.core.conversations = [...this.core.conversations];
		}
	}

	/**
	 * Gets the effective thinking-enabled state for the active conversation.
	 * Returns the conversation override if set, otherwise the global default.
	 */
	getThinkingEnabled(): boolean {
		return this.core.activeConversation?.thinkingEnabled ?? this.pendingThinkingEnabled;
	}

	/**
	 * Sets the thinking-enabled state for the active conversation.
	 * If no conversation exists, stores the global default.
	 * @param enabled - The enabled state
	 */
	async setThinkingEnabled(enabled: boolean): Promise<void> {
		return this.setConversationPref('thinkingEnabled', enabled, () => {
			this.pendingThinkingEnabled = enabled;
			this.saveThinkingDefaults();
		});
	}

	/**
	 * Gets the effective reasoning effort for the active conversation.
	 * Returns the conversation override if set, otherwise the global default.
	 */
	getReasoningEffort(): ReasoningEffort {
		return this.core.activeConversation?.reasoningEffort ?? this.pendingReasoningEffort;
	}

	/**
	 * Sets the reasoning effort for the active conversation.
	 * If no conversation exists, stores the global default.
	 * @param effort - The effort level ('low' | 'medium' | 'high' | 'max')
	 */
	async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
		return this.setConversationPref('reasoningEffort', effort, () => {
			this.pendingReasoningEffort = effort;
			this.saveReasoningEffortDefaults();
		});
	}

	/**
	 * Gets the task mode for the active conversation (system-prompt spec §9),
	 * or null when none is selected.
	 */
	getPromptMode(): string | null {
		// NOT `?? this.pendingPromptMode`, unlike the two above. With a conversation
		// open an unset mode reports null, so a mode picked for a new chat cannot
		// leak into an existing one that never selected it. Pinned by
		// tests/unit/conversation-prefs.test.ts.
		if (this.core.activeConversation) {
			return this.core.activeConversation.promptMode ?? null;
		}
		return this.pendingPromptMode;
	}

	/**
	 * Sets the task mode for the active conversation. Only the ID travels — the
	 * server resolves it to preset text and ignores anything it does not
	 * recognise, so an unknown ID here is inert rather than dangerous.
	 *
	 * @param mode - A mode ID from `GET /prompt-modes`, or null for none
	 */
	async setPromptMode(mode: string | null): Promise<void> {
		// No saved default here — see pendingPromptMode above.
		return this.setConversationPref('promptMode', mode, () => {
			this.pendingPromptMode = mode;
		});
	}
}
