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
 * §4.2 step 5 notes the three pairs are near-identical and suggests sharing the
 * shape rather than repeating it. That is a behaviour-adjacent change and is
 * deliberately NOT done here — this seam is a pure move. See the plan.
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
	 * Gets the effective thinking-enabled state for the active conversation.
	 * Returns the conversation override if set, otherwise the global default.
	 */
	getThinkingEnabled(): boolean {
		if (this.core.activeConversation) {
			return this.core.activeConversation.thinkingEnabled ?? this.pendingThinkingEnabled;
		}
		return this.pendingThinkingEnabled;
	}

	/**
	 * Sets the thinking-enabled state for the active conversation.
	 * If no conversation exists, stores the global default.
	 * @param enabled - The enabled state
	 */
	async setThinkingEnabled(enabled: boolean): Promise<void> {
		if (!this.core.activeConversation) {
			this.pendingThinkingEnabled = enabled;
			this.saveThinkingDefaults();
			return;
		}

		this.core.activeConversation = {
			...this.core.activeConversation,
			thinkingEnabled: enabled
		};

		await DatabaseService.updateConversation(this.core.activeConversation.id, {
			thinkingEnabled: enabled
		});

		const convIndex = this.core.conversations.findIndex((c) => c.id === this.core.activeConversation!.id);
		if (convIndex !== -1) {
			this.core.conversations[convIndex].thinkingEnabled = enabled;
			this.core.conversations = [...this.core.conversations];
		}
	}

	/**
	 * Gets the effective reasoning effort for the active conversation.
	 * Returns the conversation override if set, otherwise the global default.
	 */
	getReasoningEffort(): ReasoningEffort {
		if (this.core.activeConversation) {
			return this.core.activeConversation.reasoningEffort ?? this.pendingReasoningEffort;
		}
		return this.pendingReasoningEffort;
	}

	/**
	 * Sets the reasoning effort for the active conversation.
	 * If no conversation exists, stores the global default.
	 * @param effort - The effort level ('low' | 'medium' | 'high' | 'max')
	 */
	async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
		if (!this.core.activeConversation) {
			this.pendingReasoningEffort = effort;
			this.saveReasoningEffortDefaults();
			return;
		}

		this.core.activeConversation = {
			...this.core.activeConversation,
			reasoningEffort: effort
		};

		await DatabaseService.updateConversation(this.core.activeConversation.id, {
			reasoningEffort: effort
		});

		const convIndex = this.core.conversations.findIndex((c) => c.id === this.core.activeConversation!.id);
		if (convIndex !== -1) {
			this.core.conversations[convIndex].reasoningEffort = effort;
			this.core.conversations = [...this.core.conversations];
		}
	}

	/**
	 * Gets the task mode for the active conversation (system-prompt spec §9),
	 * or null when none is selected.
	 */
	getPromptMode(): string | null {
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
		if (!this.core.activeConversation) {
			this.pendingPromptMode = mode;
			return;
		}

		this.core.activeConversation = {
			...this.core.activeConversation,
			promptMode: mode
		};

		await DatabaseService.updateConversation(this.core.activeConversation.id, {
			promptMode: mode
		});

		const convIndex = this.core.conversations.findIndex((c) => c.id === this.core.activeConversation!.id);
		if (convIndex !== -1) {
			this.core.conversations[convIndex].promptMode = mode;
			this.core.conversations = [...this.core.conversations];
		}
	}
}
