/**
 * mcp-health - MCP server health checks: the record, and the probe that fills it
 *
 * Owns the per-server health-check state and the accessors over it, plus the
 * probe itself — connect, list tools, record the result, and either promote the
 * connection to an active one or drop it.
 *
 * Two things about its position in the graph. It is read by mcp-servers, which
 * derives every server's label, favicon and sort order from it; and it reaches
 * *forward* into the connection pool and the tool index to promote a healthy
 * probe. That is a DAG, not a cycle — servers → health → {connections → tools}
 * — but it does mean this store must be constructed after both of them. See the
 * field order in the facade.
 *
 * Seam 5a0 extracted the state; seam 5d folded in the operations.
 */

import { HealthCheckStatus, MCPConnectionPhase, MCPLogLevel, MCPTransportType } from '$lib/enums';
import { MCPService } from '$lib/services/mcp.service';
import { DEFAULT_MCP_CONFIG } from '$lib/constants';
import { detectMcpTransportFromUrl } from '$lib/utils';
import type {
	HealthCheckState,
	HealthCheckParams,
	MCPConnection,
	MCPConnectionLog,
	MCPServerConfig
} from '$lib/types';
import { buildCapabilitiesInfo, parseHeaders } from './mcp-config';
import type { MCPConnections } from './mcp-connections.svelte';
import type { MCPTools } from './mcp-tools.svelte';

export class MCPHealth {
	constructor(
		private readonly conn: MCPConnections,
		private readonly tools: MCPTools
	) {}

	healthChecks = $state<Record<string, HealthCheckState>>({});

	updateHealthCheck(serverId: string, state: HealthCheckState): void {
		this.healthChecks = { ...this.healthChecks, [serverId]: state };
	}

	getHealthCheckState(serverId: string): HealthCheckState {
		return this.healthChecks[serverId] ?? { status: HealthCheckStatus.IDLE };
	}

	hasHealthCheck(serverId: string): boolean {
		return (
			serverId in this.healthChecks && this.healthChecks[serverId].status !== HealthCheckStatus.IDLE
		);
	}

	clearHealthCheck(serverId: string): void {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { [serverId]: _removed, ...rest } = this.healthChecks;
		this.healthChecks = rest;
	}

	clearAllHealthChecks(): void {
		this.healthChecks = {};
	}

	/**
	 * Get server instructions from health check results (for display before active connection).
	 * Useful for showing instructions in settings UI.
	 */
	getHealthCheckInstructions(): Array<{
		serverId: string;
		serverTitle?: string;
		instructions: string;
	}> {
		const results: Array<{ serverId: string; serverTitle?: string; instructions: string }> = [];

		for (const [serverId, state] of Object.entries(this.healthChecks)) {
			if (state.status === HealthCheckStatus.SUCCESS && state.instructions) {
				results.push({
					serverId,
					serverTitle: state.serverInfo?.title || state.serverInfo?.name,
					instructions: state.instructions
				});
			}
		}

		return results;
	}

	async runHealthChecksForServers(
		servers: {
			id: string;
			enabled: boolean;
			url: string;
			requestTimeoutSeconds: number;
			headers?: string;
			transport?: 'stdio';
		}[],
		skipIfChecked = true,
		promoteToActive = false
	): Promise<void> {
		// stdio entries have no URL — they are checkable whenever they exist.
		const isCheckable = (s: { url: string; transport?: 'stdio' }) =>
			Boolean(s.url.trim()) || s.transport === 'stdio';
		const serversToCheck = skipIfChecked
			? servers.filter((s) => !this.hasHealthCheck(s.id) && isCheckable(s))
			: servers.filter(isCheckable);

		if (serversToCheck.length === 0) {
			return;
		}

		const BATCH_SIZE = 5;
		for (let i = 0; i < serversToCheck.length; i += BATCH_SIZE) {
			const batch = serversToCheck.slice(i, i + BATCH_SIZE);
			await Promise.allSettled(batch.map((server) => this.runHealthCheck(server, promoteToActive)));
		}
	}

