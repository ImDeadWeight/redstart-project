/**
 * mcp-connections - the MCP connection pool and its lifecycle
 *
 * Owns every live connection, the configs needed to rebuild one, and the
 * init/shutdown/reconnect machinery around them: connect-all, tool-index
 * population, session recovery after a 404, and auto-reconnect with backoff.
 * Also owns the reactive `isInitializing` / `error` / `connectedServers` the
 * UI reads, and `updateState`, the one writer for all three.
 *
 * It writes the tool index through the injected MCPTools rather than keeping
 * one of its own — the whole reason mcp-tools was extracted first. It knows
 * nothing about the server registry, health checks, prompts or resources; the
 * concerns that read the pool are injected with this, not the other way round.
 */

import { browser } from '$app/environment';
import { MCPService } from '$lib/services/mcp.service';
import { config } from '$lib/stores/settings.svelte';
import { MCPConnectionPhase } from '$lib/enums';
import {
	DEFAULT_MCP_CONFIG,
	MCP_RECONNECT_INITIAL_DELAY,
	MCP_RECONNECT_BACKOFF_MULTIPLIER,
	MCP_RECONNECT_MAX_DELAY,
	MCP_RECONNECT_ATTEMPT_TIMEOUT_MS
} from '$lib/constants';
import type {
	ServerStatus,
	MCPClientConfig,
	MCPConnection,
	MCPServerConfig,
	Tool
} from '$lib/types';
import type { ListChangedHandlers } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerOverride } from '$lib/types/database';
import { buildMcpClientConfig } from './mcp-config';
import type { MCPTools } from './mcp-tools.svelte';

export class MCPConnections {
	constructor(private readonly tools: MCPTools) {}

	isInitializing = $state(false);
	error = $state<string | null>(null);
	connectedServers = $state<string[]>([]);

	connections = new Map<string, MCPConnection>();
	serverConfigs = new Map<string, MCPServerConfig>(); // Store configs for reconnection
	private reconnectingServers = new Set<string>(); // Guard against concurrent reconnections
	private configSignature: string | null = null;
	private initPromise: Promise<boolean> | null = null;
	private activeFlowCount = 0;

	get isInitialized(): boolean {
		return this.connections.size > 0;
	}

	clearError(): void {
		this.error = null;
	}

	updateState(state: {
		isInitializing?: boolean;
		error?: string | null;
		toolCount?: number;
		connectedServers?: string[];
	}): void {
		if (state.isInitializing !== undefined) {
			this.isInitializing = state.isInitializing;
		}

		if (state.error !== undefined) {
			this.error = state.error;
		}

		if (state.toolCount !== undefined) {
			this.tools.toolCount = state.toolCount;
		}

		if (state.connectedServers !== undefined) {
			this.connectedServers = state.connectedServers;
		}
	}

	/**
	 * Get all active MCP connections.
	 * @returns Map of server names to connections
	 */
	getConnections(): Map<string, MCPConnection> {
		return this.connections;
	}

	async ensureInitialized(perChatOverrides?: McpServerOverride[]): Promise<boolean> {
		if (!browser) {
			return false;
		}

		const mcpConfig = buildMcpClientConfig(config(), perChatOverrides);
		const signature = mcpConfig ? JSON.stringify(mcpConfig) : null;
		if (!signature) {
			await this.shutdown();

			return false;
		}
		if (this.isInitialized && this.configSignature === signature) {
			return true;
		}

		if (this.initPromise && this.configSignature === signature) {
			return this.initPromise;
		}

		if (this.connections.size > 0 || this.initPromise) await this.shutdown();
		return this.initialize(signature, mcpConfig!);
	}

	private async initialize(signature: string, mcpConfig: MCPClientConfig): Promise<boolean> {
		this.updateState({ isInitializing: true, error: null });
		this.configSignature = signature;

		const serverEntries = Object.entries(mcpConfig.servers);

		if (serverEntries.length === 0) {
			this.updateState({ isInitializing: false, toolCount: 0, connectedServers: [] });

			return false;
		}
		this.initPromise = this.doInitialize(signature, mcpConfig, serverEntries);

		return this.initPromise;
	}

