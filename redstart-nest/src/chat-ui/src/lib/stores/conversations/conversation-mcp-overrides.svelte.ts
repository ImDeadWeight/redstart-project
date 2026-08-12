/**
 * conversation-mcp-overrides - per-chat MCP server enablement
 *
 * Owns which MCP servers are on for the active conversation, and the pending
 * defaults a not-yet-created conversation will inherit. It reads and writes
 * the active conversation through the injected core state; it knows nothing
 * about conversation lifecycle, titles, navigation or import/export.
 */

import { DatabaseService } from '$lib/services/database.service';
import type { McpServerOverride } from '$lib/types/database';
import { MCP_DEFAULT_ENABLED_LOCALSTORAGE_KEY } from '$lib/constants';
import type { ConversationCoreState } from './conversation-core.svelte';

export class ConversationMcpOverrides {
	constructor(private readonly core: ConversationCoreState) {}

	/** Pending MCP server overrides for new conversations (before first message) */
	pendingMcpServerOverrides = $state<McpServerOverride[]>(
		ConversationMcpOverrides.loadMcpDefaults()
	);

	/** Load MCP default overrides from localStorage */
	static loadMcpDefaults(): McpServerOverride[] {
		if (typeof globalThis.localStorage === 'undefined') return [];
		try {
			const raw = localStorage.getItem(MCP_DEFAULT_ENABLED_LOCALSTORAGE_KEY);
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(o: unknown) => typeof o === 'object' && o !== null && 'serverId' in o && 'enabled' in o
			) as McpServerOverride[];
		} catch {
			return [];
		}
	}

	/** Persist MCP default overrides to localStorage */
	private saveMcpDefaults(): void {
		if (typeof globalThis.localStorage === 'undefined') return;
		const plain = this.pendingMcpServerOverrides.map((o) => ({
			serverId: o.serverId,
			enabled: o.enabled
		}));
		if (plain.length > 0) {
			localStorage.setItem(MCP_DEFAULT_ENABLED_LOCALSTORAGE_KEY, JSON.stringify(plain));
		} else {
			localStorage.removeItem(MCP_DEFAULT_ENABLED_LOCALSTORAGE_KEY);
		}
	}

	/**
	 * Gets MCP server override for a specific server in the active conversation.
	 * Falls back to pending overrides if no active conversation exists.
	 * @param serverId - The server ID to check
	 * @returns The override if set, undefined if using global setting
	 */
	getMcpServerOverride(serverId: string): McpServerOverride | undefined {
		const own = this.core.activeConversation?.mcpServerOverrides?.find(
			(o: McpServerOverride) => o.serverId === serverId
		);
		// An explicit per-conversation choice always wins — including an explicit
		// "off", which must not be undone by the default below.
		if (own) return own;
		// Otherwise fall back to the saved defaults. A conversation that never
		// made a choice about this server (e.g. it was provisioned by the host
		// after the conversation started) should follow the default rather than
		// be silently treated as disabled.
		return this.pendingMcpServerOverrides.find((o) => o.serverId === serverId);
	}

	/**
	 * Get all MCP server overrides for the current conversation.
	 * Returns pending overrides if no active conversation.
	 */
	getAllMcpServerOverrides(): McpServerOverride[] {
		const own: McpServerOverride[] = this.core.activeConversation?.mcpServerOverrides ?? [];
		// Merge rather than replace, matching getMcpServerOverride: the
		// conversation's explicit choices win, and saved defaults fill in for
		// servers it never made a choice about. Returning only `own` would drop
		// the defaults for any conversation holding even one unrelated entry.
		const chosen = new Set(own.map((o) => o.serverId));
		const defaults = this.pendingMcpServerOverrides.filter((o) => !chosen.has(o.serverId));
		return [...own, ...defaults];
	}

	/**
	 * Checks if an MCP server is enabled for the active conversation.
	 * @param serverId - The server ID to check
	 * @returns True if server is enabled for this conversation
	 */
	isMcpServerEnabledForChat(serverId: string): boolean {
		const override = this.getMcpServerOverride(serverId);
		return override?.enabled ?? false;
	}

	/**
	 * Sets or removes MCP server override for the active conversation.
	 * If no conversation exists, stores as pending override.
	 * @param serverId - The server ID to override
	 * @param enabled - The enabled state, or undefined to remove override
	 */
	async setMcpServerOverride(serverId: string, enabled: boolean | undefined): Promise<void> {
		if (!this.core.activeConversation) {
			this.setPendingMcpServerOverride(serverId, enabled);
			return;
		}

		// Clone to plain objects to avoid Proxy serialization issues with IndexedDB
		const currentOverrides = (this.core.activeConversation.mcpServerOverrides || []).map(
			(o: McpServerOverride) => ({
				serverId: o.serverId,
				enabled: o.enabled
			})
		);
		let newOverrides: McpServerOverride[];

		if (enabled === undefined) {
			newOverrides = currentOverrides.filter((o: McpServerOverride) => o.serverId !== serverId);
		} else {
			const existingIndex = currentOverrides.findIndex(
				(o: McpServerOverride) => o.serverId === serverId
			);
			if (existingIndex >= 0) {
				newOverrides = [...currentOverrides];
				newOverrides[existingIndex] = { serverId, enabled };
			} else {
				newOverrides = [...currentOverrides, { serverId, enabled }];
			}
		}

		await DatabaseService.updateConversation(this.core.activeConversation.id, {
			mcpServerOverrides: newOverrides.length > 0 ? newOverrides : undefined
		});

		this.core.activeConversation = {
			...this.core.activeConversation,
			mcpServerOverrides: newOverrides.length > 0 ? newOverrides : undefined
		};

		const convIndex = this.core.conversations.findIndex(
			(c) => c.id === this.core.activeConversation!.id
		);
		if (convIndex !== -1) {
			this.core.conversations[convIndex].mcpServerOverrides =
				newOverrides.length > 0 ? newOverrides : undefined;
			this.core.conversations = [...this.core.conversations];
		}
	}

	/**
	 * Seeds the default enabled-state for a host-provisioned MCP server.
	 *
	 * No-op when any choice already exists — a saved default, or an explicit
	 * choice in the active conversation — so a user's decision, including an
	 * explicit "off", is never overwritten by re-provisioning.
	 */
	seedMcpServerDefault(serverId: string, enabled: boolean): void {
		if (this.getMcpServerOverride(serverId)) return;
		this.setPendingMcpServerOverride(serverId, enabled);
	}

	/**
	 * Sets or removes a pending MCP server override (for new conversations).
	 */
	private setPendingMcpServerOverride(serverId: string, enabled: boolean | undefined): void {
		if (enabled === undefined) {
			this.pendingMcpServerOverrides = this.pendingMcpServerOverrides.filter(
				(o) => o.serverId !== serverId
			);
		} else {
			const existingIndex = this.pendingMcpServerOverrides.findIndex(
				(o) => o.serverId === serverId
			);
			if (existingIndex >= 0) {
				const newOverrides = [...this.pendingMcpServerOverrides];
				newOverrides[existingIndex] = { serverId, enabled };
				this.pendingMcpServerOverrides = newOverrides;
			} else {
				this.pendingMcpServerOverrides = [...this.pendingMcpServerOverrides, { serverId, enabled }];
			}
		}
		this.saveMcpDefaults();
	}

	/**
	 * Toggles MCP server enabled state for the active conversation.
	 * @param serverId - The server ID to toggle
	 */
	async toggleMcpServerForChat(serverId: string): Promise<void> {
		const currentEnabled = this.isMcpServerEnabledForChat(serverId);
		await this.setMcpServerOverride(serverId, !currentEnabled);
	}

	/**
	 * Removes MCP server override for the active conversation.
	 * @param serverId - The server ID to remove override for
	 */
	async removeMcpServerOverride(serverId: string): Promise<void> {
		await this.setMcpServerOverride(serverId, undefined);
	}

	/**
	 * Clears all pending MCP server overrides.
	 */
	clearPendingMcpServerOverrides(): void {
		this.pendingMcpServerOverrides = [];
		this.saveMcpDefaults();
	}
}