	/**
	 * Run a health check for a server.
	 * If the server already has an active connection, reuses it instead of creating a new one.
	 * If promoteToActive is true and server is enabled, the connection will be kept
	 * and promoted to an active connection instead of being disconnected.
	 */
	async runHealthCheck(server: HealthCheckParams, promoteToActive = false): Promise<void> {
		// Check if we already have an active connection for this server
		const existingConnection = this.conn.connections.get(server.id);
		if (existingConnection) {
			// Reuse existing connection - just refresh tools list
			try {
				const tools = await MCPService.listTools(existingConnection);
				const capabilities = buildCapabilitiesInfo(
					existingConnection.serverCapabilities,
					existingConnection.clientCapabilities
				);
				this.updateHealthCheck(server.id, {
					status: HealthCheckStatus.SUCCESS,
					tools: tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						title: tool.title
					})),
					serverInfo: existingConnection.serverInfo,
					capabilities,
					transportType: existingConnection.transportType,
					protocolVersion: existingConnection.protocolVersion,
					instructions: existingConnection.instructions,
					connectionTimeMs: existingConnection.connectionTimeMs,
					logs: []
				});
				return;
			} catch (error) {
				console.warn(
					`[MCPStore] Failed to reuse connection for ${server.id}, creating new one:`,
					error
				);
				// Connection may be stale, remove it and create new one
				this.conn.connections.delete(server.id);
			}
		}

		const trimmedUrl = server.url.trim();
		const logs: MCPConnectionLog[] = [];
		let currentPhase: MCPConnectionPhase = MCPConnectionPhase.IDLE;

		if (!trimmedUrl && server.transport !== 'stdio') {
			this.updateHealthCheck(server.id, {
				status: HealthCheckStatus.ERROR,
				message: 'Please enter a server URL first.',
				logs: []
			});
			return;
		}

		this.updateHealthCheck(server.id, {
			status: HealthCheckStatus.CONNECTING,
			phase: MCPConnectionPhase.TRANSPORT_CREATING,
			logs: []
		});

		const timeoutMs = Math.round(server.requestTimeoutSeconds * 1000);
		const headers = parseHeaders(server.headers);

		try {
			// A stdio health check spawns (or reuses) the local child through the
			// same connect path as any other transport.
			const serverConfig: MCPServerConfig =
				server.transport === 'stdio'
					? {
							transport: MCPTransportType.STDIO,
							stdioId: server.id,
							handshakeTimeoutMs: DEFAULT_MCP_CONFIG.connectionTimeoutMs,
							requestTimeoutMs: timeoutMs
						}
					: {
							url: trimmedUrl,
							transport: detectMcpTransportFromUrl(trimmedUrl),
							handshakeTimeoutMs: DEFAULT_MCP_CONFIG.connectionTimeoutMs,
							requestTimeoutMs: timeoutMs,
							headers,
							useProxy: server.useProxy
						};

			// Store config for reconnection
			this.conn.serverConfigs.set(server.id, serverConfig);

			const connection = await MCPService.connect(
				server.id,
				serverConfig,
				DEFAULT_MCP_CONFIG.clientInfo,
				DEFAULT_MCP_CONFIG.capabilities,
				(phase, log) => {
					currentPhase = phase;
					logs.push(log);
					this.updateHealthCheck(server.id, {
						status: HealthCheckStatus.CONNECTING,
						phase,
						logs: [...logs]
					});

					// Handle WebSocket disconnection
					if (phase === MCPConnectionPhase.DISCONNECTED && promoteToActive) {
						console.log(
							`[MCPStore][${server.id}] Connection lost during health check, starting auto-reconnect`
						);
						this.conn.autoReconnect(server.id);
					}
				}
			);

			const tools = connection.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				title: tool.title
			}));

			const capabilities = buildCapabilitiesInfo(
				connection.serverCapabilities,
				connection.clientCapabilities
			);

			this.updateHealthCheck(server.id, {
				status: HealthCheckStatus.SUCCESS,
				tools,
				serverInfo: connection.serverInfo,
				capabilities,
				transportType: connection.transportType,
				protocolVersion: connection.protocolVersion,
				instructions: connection.instructions,
				connectionTimeMs: connection.connectionTimeMs,
				logs
			});

			// Promote to active connection or disconnect
			if (promoteToActive && server.enabled) {
				this.promoteHealthCheckToConnection(server.id, connection);
			} else {
				await MCPService.disconnect(connection);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error occurred';

			if (logs.at(-1)?.phase !== MCPConnectionPhase.ERROR) {
				logs.push({
					timestamp: new Date(),
					phase: MCPConnectionPhase.ERROR,
					message: `Connection failed: ${message}`,
					level: MCPLogLevel.ERROR
				});
			}

			this.updateHealthCheck(server.id, {
				status: HealthCheckStatus.ERROR,
				message,
				phase: currentPhase,
				logs
			});
		}
	}

	/**
	 * Promote a health check connection to an active connection.
	 * This avoids the need to reconnect when the server is needed for agentic flows.
	 */
	private promoteHealthCheckToConnection(serverId: string, connection: MCPConnection): void {
		// Register tools from the connection
		for (const tool of connection.tools) {
			if (this.tools.toolsIndex.has(tool.name)) {
				console.warn(
					`[MCPStore] Tool name conflict during promotion: "${tool.name}" exists in "${this.tools.toolsIndex.get(tool.name)}" and "${serverId}". Using tool from "${serverId}".`
				);
			}
			this.tools.toolsIndex.set(tool.name, serverId);
		}

		// Add to active connections
		this.conn.connections.set(serverId, connection);

		// Update state
		this.conn.updateState({
			toolCount: this.tools.toolsIndex.size,
			connectedServers: Array.from(this.conn.connections.keys())
		});
	}
}
