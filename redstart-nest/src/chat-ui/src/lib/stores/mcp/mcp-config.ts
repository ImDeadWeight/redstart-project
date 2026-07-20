/**
 * Stateless helpers for turning raw MCP settings into normalized client config.
 *
 * Extracted verbatim from mcpStore (mcp.svelte.ts) — pure functions with no
 * dependency on store state, so they live here where they can be read and
 * tested in isolation. The store composes them; it does not own them.
 */

import { detectMcpTransportFromUrl } from '$lib/utils';
import { DEFAULT_MCP_CONFIG, MCP_SERVER_ID_PREFIX } from '$lib/constants';
import type {
	MCPClientConfig,
	MCPServerConfig,
	ServerCapabilities,
	ClientCapabilities,
	MCPCapabilitiesInfo,
	MCPServerSettingsEntry
} from '$lib/types';
import type { McpServerOverride } from '$lib/types/database';
import type { SettingsConfigType } from '$lib/types/settings';

/**
 * Generates a unique server ID from an optional ID string or index.
 */
export function generateServerId(id: unknown, index: number): string {
	if (typeof id === 'string' && id.trim()) {
		return id.trim();
	}

	return `${MCP_SERVER_ID_PREFIX}-${index + 1}`;
}

/**
 * Parses raw server settings from config into MCPServerSettingsEntry array.
 */
export function parseServerSettings(rawServers: unknown): MCPServerSettingsEntry[] {
	if (!rawServers) {
		return [];
	}

	let parsed: unknown;
	if (typeof rawServers === 'string') {
		const trimmed = rawServers.trim();
		if (!trimmed) {
			return [];
		}

		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			console.warn('[MCP] Failed to parse mcpServers JSON:', error);

			return [];
		}
	} else {
		parsed = rawServers;
	}
	if (!Array.isArray(parsed)) {
		return [];
	}

	return parsed.map((entry, index) => {
		const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
		const headers = typeof entry?.headers === 'string' ? entry.headers.trim() : undefined;

		return {
			id: generateServerId((entry as { id?: unknown })?.id, index),
			enabled: Boolean((entry as { enabled?: unknown })?.enabled),
			url,
			name: (entry as { name?: string })?.name,
			requestTimeoutSeconds:
				(entry as { requestTimeoutSeconds?: number })?.requestTimeoutSeconds ??
				DEFAULT_MCP_CONFIG.requestTimeoutSeconds,
			headers: headers || undefined,
			useProxy: Boolean((entry as { useProxy?: unknown })?.useProxy)
		} satisfies MCPServerSettingsEntry;
	});
}

/**
 * Builds server configuration from a settings entry.
 */
export function buildServerConfig(
	entry: MCPServerSettingsEntry,
	connectionTimeoutMs = DEFAULT_MCP_CONFIG.connectionTimeoutMs
): MCPServerConfig | undefined {
	if (!entry?.url) {
		return undefined;
	}

	let headers: Record<string, string> | undefined;
	if (entry.headers) {
		try {
			const parsed = JSON.parse(entry.headers);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
				headers = parsed as Record<string, string>;
		} catch {
			console.warn('[MCP] Failed to parse custom headers JSON:', entry.headers);
		}
	}

	return {
		url: entry.url,
		transport: detectMcpTransportFromUrl(entry.url),
		handshakeTimeoutMs: connectionTimeoutMs,
		requestTimeoutMs: Math.round(entry.requestTimeoutSeconds * 1000),
		headers,
		useProxy: entry.useProxy
	};
}

/**
 * Checks if a server is enabled for a given chat.
 * Only per-chat overrides (persisted in localStorage for new chats,
 * or in IndexedDB for existing conversations) control enabled state.
 */
export function checkServerEnabled(
	server: MCPServerSettingsEntry,
	perChatOverrides?: McpServerOverride[]
): boolean {
	const override = perChatOverrides?.find((o) => o.serverId === server.id);
	return override?.enabled ?? false;
}

/**
 * Builds MCP client configuration from settings.
 */
export function buildMcpClientConfig(
	cfg: SettingsConfigType,
	perChatOverrides?: McpServerOverride[]
): MCPClientConfig | undefined {
	const rawServers = parseServerSettings(cfg.mcpServers);
	if (!rawServers.length) {
		return undefined;
	}

	const servers: Record<string, MCPServerConfig> = {};

	for (const [index, entry] of rawServers.entries()) {
		if (!checkServerEnabled(entry, perChatOverrides)) continue;
		const normalized = buildServerConfig(entry);
		if (normalized) servers[generateServerId(entry.id, index)] = normalized;
	}

	if (Object.keys(servers).length === 0) {
		return undefined;
	}

	return {
		protocolVersion: DEFAULT_MCP_CONFIG.protocolVersion,
		capabilities: DEFAULT_MCP_CONFIG.capabilities,
		clientInfo: DEFAULT_MCP_CONFIG.clientInfo,
		requestTimeoutMs: Math.round(DEFAULT_MCP_CONFIG.requestTimeoutSeconds * 1000),
		servers
	};
}

/**
 * Builds capabilities info from server and client capabilities.
 */
export function buildCapabilitiesInfo(
	serverCaps?: ServerCapabilities,
	clientCaps?: ClientCapabilities
): MCPCapabilitiesInfo {
	return {
		server: {
			tools: serverCaps?.tools ? { listChanged: serverCaps.tools.listChanged } : undefined,
			prompts: serverCaps?.prompts ? { listChanged: serverCaps.prompts.listChanged } : undefined,
			resources: serverCaps?.resources
				? {
						subscribe: serverCaps.resources.subscribe,
						listChanged: serverCaps.resources.listChanged
					}
				: undefined,
			logging: !!serverCaps?.logging,
			completions: !!serverCaps?.completions,
			tasks: !!serverCaps?.tasks
		},
		client: {
			roots: clientCaps?.roots ? { listChanged: clientCaps.roots.listChanged } : undefined,
			sampling: !!clientCaps?.sampling,
			elicitation: clientCaps?.elicitation
				? { form: !!clientCaps.elicitation.form, url: !!clientCaps.elicitation.url }
				: undefined,
			tasks: !!clientCaps?.tasks
		}
	};
}

/**
 * Parses a JSON headers string into a header record, or undefined if empty/invalid.
 */
export function parseHeaders(headersJson?: string): Record<string, string> | undefined {
	if (!headersJson?.trim()) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(headersJson);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
			return parsed as Record<string, string>;
	} catch {
		console.warn('[MCPStore] Failed to parse custom headers JSON:', headersJson);
	}

	return undefined;
}
