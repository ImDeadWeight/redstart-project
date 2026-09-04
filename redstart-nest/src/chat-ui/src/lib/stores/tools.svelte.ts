import type { OpenAIToolDefinition, ToolEntry, ToolGroup } from '$lib/types';
import { ToolsService } from '$lib/services/tools.service';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { HealthCheckStatus, JsonSchemaType, ToolCallType, ToolSource } from '$lib/enums';
import { config } from '$lib/stores/settings.svelte';
import { twigFsApi } from '$lib/utils/twig';
import { isDestructiveClass } from '$lib/stores/tools/tool-class';
import { toolDisplayName } from '$lib/stores/tools/tool-display';
import {
	LOCAL_OVERRIDDEN_CAPABILITY,
	suppressedServerToolNames
} from '$lib/stores/tools/precedence';
import {
	DISABLED_TOOL_KEYS_LOCALSTORAGE_KEY,
	SANDBOX_TOOL_DEFINITION,
	TOOL_GROUP_LABELS,
	TOOL_SERVER_LABELS
} from '$lib/constants';

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

/** Stable selection identity for a tool, shared by the disabled set and the permission store */
function toolKey(source: ToolSource, name: string, serverId?: string): string {
	switch (source) {
		case ToolSource.MCP:
			return serverId ? `mcp-${serverId}:${name}` : `mcp:${name}`;
		case ToolSource.CUSTOM:
			return `custom:${name}`;
		case ToolSource.FRONTEND:
			return `frontend:${name}`;
		case ToolSource.LOCAL_FS:
			return `local_fs:${name}`;
		default:
			return `builtin:${name}`;
	}
}

function mcpDefinition(
	name: string,
	description: string | undefined,
	schema?: Record<string, unknown>
): OpenAIToolDefinition {
	return {
		type: ToolCallType.FUNCTION,
		function: {
			name,
			description,
			parameters: schema ?? { type: JsonSchemaType.OBJECT, properties: {}, required: [] }
		}
	};
}

class ToolsStore {
	private _builtinTools = $state<OpenAIToolDefinition[]>([]);
	private _loading = $state(false);
	private _error = $state<string | null>(null);
	private _disabledTools = $state(new SvelteSet<string>());
	// Server-enforced tool bans (function names), pushed from Redstart Nest via
	// /redstart/mcp-servers. A banned tool is always treated as disabled
	// regardless of the user's local toggle, mirroring the gateway's own
	// enforcement so the UI can't re-enable what the org disabled.
	private _serverDisabledTools = $state(new SvelteSet<string>());
	private _toolsEndpointUnreachable = $state(false);
	// Local file system tools provided by the Redstart Twig desktop shell. Empty
	// on web/Android and until the user grants a folder inside Twig.
	private _localFsTools = $state<OpenAIToolDefinition[]>([]);
	// Class ('read' | 'write' | 'destructive') per local tool name, as reported
	// by the Twig bridge. These tools never travel over MCP, so there is no
	// `_meta` to carry the class — this map is the only source for them.
	private _localFsToolClasses = $state<Record<string, string>>({});

	constructor() {
		try {
			const stored = localStorage.getItem(DISABLED_TOOL_KEYS_LOCALSTORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					for (const key of parsed) {
						if (typeof key === 'string') this._disabledTools.add(key);
					}
				}
			}
		} catch (err) {
			console.error('[ToolsStore] Failed to load disabled tools from localStorage:', err);
		}