	private async doInitialize(
		signature: string,
		mcpConfig: MCPClientConfig,
		serverEntries: [string, MCPClientConfig['servers'][string]][]
	): Promise<boolean> {
		const clientInfo = mcpConfig.clientInfo ?? DEFAULT_MCP_CONFIG.clientInfo;
		const capabilities = mcpConfig.capabilities ?? DEFAULT_MCP_CONFIG.capabilities;
		const results = await Promise.allSettled(
			serverEntries.map(async ([name, serverConfig]) => {
				// Store config for reconnection
				this.serverConfigs.set(name, serverConfig);

				const listChangedHandlers = this.createListChangedHandlers(name);
				const connection = await MCPService.connect(
					name,
					serverConfig,
					clientInfo,
					capabilities,
					(phase) => {
						// Handle WebSocket disconnection
						if (phase === MCPConnectionPhase.DISCONNECTED) {
							console.log(`[MCPStore][${name}] Connection lost, starting auto-reconnect`);
							this.autoReconnect(name);
						}
					},
					listChangedHandlers
				);

				return { name, connection };
			})
		);
		if (this.configSignature !== signature) {
			for (const result of results) {
				if (result.status === 'fulfilled')
					await MCPService.disconnect(result.value.connection).catch(console.warn);
			}

			return false;
		}
		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { name, connection } = result.value;

				this.connections.set(name, connection);

				for (const tool of connection.tools) {
					if (this.tools.toolsIndex.has(tool.name))
						console.warn(
							`[MCPStore] Tool name conflict: "${tool.name}" exists in "${this.tools.toolsIndex.get(tool.name)}" and "${name}". Using tool from "${name}".`
						);
					this.tools.toolsIndex.set(tool.name, name);
				}
			} else {
				console.error(`[MCPStore] Failed to connect:`, result.reason);
			}
		}

		const successCount = this.connections.size;
		if (successCount === 0 && serverEntries.length > 0) {
			this.updateState({
				isInitializing: false,
				error: 'All MCP server connections failed',
				toolCount: 0,
				connectedServers: []
			});
			this.initPromise = null;

			return false;
		}

		this.updateState({
			isInitializing: false,
			error: null,
			toolCount: this.tools.toolsIndex.size,
			connectedServers: Array.from(this.connections.keys())
		});
		this.initPromise = null;

		return true;
	}

	private createListChangedHandlers(serverName: string): ListChangedHandlers {
		return {
			tools: {
				onChanged: (error: Error | null, tools: Tool[] | null) => {
					if (error) {
						console.warn(`[MCPStore][${serverName}] Tools list changed error:`, error);
						return;
					}
					this.handleToolsListChanged(serverName, tools ?? []);
				}
			},
			prompts: {
				onChanged: (error: Error | null) => {
					if (error) {
						console.warn(`[MCPStore][${serverName}] Prompts list changed error:`, error);
						return;
					}
				}
			}
		};
	}

	private handleToolsListChanged(serverName: string, tools: Tool[]): void {
		const connection = this.connections.get(serverName);
		if (!connection) {
			return;
		}

		for (const [toolName, ownerServer] of this.tools.toolsIndex.entries()) {
			if (ownerServer === serverName) this.tools.toolsIndex.delete(toolName);
		}

		connection.tools = tools;

		for (const tool of tools) {
			if (this.tools.toolsIndex.has(tool.name))
				console.warn(
					`[MCPStore] Tool name conflict after list change: "${tool.name}" exists in "${this.tools.toolsIndex.get(tool.name)}" and "${serverName}". Using tool from "${serverName}".`
				);
			this.tools.toolsIndex.set(tool.name, serverName);
		}
		this.updateState({ toolCount: this.tools.toolsIndex.size });
	}

	acquireConnection(): void {
		this.activeFlowCount++;
	}

	/**
	 * Release a connection reference.
	 * By default, keeps connections alive for reuse (shutdownIfUnused=false).
	 * MCP spec encourages long-lived sessions to avoid reconnection overhead.
	 */
	async releaseConnection(shutdownIfUnused = false): Promise<void> {
		this.activeFlowCount = Math.max(0, this.activeFlowCount - 1);
		if (shutdownIfUnused && this.activeFlowCount === 0) {
			await this.shutdown();
		}
	}

	getActiveFlowCount(): number {
		return this.activeFlowCount;
	}

	async shutdown(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise.catch(() => {});
			this.initPromise = null;
		}

		if (this.connections.size === 0) {
			return;
		}

		await Promise.all(
			Array.from(this.connections.values()).map((conn) =>
				MCPService.disconnect(conn).catch((error) =>
					console.warn(`[MCPStore] Error disconnecting ${conn.serverName}:`, error)
				)
			)
		);

		this.connections.clear();
		this.tools.toolsIndex.clear();
		this.serverConfigs.clear();
		this.configSignature = null;
		this.updateState({
			isInitializing: false,
			error: null,
			toolCount: 0,
			connectedServers: []
		});
	}

	/**
	 * Immediately reconnect to a server by creating a fresh transport and session.
	 * Used when a session-expired error (HTTP 404) is detected during tool execution.
	 * Per MCP spec 2025-11-25: client MUST discard session ID and re-initialize.
	 *
	 * Unlike autoReconnect (which uses exponential backoff for connectivity issues),
	 * this performs a single immediate reconnection attempt since the server is known
	 * to be reachable (it responded with 404).
	 */
	async reconnectServer(serverName: string): Promise<void> {
		const serverConfig = this.serverConfigs.get(serverName);
		if (!serverConfig) {
			throw new Error(`[MCPStore] No config found for ${serverName}, cannot reconnect`);
		}

		// Disconnect stale connection (clears old transport + session ID)
		const oldConnection = this.connections.get(serverName);
		if (oldConnection) {
			await MCPService.disconnect(oldConnection).catch(console.warn);
			this.connections.delete(serverName);
		}

		console.log(`[MCPStore][${serverName}] Session expired, reconnecting with fresh session...`);

		const listChangedHandlers = this.createListChangedHandlers(serverName);
		const connection = await MCPService.connect(
			serverName,
			serverConfig,
			DEFAULT_MCP_CONFIG.clientInfo,
			DEFAULT_MCP_CONFIG.capabilities,
			(phase) => {
				if (phase === MCPConnectionPhase.DISCONNECTED) {
					console.log(`[MCPStore][${serverName}] Connection lost, starting auto-reconnect`);
					this.autoReconnect(serverName);
				}
			},
			listChangedHandlers
		);

		// Replace connection and rebuild tool index for this server
		this.connections.set(serverName, connection);
		for (const tool of connection.tools) {
			this.tools.toolsIndex.set(tool.name, serverName);
		}

		console.log(`[MCPStore][${serverName}] Session recovered successfully`);
	}

	/**
	 * Auto-reconnect to a server with exponential backoff.
	 * Continues indefinitely until successful.
	 *
	 * Race-condition safety: when the phase callback fires a DISCONNECTED event
	 * while we are still inside this function (e.g., the server drops right after
	 * a successful connect()), a naive inner `autoReconnect()` call would be
	 * swallowed by the `reconnectingServers` guard, leaving the server
	 * permanently disconnected once the outer call exits. We solve this by
	 * deferring the new reconnection via the `needsReconnect` flag: the flag is
	 * set inside the phase callback and honoured in the `finally` block after
	 * the guard entry has been removed.
	 */
	async autoReconnect(serverName: string): Promise<void> {
		// Guard against concurrent reconnections
		if (this.reconnectingServers.has(serverName)) {
			console.log(`[MCPStore][${serverName}] Reconnection already in progress, skipping`);

			return;
		}

		const serverConfig = this.serverConfigs.get(serverName);
		if (!serverConfig) {
			console.error(`[MCPStore] No config found for ${serverName}, cannot reconnect`);

			return;
		}

		this.reconnectingServers.add(serverName);
		let backoff = MCP_RECONNECT_INITIAL_DELAY;
		// Flag set by the phase callback when a DISCONNECTED event fires while
		// reconnectingServers still holds this server (see JSDoc above).
		let needsReconnect = false;

		try {
			while (true) {
				await new Promise((resolve) => setTimeout(resolve, backoff));

				console.log(`[MCPStore][${serverName}] Auto-reconnecting...`);

				try {
					// Per-attempt timeout: reject if the server doesn't respond in time,
					// then fall through to backoff logic as with any other failure.
					const timeoutPromise = new Promise<never>((_, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										`Reconnect attempt timed out after ${MCP_RECONNECT_ATTEMPT_TIMEOUT_MS}ms`
									)
								),
							MCP_RECONNECT_ATTEMPT_TIMEOUT_MS
						)
					);

					needsReconnect = false;
					const listChangedHandlers = this.createListChangedHandlers(serverName);
					const connectPromise = MCPService.connect(
						serverName,
						serverConfig,
						DEFAULT_MCP_CONFIG.clientInfo,
						DEFAULT_MCP_CONFIG.capabilities,
						(phase) => {
							if (phase === MCPConnectionPhase.DISCONNECTED) {
								if (this.reconnectingServers.has(serverName)) {
									// Reconnect loop is active; defer to after it exits.
									needsReconnect = true;
								} else {
									console.log(
										`[MCPStore][${serverName}] Connection lost, restarting auto-reconnect`
									);
									this.autoReconnect(serverName);
								}
							}
						},
						listChangedHandlers
					);

					const connection = await Promise.race([connectPromise, timeoutPromise]);

					// Replace old connection with new one
					this.connections.set(serverName, connection);

					// Rebuild tool index for this server
					for (const tool of connection.tools) {
						this.tools.toolsIndex.set(tool.name, serverName);
					}

					console.log(`[MCPStore][${serverName}] Reconnected successfully`);
					break;
				} catch (error) {
					console.warn(`[MCPStore][${serverName}] Reconnection failed:`, error);
					backoff = Math.min(backoff * MCP_RECONNECT_BACKOFF_MULTIPLIER, MCP_RECONNECT_MAX_DELAY);
				}
			}
		} finally {
			this.reconnectingServers.delete(serverName);
			// If the phase callback signalled a disconnect while this function held
			// the guard, kick off a fresh reconnect now that the guard is released.
			if (needsReconnect) {
				console.log(
					`[MCPStore][${serverName}] Deferred disconnect detected, restarting auto-reconnect`
				);
				this.autoReconnect(serverName);
			}
		}
	}

	/**
	 * Check if a server already has an active connection that can be reused.
	 * Returns the existing connection if available.
	 */
	getExistingConnection(serverId: string): MCPConnection | undefined {
		return this.connections.get(serverId);
	}

	getServersStatus(): ServerStatus[] {
		const statuses: ServerStatus[] = [];

		for (const [name, connection] of this.connections) {
			statuses.push({
				name,
				isConnected: true,
				toolCount: connection.tools.length,
				error: undefined
			});
		}

		return statuses;
	}

	/**
	 * Get aggregated server instructions from all connected servers.
	 * Returns an array of { serverName, serverTitle, instructions } objects.
	 */
	getServerInstructions(): Array<{
		serverName: string;
		serverTitle?: string;
		instructions: string;
	}> {
		const results: Array<{ serverName: string; serverTitle?: string; instructions: string }> = [];

		for (const [serverName, connection] of this.connections) {
			if (connection.instructions) {
				results.push({
					serverName,
					serverTitle: connection.serverInfo?.title || connection.serverInfo?.name,
					instructions: connection.instructions
				});
			}
		}

		return results;
	}

	/**
	 * Check if any connected server has instructions.
	 */
	hasServerInstructions(): boolean {
		for (const connection of this.connections.values()) {
			if (connection.instructions) {
				return true;
			}
		}

		return false;
	}
}
