/**
 * mcp-servers - the MCP server registry and how a server is displayed
 *
 * Owns the settings-backed list of configured servers: reading it, mutating it,
 * syncing it from the Nest host and from twig-mcp.json, and deriving a label,
 * a favicon and a sort order for each entry. Display state comes from the
 * injected health checks.
 *
 * It knows nothing about the connection pool, the tool index or protocol
 * operations. The three methods that report on *connected* servers
 * (getServersStatus, getServerInstructions, hasServerInstructions) read the
 * connection map, so they stay on the facade until seam 5b.
 */

import { SETTINGS_KEYS, NEST_MCP_SERVER_ID_PREFIX, DEFAULT_MCP_CONFIG } from '$lib/constants';
import { config, settingsStore } from '$lib/stores/settings.svelte';
// One-way edge: conversations.svelte.ts imports no store that reaches back
// here, so this does not create an import cycle.
import { conversationsStore } from '$lib/stores/conversations.svelte';
// Lazy cross-store reference: tools.svelte.ts also imports mcpStore, so this
// forms a cycle. It's safe because toolsStore is only touched at runtime
// (inside syncServersFromHost), never at module init.
import { toolsStore } from '$lib/stores/tools.svelte';
import { parseMcpServerSettings, uuid, apiFetch } from '$lib/utils';
import { HealthCheckStatus } from '$lib/enums';
import type { MCPServerSettingsEntry } from '$lib/types';
import type { McpServerOverride } from '$lib/types/database';
import { checkServerEnabled, buildMcpClientConfig, mergeNestServers } from './mcp-config';
import { getMcpIconUrl, getServerFaviconFallback } from './mcp-icons';
import { twigMcpApi } from '$lib/utils/twig';
import type { MCPHealth } from './mcp-health.svelte';

export class MCPServers {
	constructor(private readonly health: MCPHealth) {}

	getServers(): MCPServerSettingsEntry[] {
		return parseMcpServerSettings(config().mcpServers);
	}

	getServerLabel(server: MCPServerSettingsEntry): string {
		const healthState = this.health.getHealthCheckState(server.id);
		// Local stdio entries have no URL — fall back to name, then command.
		const fallback = server.url || server.name || server.command || server.id;

		if (healthState?.status === HealthCheckStatus.SUCCESS)
			return (
				healthState.serverInfo?.title || healthState.serverInfo?.name || server.name || fallback
			);
		return fallback;
	}

	getServerById(serverId: string): MCPServerSettingsEntry | undefined {
		return this.getServers().find((s) => s.id === serverId);
	}

	/**
	 * Get display name for an MCP server by its ID.
	 * Falls back to the server ID if server is not found.
	 */
	getServerDisplayName(serverId: string): string {
		const server = this.getServerById(serverId);
		return server ? this.getServerLabel(server) : serverId;
	}

	/**
	 * Get icon URL for an MCP server by its ID.
	 * Returns the best icon from the MCP server's `icons` array
	 * (see MCP spec: spec.modelcontextprotocol.io).
	 * Returns null if no icon is available.
	 */
	getServerFavicon(serverId: string): string | null {
		const server = this.getServerById(serverId);
		if (!server) {
			return null;
		}

		const healthState = this.health.getHealthCheckState(serverId);
		if (healthState.status === HealthCheckStatus.SUCCESS && healthState.serverInfo?.icons) {
			// Always request the dark-theme variant — the app has no light mode.
			const mcpIconUrl = getMcpIconUrl(healthState.serverInfo.icons, true);

			if (mcpIconUrl) {
				return mcpIconUrl;
			}
		}

		// Fallback: try favicon from root domain
		const fallbackUrl = getServerFaviconFallback(server.url);
		if (fallbackUrl) {
			return fallbackUrl;
		}

		return null;
	}

	isAnyServerLoading(): boolean {
		return this.getServers().some((s) => {
			const state = this.health.getHealthCheckState(s.id);

			return (
				state.status === HealthCheckStatus.IDLE || state.status === HealthCheckStatus.CONNECTING
			);
		});
	}

	getServersSorted(): MCPServerSettingsEntry[] {
		const servers = this.getServers();
		if (this.isAnyServerLoading()) {
			return servers;
		}

		return [...servers].sort((a, b) =>
			this.getServerLabel(a).localeCompare(this.getServerLabel(b))
		);
	}