		this.fetchBuiltinTools();
		this.loadLocalFsTools();
	}

	/**
	 * Load the Twig desktop shell's local fs tool definitions, if present. No-op
	 * on web/Android. Call again after the user grants a folder so the newly
	 * available tools appear.
	 */
	async loadLocalFsTools(): Promise<void> {
		const api = twigFsApi();
		if (!api) return;
		try {
			const defs = await api.getTools();
			// Older Twig builds return a bare array; current ones return
			// { tools, classes }. The chat-ui ships independently of the desktop
			// shell, so both shapes stay supported.
			if (Array.isArray(defs)) {
				this._localFsTools = defs;
				this._localFsToolClasses = {};
			} else {
				this._localFsTools = Array.isArray(defs?.tools) ? defs.tools : [];
				this._localFsToolClasses = defs?.classes ?? {};
			}
		} catch (err) {
			console.error('[ToolsStore] Failed to load local fs tools:', err);
		}
	}

	get localFsTools(): OpenAIToolDefinition[] {
		return this._localFsTools;
	}

	/**
	 * The class Redstart reports for a tool, or null when it has none.
	 *
	 * Two sources, because the two filesystems reach us by different transports:
	 * Twig's local tools carry theirs over the IPC bridge, and Nest's arrive on
	 * `tools/list` in `_meta`. Only sources Redstart controls are trusted — see
	 * `mcpStore.redstartMeta`.
	 */
	getToolClass(toolName: string): string | null {
		const local = this._localFsToolClasses[toolName];
		if (typeof local === 'string') return local;
		return mcpStore.getNestToolMeta(toolName).toolClass;
	}

	/**
	 * True when a tool irreversibly removes data, so it must prompt every time
	 * and can never be remembered as "always allow".
	 */
	isDestructiveTool(toolName: string): boolean {
		return isDestructiveClass(this.getToolClass(toolName));
	}

	private persistDisabledTools(): void {
		try {
			localStorage.setItem(
				DISABLED_TOOL_KEYS_LOCALSTORAGE_KEY,
				JSON.stringify([...this._disabledTools])
			);
		} catch {
			// ignore storage errors
		}
	}

	get builtinTools(): OpenAIToolDefinition[] {
		return this._builtinTools;
	}

	get mcpTools(): OpenAIToolDefinition[] {
		return mcpStore.getToolDefinitionsForLLM();
	}

	get frontendTools(): OpenAIToolDefinition[] {
		return config().jsSandboxEnabled ? [SANDBOX_TOOL_DEFINITION] : [];
	}

	get customTools(): OpenAIToolDefinition[] {
		const raw = config().customJson;
		if (!raw || typeof raw !== 'string') return [];

		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];

			return parsed.filter(
				(t: unknown): t is OpenAIToolDefinition =>
					typeof t === 'object' &&
					t !== null &&
					'type' in t &&
					(t as OpenAIToolDefinition).type === 'function' &&
					'function' in t &&
					typeof (t as OpenAIToolDefinition).function?.name === 'string'
			);
		} catch {
			return [];
		}
	}

	/** Normalize MCP tools from live connections when available, fall back to health check data */
	private mcpEntries(): {
		serverId: string;
		serverName: string;
		title?: string;
		sourceLabel?: string;
		definition: OpenAIToolDefinition;
	}[] {
		const out: {
			serverId: string;
			serverName: string;
			title?: string;
			sourceLabel?: string;
			definition: OpenAIToolDefinition;
		}[] = [];

		const connections = mcpStore.getConnections();
		if (connections.size > 0) {
			for (const [serverId, connection] of connections) {
				const serverName = mcpStore.getServerDisplayName(serverId);
				for (const tool of connection.tools) {
					const schema = (tool.inputSchema as Record<string, unknown>) ?? undefined;
					out.push({
						serverId,
						serverName,
						title: typeof tool.title === 'string' ? tool.title : undefined,
						sourceLabel: mcpStore.getNestToolMeta(tool.name).source ?? undefined,
						definition: mcpDefinition(tool.name, tool.description, schema)
					});
				}
			}
		} else {
			for (const { serverId, serverName, tools } of this.getMcpToolsFromHealthChecks()) {
				for (const tool of tools) {
					out.push({
						serverId,
						serverName,
						// The health-check shape carries name and description only, so
						// a tool seen through it keeps its wire name until the live
						// connection is up. Degrading to the truth beats guessing.
						definition: mcpDefinition(tool.name, tool.description)
					});
				}
			}
		}

		return out;
	}

	/** Canonical flat list of tool entries with source metadata and stable keys, deduped by key */
	get allTools(): ToolEntry[] {
		const entries: ToolEntry[] = [];
		const seen = new SvelteSet<string>();

		const push = (entry: ToolEntry) => {
			if (seen.has(entry.key)) return;
			seen.add(entry.key);
			entries.push(entry);
		};

		// When this device has its own filesystem (Twig with a granted folder),
		// Nest's server-side File System capability is withheld, so the model is
		// offered ONE filesystem instead of two pointing at different computers.
		//
		// Ordering alone does not achieve this and never did: `toolKey` is scoped
		// by source, so a local `fs_write_file` and a server `write_file` produce
		// different keys and the dedupe above never sees a collision. Resolved on
		// capability identity from `_meta`, so a rename on either side flows
		// through instead of silently dissolving the rule.
		const suppressedServerTools = suppressedServerToolNames(
			this._localFsTools.length,
			mcpStore.getNestToolNamesForCapability(LOCAL_OVERRIDDEN_CAPABILITY)
		);

		for (const def of this._localFsTools) {
			const name = def.function.name;
			push({
				source: ToolSource.LOCAL_FS,
				displayName: name,
				key: toolKey(ToolSource.LOCAL_FS, name),
				definition: def
			});
		}

		for (const def of this._builtinTools) {
			const name = def.function.name;
			push({
				source: ToolSource.BUILTIN,
				displayName: name,
				key: toolKey(ToolSource.BUILTIN, name),
				definition: def
			});
		}

		for (const def of this.frontendTools) {
			const name = def.function.name;
			push({
				source: ToolSource.FRONTEND,
				displayName: name,
				key: toolKey(ToolSource.FRONTEND, name),
				definition: def
			});
		}

		for (const { serverId, serverName, title, sourceLabel, definition } of this.mcpEntries()) {
			const name = definition.function.name;
			if (suppressedServerTools.has(name)) continue;
			push({
				source: ToolSource.MCP,
				serverId,
				serverName,
				sourceLabel,
				// A tool grouped under its own plugin's header can drop the prefix
				// that names that plugin; one grouped under a bare server name
				// cannot, because then nothing would say where it came from.
				displayName: toolDisplayName(name, title, !!sourceLabel),
				key: toolKey(ToolSource.MCP, name, serverId),
				definition
			});
		}

		for (const def of this.customTools) {
			const name = def.function.name;
			push({
				source: ToolSource.CUSTOM,
				displayName: name,
				key: toolKey(ToolSource.CUSTOM, name),
				definition: def
			});
		}

		return entries;
	}

	/** Tools grouped by category for tree display, derived from the canonical entries */
	get toolGroups(): ToolGroup[] {
		const groups: ToolGroup[] = [];
		const byKey = new SvelteMap<string, ToolGroup>();

		for (const entry of this.allTools) {
			// A plugin gets its own group. Every plugin's tools arrive over Nest's
			// single built-in MCP server, so keying on serverId alone collapses
			// every installed plugin plus Nest's own capabilities into one list —
			// which is exactly what made the namespace prefix the only readable
			// signal of ownership.
			const groupKey =
				entry.source === ToolSource.MCP
					? `mcp:${entry.serverId ?? ''}:${entry.sourceLabel ?? ''}`
					: entry.source;

			let group = byKey.get(groupKey);
			if (!group) {
				group = {
					source: entry.source,
					label: this.groupLabel(entry),
					serverId: entry.serverId,
					tools: []
				};
				byKey.set(groupKey, group);
				groups.push(group);
			}

			group.tools.push(entry);
		}

		return groups;
	}

	private groupLabel(entry: ToolEntry): string {
		switch (entry.source) {
			case ToolSource.MCP:
				// The plugin's name when there is one, since that is the answer to
				// "which of these is ComfyUI"; the server's name otherwise.
				return entry.sourceLabel ?? entry.serverName ?? '';
			case ToolSource.CUSTOM:
				return TOOL_GROUP_LABELS[ToolSource.CUSTOM];
			case ToolSource.FRONTEND:
				return TOOL_GROUP_LABELS[ToolSource.FRONTEND];
			case ToolSource.LOCAL_FS:
				return TOOL_GROUP_LABELS[ToolSource.LOCAL_FS];
			default:
				return TOOL_GROUP_LABELS[ToolSource.BUILTIN];
		}
	}

	/**
	 * Enabled tool definitions for sending to the LLM.
	 * MCP tools keep their normalized schemas from mcpStore.
	 * The API identifies tools by name, so a name is sent at most once.
	 */
	getEnabledToolsForLLM(): OpenAIToolDefinition[] {
		const enabledNames = new SvelteSet<string>();
		for (const entry of this.allTools) {
			if (!this._disabledTools.has(entry.key) && !this._serverDisabledTools.has(entry.definition.function.name)) {
				enabledNames.add(entry.definition.function.name);
			}
		}

		const result: OpenAIToolDefinition[] = [];
		const seen = new SvelteSet<string>();

		const take = (def: OpenAIToolDefinition) => {
			const name = def.function.name;
			if (!enabledNames.has(name) || seen.has(name)) return;
			seen.add(name);
			result.push(def);
		};

		// Local fs tools first so they shadow any identically named server tool.
		for (const def of this._localFsTools) take(def);
		for (const def of this._builtinTools) take(def);
		for (const def of this.frontendTools) take(def);
		for (const def of mcpStore.getToolDefinitionsForLLM()) take(def);
		for (const def of this.customTools) take(def);

		return result;
	}

	get allToolDefinitions(): OpenAIToolDefinition[] {
		return this.allTools.map((t) => t.definition);
	}

	get loading(): boolean {
		return this._loading;
	}

	get error(): string | null {
		return this._error;
	}

	get isToolsEndpointUnreachable(): boolean {
		return this._toolsEndpointUnreachable;
	}

	get disabledTools(): SvelteSet<string> {
		return this._disabledTools;
	}

	/** Tool function names banned by the server (read-only in the UI). */
	get serverDisabledTools(): SvelteSet<string> {
		return this._serverDisabledTools;
	}

	isToolEnabled(key: string): boolean {
		return !this._disabledTools.has(key) && !this.isServerDisabled(key);
	}

	/** A tool is server-banned when its function name is in the server's deny list. */
	isServerDisabled(key: string): boolean {
		const entry = this.allTools.find((t) => t.key === key);
		const name = entry?.definition.function.name;
		return !!name && this._serverDisabledTools.has(name);
	}

	/** Replace the server-enforced ban set (called from the MCP server sync). */
	setServerDisabledTools(names: string[]): void {
		this._serverDisabledTools = new SvelteSet(
			Array.isArray(names) ? names.filter((n) => typeof n === 'string') : []
		);
	}

	toggleTool(key: string): void {
		// Never allow re-enabling a server-banned tool via the UI.
		if (this.isServerDisabled(key)) return;
		if (this._disabledTools.has(key)) {
			this._disabledTools.delete(key);
		} else {
			this._disabledTools.add(key);
		}
		this.persistDisabledTools();
	}

	setToolEnabled(key: string, enabled: boolean): void {
		if (enabled) {
			this._disabledTools.delete(key);
		} else {
			this._disabledTools.add(key);
		}
	}

	/** Enable all tools belonging to a specific MCP server */
	enableAllToolsForServer(serverId: string): void {
		const connection = mcpStore.getConnections().get(serverId);
		if (!connection) return;
		for (const tool of connection.tools) {
			const key = toolKey(ToolSource.MCP, tool.name, serverId);
			if (this.isServerDisabled(key)) continue;
			this._disabledTools.delete(key);
		}
		this.persistDisabledTools();
	}

	toggleGroup(group: ToolGroup): void {
		const allEnabled = group.tools.every((t) => this.isToolEnabled(t.key));
		for (const tool of group.tools) {
			// Never flip a server-banned tool on.
			if (this.isServerDisabled(tool.key)) {
				this._disabledTools.add(tool.key);
				continue;
			}
			this.setToolEnabled(tool.key, !allEnabled);
		}
		this.persistDisabledTools();
	}

	isGroupFullyEnabled(group: ToolGroup): boolean {
		return group.tools.length > 0 && group.tools.every((t) => this.isToolEnabled(t.key));
	}

	/** Get MCP tools from health check data, used when live connections aren't established yet */
	private getMcpToolsFromHealthChecks(): {
		serverId: string;
		serverName: string;
		tools: { name: string; description?: string }[];
	}[] {
		const result: ReturnType<ToolsStore['getMcpToolsFromHealthChecks']> = [];
		for (const server of mcpStore.getServersSorted().filter((s) => s.enabled)) {
			const health = mcpStore.getHealthCheckState(server.id);
			if (health.status === HealthCheckStatus.SUCCESS && health.tools.length > 0) {
				result.push({
					serverId: server.id,
					serverName: mcpStore.getServerLabel(server),
					tools: health.tools
				});
			}
		}
		return result;
	}

	/** First canonical entry matching a tool name, runtime tool calls resolve by name */
	private findEntryByName(toolName: string): ToolEntry | null {
		for (const entry of this.allTools) {
			if (entry.definition.function.name === toolName) return entry;
		}
		return null;
	}

	/** Determine the source of a tool by its name */
	getToolSource(toolName: string): ToolSource | null {
		return this.findEntryByName(toolName)?.source ?? null;
	}

	/** Get the display label for the server that owns a given tool */
	getToolServerLabel(toolName: string): string {
		const entry = this.findEntryByName(toolName);
		if (!entry) return '';
		if (entry.serverName) return mcpStore.getServerDisplayName(entry.serverName);
		if (entry.source === ToolSource.BUILTIN) return TOOL_SERVER_LABELS[ToolSource.BUILTIN];
		if (entry.source === ToolSource.CUSTOM) return TOOL_SERVER_LABELS[ToolSource.CUSTOM];
		if (entry.source === ToolSource.FRONTEND) return TOOL_SERVER_LABELS[ToolSource.FRONTEND];
		if (entry.source === ToolSource.LOCAL_FS) return TOOL_SERVER_LABELS[ToolSource.LOCAL_FS];
		return '';
	}

	/** Permission key for a tool name, identical to the selection key */
	getPermissionKey(toolName: string): string | null {
		return this.findEntryByName(toolName)?.key ?? null;
	}

	/** Check if there are any enabled tools available (builtin, MCP, or custom) */
	get hasEnabledTools(): boolean {
		return this.getEnabledToolsForLLM().length > 0;
	}

	async fetchBuiltinTools(): Promise<void> {
		if (this._loading) return;

		this._loading = true;
		this._error = null;
		this._toolsEndpointUnreachable = false;

		try {
			const toolInfos = await ToolsService.list();
			this._builtinTools = toolInfos.map((info) => info.definition);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this._error = errorMessage;
			// 404 from /tools means the server was started without --tools
			if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
				this._toolsEndpointUnreachable = true;
			}
			console.error('[ToolsStore] Failed to fetch built-in tools:', err);
		} finally {
			this._loading = false;
		}
	}
}

export const toolsStore = new ToolsStore();

export const allTools = () => toolsStore.allTools;
export const allToolDefinitions = () => toolsStore.allToolDefinitions;
export const toolGroups = () => toolsStore.toolGroups;