	/**
	 * Fetches the MCP server list from the Redstart Nest host and merges it
	 * into the local server list. Nest-sourced entries (id prefix `redstart-`)
	 * are replaced by the fetch; user-added and local stdio entries survive.
	 *
	 * IDs are derived from the server URL so per-chat enable overrides (keyed
	 * by server ID) survive restarts and re-syncs. If the endpoint is missing
	 * (e.g. plain llama-server without a Nest), the existing list is left
	 * untouched.
	 */
	async syncServersFromHost(): Promise<void> {
		let fetched: { servers?: { name?: string; url?: string }[]; disabledTools?: string[] };
		try {
			fetched = await apiFetch<{
				servers?: { name?: string; url?: string }[];
				disabledTools?: string[];
			}>('/redstart/mcp-servers');
		} catch (err) {
			// Endpoint absent (plain llama-server, no Nest) is expected. A 401 is
			// not: it means this ran before a session existed, and nothing here
			// retries — so the host's servers are never learned. Either way it
			// used to fail silently, which hid the cause completely.
			console.warn('[MCPStore] Could not fetch MCP servers from host:', err);
			return;
		}

		const list = Array.isArray(fetched?.servers) ? fetched.servers : [];
		const entries: MCPServerSettingsEntry[] = list
			.filter((s) => typeof s?.url === 'string' && s.url.trim())
			.map((s) => ({
				id: `${NEST_MCP_SERVER_ID_PREFIX}${(s.url as string).trim().replace(/[^a-zA-Z0-9]+/g, '-')}`,
				enabled: true,
				url: (s.url as string).trim(),
				name: s.name,
				requestTimeoutSeconds:
					Number(config().mcpRequestTimeoutSeconds) || DEFAULT_MCP_CONFIG.requestTimeoutSeconds
			}));

		// An empty list almost always means the host's MCP server is not running
		// yet (the gateway only advertises it while it is up), not that the admin
		// removed it. Merging an empty list would delete the known entry and leave
		// nothing to reconnect to when it comes back, so the server list is left
		// alone in that case. Tool bans below still apply either way.
		if (entries.length === 0) {
			console.warn(
				'[MCPStore] Host advertised no MCP servers (is the model server running?) — keeping the existing list.'
			);
		} else {
			console.log(
				`[MCPStore] Host provisioned ${entries.length} MCP server(s):`,
				entries.map((e) => e.id)
			);

			settingsStore.updateConfig(
				SETTINGS_KEYS.MCP_SERVERS,
				JSON.stringify(mergeNestServers(this.getServers(), entries))
			);

			// Host-provisioned servers are on by default. checkServerEnabled
			// consults only per-chat overrides and defaults to false, so without
			// seeding one here a centrally-provisioned server can never be used: it
			// never connects, and the tools picker lists groups only for
			// *connected* servers — leaving no control anywhere to turn it on. The
			// admin already made this decision server-side, so honor it. Seeded as
			// a default, not a forced value: an explicit per-chat "off" survives.
			for (const entry of entries) {
				conversationsStore.seedMcpServerDefault(entry.id, true);
			}
		}

		// Server-enforced tool bans. The gateway is the real enforcement point,
		// but we capture the list here so toolsStore can keep a banned tool from
		// being locally re-enabled in the UI, and so it applies before the next
		// MCP re-sync.
		const disabled = Array.isArray(fetched?.disabledTools) ? fetched.disabledTools : [];
		toolsStore.setServerDisabledTools(disabled);
	}

	/**
	 * Mirrors the desktop-local twig-mcp.json entries into the settings server
	 * list as stdio entries, so hand-edited file entries appear in the UI
	 * without a manual add. Settings ids equal the twig-mcp.json keys (the
	 * manager resolves spawns by that key); `transport: 'stdio'` marks the
	 * mirrored entries so stale ones are pruned on re-sync. twig-mcp.json is
	 * the source of truth: settings carry only display data (command/args) and
	 * the enabled flag, never spawn authority. No-op outside the Twig shell.
	 */
	async syncLocalServersFromTwig(): Promise<void> {
		const api = twigMcpApi();
		if (!api) return;

		let fileEntries: Awaited<ReturnType<typeof api.list>>;
		try {
			fileEntries = await api.list();
		} catch {
			return;
		}

		const servers = this.getServers();
		const nonLocal = servers.filter((s) => s.transport !== 'stdio');
		const localEntries: MCPServerSettingsEntry[] = fileEntries.map((entry) => {
			const existing = servers.find((s) => s.id === entry.id);
			return {
				id: entry.id,
				enabled: existing?.enabled ?? true,
				url: '',
				name: entry.id,
				requestTimeoutSeconds:
					existing?.requestTimeoutSeconds ??
					(Number(config().mcpRequestTimeoutSeconds) || DEFAULT_MCP_CONFIG.requestTimeoutSeconds),
				transport: 'stdio',
				command: entry.command,
				args: entry.args
			};
		});

		settingsStore.updateConfig(
			SETTINGS_KEYS.MCP_SERVERS,
			JSON.stringify([...nonLocal, ...localEntries])
		);
	}

	addServer(
		serverData: Omit<MCPServerSettingsEntry, 'id' | 'requestTimeoutSeconds'> & { id?: string }
	): void {
		const servers = this.getServers();
		const newServer: MCPServerSettingsEntry = {
			id: serverData.id || (uuid() ?? `server-${Date.now()}`),
			enabled: serverData.enabled,
			url: serverData.url.trim(),
			name: serverData.name,
			headers: serverData.headers?.trim() || undefined,
			requestTimeoutSeconds:
				Number(config().mcpRequestTimeoutSeconds) || DEFAULT_MCP_CONFIG.requestTimeoutSeconds,
			useProxy: serverData.useProxy
		};
		settingsStore.updateConfig(SETTINGS_KEYS.MCP_SERVERS, JSON.stringify([...servers, newServer]));
	}

	updateServer(id: string, updates: Partial<MCPServerSettingsEntry>): void {
		const servers = this.getServers();
		settingsStore.updateConfig(
			SETTINGS_KEYS.MCP_SERVERS,
			JSON.stringify(
				servers.map((server) => (server.id === id ? { ...server, ...updates } : server))
			)
		);
	}

	removeServer(id: string): void {
		const servers = this.getServers();
		settingsStore.updateConfig(
			SETTINGS_KEYS.MCP_SERVERS,
			JSON.stringify(servers.filter((s) => s.id !== id))
		);
		this.health.clearHealthCheck(id);
	}

	hasAvailableServers(): boolean {
		return parseMcpServerSettings(config().mcpServers).some(
			(s) => s.enabled && (s.url.trim() || s.transport === 'stdio')
		);
	}
	hasEnabledServers(perChatOverrides?: McpServerOverride[]): boolean {
		return Boolean(buildMcpClientConfig(config(), perChatOverrides));
	}

	getEnabledServersForConversation(
		perChatOverrides?: McpServerOverride[]
	): MCPServerSettingsEntry[] {
		return this.getServers().filter((server) => {
			return checkServerEnabled(server, perChatOverrides);
		});
	}
}
