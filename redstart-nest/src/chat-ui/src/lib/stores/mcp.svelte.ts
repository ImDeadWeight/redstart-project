/**
 * mcpStore - Reactive State Store for MCP Operations
 *
 * Implements the "Host" role in MCP architecture, coordinating multiple server
 * connections and providing a unified interface for tool operations.
 *
 * **Architecture & Relationships:**
 * - **MCPService**: Stateless protocol layer (transport, connect, callTool)
 * - **mcpStore** (this): Reactive state + business logic
 *
 * **Key Responsibilities:**
 * - Lifecycle management (initialize, shutdown)
 * - Multi-server coordination
 * - Tool name conflict detection and resolution
 * - OpenAI-compatible tool definition generation
 * - Automatic tool-to-server routing
 * - Health checks
 *
 * @see MCPService in services/mcp.service.ts for protocol operations
 */

import { MCPService } from '$lib/services/mcp.service';
import { config } from '$lib/stores/settings.svelte';
import { mcpResourceStore } from '$lib/stores/mcp-resources.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import { HealthCheckStatus, MCPRefType } from '$lib/enums';
import { DEFAULT_CACHE_TTL_MS } from '$lib/constants';
import type {
	MCPToolCall,
	OpenAIToolDefinition,
	ServerStatus,
	ToolExecutionResult,
	MCPConnection,
	HealthCheckParams,
	MCPPromptInfo,
	GetPromptResult,
	Tool,
	HealthCheckState,
	MCPServerSettingsEntry,
	MCPResourceAttachment,
	MCPResourceContent
} from '$lib/types';
import type { DatabaseMessageExtraMcpResource, McpServerOverride } from '$lib/types/database';
import { buildMcpClientConfig } from '$lib/stores/mcp/mcp-config';
import { MCPHealth } from '$lib/stores/mcp/mcp-health.svelte';
import { MCPServers } from '$lib/stores/mcp/mcp-servers.svelte';
import { MCPTools } from '$lib/stores/mcp/mcp-tools.svelte';
import { MCPConnections } from '$lib/stores/mcp/mcp-connections.svelte';
import { MCPToolOps } from '$lib/stores/mcp/mcp-tool-ops';

class MCPStore {
	/**
	 * Sub-stores, declared in dependency order — these are field initialisers, so
	 * each one may only reference sub-stores declared above it. The graph is a
	 * DAG and this is its topological sort.
	 *
	 *     tools ← conn ← health ← servers
	 *       ↖______↖ toolOps
	 *
	 * Reordering these lines is caught (`ts(2729)`, "used before its
	 * initialization"). Passing a *fresh* collaborator instead of the field above
	 * — `new MCPHealth(this.conn, new MCPTools())` — is not: it typechecks, and
	 * the store then quietly maintains a second tool index nothing else reads.
	 * That one is pinned by a test; see "wires its sub-stores into one object
	 * graph" in tests/unit/store-facades.test.ts.
	 */

	/** The tool-name index and its reactive count. Leaf: depends on nothing. */
	readonly tools = new MCPTools();

	/** The connection pool and its lifecycle. Writes the tool index. */
	readonly conn = new MCPConnections(this.tools);

	/**
	 * Health-check state and the probe that fills it. Reaches forward into the
	 * pool and the index to promote a healthy probe to an active connection.
	 */
	readonly health = new MCPHealth(this.conn, this.tools);

	/**
	 * The settings-backed server registry and everything derived from it for
	 * display. Reads the health checks for labels, favicons and sort order.
	 */
	readonly servers = new MCPServers(this.health);

	/**
	 * Tool discovery, Nest provenance and execution. Needs the index to route a
	 * call and the pool to make it, so it takes both — and is its own module
	 * rather than part of mcp-tools because the pool already depends on the
	 * index. See the header there.
	 */
	readonly toolOps = new MCPToolOps(this.tools, this.conn);

	/**
	 * Reads the sub-store's `$state` so the methods still on this facade that
	 * iterate the record (hasPromptsCapability, hasResourcesCapability,
	 * getServersWithResources) keep working unchanged. Goes away when seams 5e
	 * and 5f move them.
	 */
	private get _healthChecks(): Record<string, HealthCheckState> {
		return this.health.healthChecks;
	}

	get isProxyAvailable(): boolean {
		return serverStore.props?.cors_proxy_enabled ?? false;
	}

	get isInitializing(): boolean {
		return this.conn.isInitializing;
	}

	get isInitialized(): boolean {
		return this.conn.isInitialized;
	}

	get error(): string | null {
		return this.conn.error;
	}

	get toolCount(): number {
		return this.tools.toolCount;
	}

	get connectedServerCount(): number {
		return this.conn.connectedServers.length;
	}

	get connectedServerNames(): string[] {
		return this.conn.connectedServers;
	}

	/**
	 * Get all active MCP connections.
	 * @returns Map of server names to connections
	 */
	getConnections(): Map<string, MCPConnection> {
		return this.conn.getConnections();
	}

	async ensureInitialized(perChatOverrides?: McpServerOverride[]): Promise<boolean> {
		return this.conn.ensureInitialized(perChatOverrides);
	}

	acquireConnection(): void {
		this.conn.acquireConnection();
	}

	async releaseConnection(shutdownIfUnused = false): Promise<void> {
		return this.conn.releaseConnection(shutdownIfUnused);
	}

	getActiveFlowCount(): number {
		return this.conn.getActiveFlowCount();
	}

	async shutdown(): Promise<void> {
		return this.conn.shutdown();
	}

	getExistingConnection(serverId: string): MCPConnection | undefined {
		return this.conn.getExistingConnection(serverId);
	}

	getServersStatus(): ServerStatus[] {
		return this.conn.getServersStatus();
	}

	getServerInstructions(): Array<{
		serverName: string;
		serverTitle?: string;
		instructions: string;
	}> {
		return this.conn.getServerInstructions();
	}

	hasServerInstructions(): boolean {
		return this.conn.hasServerInstructions();
	}

	get isEnabled(): boolean {
		const mcpConfig = buildMcpClientConfig(config());
		return (
			mcpConfig !== null && mcpConfig !== undefined && Object.keys(mcpConfig.servers).length > 0
		);
	}

	get availableTools(): string[] {
		return Array.from(this.tools.toolsIndex.keys());
	}

	updateHealthCheck(serverId: string, state: HealthCheckState): void {
		this.health.updateHealthCheck(serverId, state);
	}

	getHealthCheckState(serverId: string): HealthCheckState {
		return this.health.getHealthCheckState(serverId);
	}

	hasHealthCheck(serverId: string): boolean {
		return this.health.hasHealthCheck(serverId);
	}

	clearHealthCheck(serverId: string): void {
		this.health.clearHealthCheck(serverId);
	}

	clearAllHealthChecks(): void {
		this.health.clearAllHealthChecks();
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
		return this.health.runHealthChecksForServers(servers, skipIfChecked, promoteToActive);
	}

	async runHealthCheck(server: HealthCheckParams, promoteToActive = false): Promise<void> {
		return this.health.runHealthCheck(server, promoteToActive);
	}

	clearError(): void {
		this.conn.clearError();
	}

	getServers(): MCPServerSettingsEntry[] {
		return this.servers.getServers();
	}

	getServerLabel(server: MCPServerSettingsEntry): string {
		return this.servers.getServerLabel(server);
	}

	getServerById(serverId: string): MCPServerSettingsEntry | undefined {
		return this.servers.getServerById(serverId);
	}

	getServerDisplayName(serverId: string): string {
		return this.servers.getServerDisplayName(serverId);
	}

	getServerFavicon(serverId: string): string | null {
		return this.servers.getServerFavicon(serverId);
	}

	isAnyServerLoading(): boolean {
		return this.servers.isAnyServerLoading();
	}

	getServersSorted(): MCPServerSettingsEntry[] {
		return this.servers.getServersSorted();
	}

	async syncServersFromHost(): Promise<void> {
		return this.servers.syncServersFromHost();
	}

	async syncLocalServersFromTwig(): Promise<void> {
		return this.servers.syncLocalServersFromTwig();
	}

	addServer(
		serverData: Omit<MCPServerSettingsEntry, 'id' | 'requestTimeoutSeconds'> & { id?: string }
	): void {
		this.servers.addServer(serverData);
	}

	updateServer(id: string, updates: Partial<MCPServerSettingsEntry>): void {
		this.servers.updateServer(id, updates);
	}

	removeServer(id: string): void {
		this.servers.removeServer(id);
	}

	hasAvailableServers(): boolean {
		return this.servers.hasAvailableServers();
	}

	hasEnabledServers(perChatOverrides?: McpServerOverride[]): boolean {
		return this.servers.hasEnabledServers(perChatOverrides);
	}

	getEnabledServersForConversation(
		perChatOverrides?: McpServerOverride[]
	): MCPServerSettingsEntry[] {
		return this.servers.getEnabledServersForConversation(perChatOverrides);
	}

	getToolNames(): string[] {
		return this.tools.getToolNames();
	}

	hasTool(toolName: string): boolean {
		return this.tools.hasTool(toolName);
	}

	getToolServer(toolName: string): string | undefined {
		return this.tools.getToolServer(toolName);
	}

	/** Public accessor for a tool's provenance, by name. See redstartMeta. */
	getNestToolMeta(toolName: string): { capability: string | null; toolClass: string | null } {
		return this.toolOps.getNestToolMeta(toolName);
	}

	getNestToolNamesForCapability(capability: string): Set<string> {
		return this.toolOps.getNestToolNamesForCapability(capability);
	}

	getToolDefinitionsForLLM(): OpenAIToolDefinition[] {
		return this.toolOps.getToolDefinitionsForLLM();
	}

	async executeTool(toolCall: MCPToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
		return this.toolOps.executeTool(toolCall, signal);
	}

	async executeToolByName(
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<ToolExecutionResult> {
		return this.toolOps.executeToolByName(toolName, args, signal);
	}

	hasPromptsSupport(): boolean {
		for (const connection of this.conn.connections.values()) {
			if (connection.serverCapabilities?.prompts) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if any enabled server with successful health check supports prompts.
	 * Uses health check state since servers may not have active connections until
	 * the user actually sends a message or uses prompts.
	 * @param perChatOverrides - Per-chat server overrides to filter by enabled servers.
	 *                          If provided (even empty array), only checks enabled servers.
	 *                          If undefined, checks all servers with successful health checks.
	 */
	hasPromptsCapability(perChatOverrides?: McpServerOverride[]): boolean {
		// If perChatOverrides is provided (even empty array), filter by enabled servers
		if (perChatOverrides !== undefined) {
			const enabledServerIds = new Set(
				perChatOverrides.filter((o) => o.enabled).map((o) => o.serverId)
			);

			// No enabled servers = no capability
			if (enabledServerIds.size === 0) {
				return false;
			}

			// Check health check states for enabled servers with prompts capability
			for (const [serverId, state] of Object.entries(this._healthChecks)) {
				if (!enabledServerIds.has(serverId)) continue;
				if (
					state.status === HealthCheckStatus.SUCCESS &&
					state.capabilities?.server?.prompts !== undefined
				) {
					return true;
				}
			}

			// Also check active connections as fallback
			for (const [serverName, connection] of this.conn.connections) {
				if (!enabledServerIds.has(serverName)) continue;
				if (connection.serverCapabilities?.prompts) {
					return true;
				}
			}

			return false;
		}

		// No overrides provided - check all servers (global mode)
		for (const state of Object.values(this._healthChecks)) {
			if (
				state.status === HealthCheckStatus.SUCCESS &&
				state.capabilities?.server?.prompts !== undefined
			) {
				return true;
			}
		}

		for (const connection of this.conn.connections.values()) {
			if (connection.serverCapabilities?.prompts) {
				return true;
			}
		}

		return false;
	}

	async getAllPrompts(): Promise<MCPPromptInfo[]> {
		const results: MCPPromptInfo[] = [];

		for (const [serverName, connection] of this.conn.connections) {
			if (!connection.serverCapabilities?.prompts) continue;

			const prompts = await MCPService.listPrompts(connection);

			for (const prompt of prompts) {
				results.push({
					name: prompt.name,
					description: prompt.description,
					title: prompt.title,
					serverName,
					arguments: prompt.arguments?.map((arg) => ({
						name: arg.name,
						description: arg.description,
						required: arg.required
					}))
				});
			}
		}

		return results;
	}

	async getPrompt(
		serverName: string,
		promptName: string,
		args?: Record<string, string>
	): Promise<GetPromptResult> {
		const connection = this.conn.connections.get(serverName);
		if (!connection) throw new Error(`Server "${serverName}" not found for prompt "${promptName}"`);

		return MCPService.getPrompt(connection, promptName, args);
	}

	async getPromptCompletions(
		serverName: string,
		promptName: string,
		argumentName: string,
		argumentValue: string
	): Promise<{ values: string[]; total?: number; hasMore?: boolean } | null> {
		const connection = this.conn.connections.get(serverName);
		if (!connection) {
			console.warn(`[MCPStore] Server "${serverName}" is not connected`);
			return null;
		}
		if (!connection.serverCapabilities?.completions) {
			return null;
		}

		return MCPService.complete(
			connection,
			{ type: MCPRefType.PROMPT, name: promptName },
			{ name: argumentName, value: argumentValue }
		);
	}

	/**
	 * Get completions for a resource template argument.
	 * Uses the MCP Completion API with ref/resource.
	 */
	async getResourceCompletions(
		serverName: string,
		uriTemplate: string,
		argumentName: string,
		argumentValue: string
	): Promise<{ values: string[]; total?: number; hasMore?: boolean } | null> {
		const connection = this.conn.connections.get(serverName);

		if (!connection) {
			console.warn(`[MCPStore] Server "${serverName}" is not connected`);
			return null;
		}

		if (!connection.serverCapabilities?.completions) {
			return null;
		}

		return MCPService.complete(
			connection,
			{ type: MCPRefType.RESOURCE, uri: uriTemplate },
			{ name: argumentName, value: argumentValue }
		);
	}

	/**
	 * Read a resource by an arbitrary URI (e.g., one expanded from a template).
	 * Unlike readResource(), this does not require the URI to be in the resources list.
	 */
	async readResourceByUri(serverName: string, uri: string): Promise<MCPResourceContent[] | null> {
		const connection = this.conn.connections.get(serverName);

		if (!connection) {
			console.error(`[MCPStore] No connection found for server: ${serverName}`);

			return null;
		}

		try {
			const result = await MCPService.readResource(connection, uri);

			return result.contents;
		} catch (error) {
			console.error(`[MCPStore] Failed to read resource ${uri}:`, error);

			return null;
		}
	}

	getHealthCheckInstructions(): Array<{
		serverId: string;
		serverTitle?: string;
		instructions: string;
	}> {
		return this.health.getHealthCheckInstructions();
	}

	/**
	 *
	 *
	 * Resources Operations
	 *
	 *
	 */

	/**
	 * Check if any enabled server with successful health check supports resources.
	 * Uses health check state since servers may not have active connections until
	 * the user actually sends a message or uses prompts.
	 * @param perChatOverrides - Per-chat server overrides to filter by enabled servers.
	 *                          If provided (even empty array), only checks enabled servers.
	 *                          If undefined, checks all servers with successful health checks.
	 */
	hasResourcesCapability(perChatOverrides?: McpServerOverride[]): boolean {
		// If perChatOverrides is provided (even empty array), filter by enabled servers
		if (perChatOverrides !== undefined) {
			const enabledServerIds = new Set(
				perChatOverrides.filter((o) => o.enabled).map((o) => o.serverId)
			);
			// No enabled servers = no capability
			if (enabledServerIds.size === 0) {
				return false;
			}

			// Check health check states for enabled servers with resources capability
			for (const [serverId, state] of Object.entries(this._healthChecks)) {
				if (!enabledServerIds.has(serverId)) continue;
				if (
					state.status === HealthCheckStatus.SUCCESS &&
					state.capabilities?.server?.resources !== undefined
				) {
					return true;
				}
			}

			// Also check active connections as fallback
			for (const [serverName, connection] of this.conn.connections) {
				if (!enabledServerIds.has(serverName)) continue;
				if (MCPService.supportsResources(connection)) {
					return true;
				}
			}

			return false;
		}

		// No overrides provided - check all servers (global mode)
		for (const state of Object.values(this._healthChecks)) {
			if (
				state.status === HealthCheckStatus.SUCCESS &&
				state.capabilities?.server?.resources !== undefined
			) {
				return true;
			}
		}

		for (const connection of this.conn.connections.values()) {
			if (MCPService.supportsResources(connection)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get list of servers that support resources.
	 * Checks active connections first, then health check state as fallback.
	 */
	getServersWithResources(): string[] {
		const servers: string[] = [];

		// Check active connections
		for (const [name, connection] of this.conn.connections) {
			if (MCPService.supportsResources(connection) && !servers.includes(name)) {
				servers.push(name);
			}
		}

		// Also check health check states for servers not yet connected
		for (const [serverId, state] of Object.entries(this._healthChecks)) {
			if (
				!servers.includes(serverId) &&
				state.status === HealthCheckStatus.SUCCESS &&
				state.capabilities?.server?.resources !== undefined
			) {
				servers.push(serverId);
			}
		}

		return servers;
	}

	/**
	 * Fetch resources from all connected servers that support them.
	 * Updates mcpResourceStore with the results.
	 * @param forceRefresh - If true, bypass cache and fetch fresh data
	 */
	async fetchAllResources(forceRefresh: boolean = false): Promise<void> {
		const serversWithResources = this.getServersWithResources();
		if (serversWithResources.length === 0) {
			return;
		}

		// Check if we have cached resources and they're recent (unless force refresh)
		if (!forceRefresh) {
			const allServersCached = serversWithResources.every((serverName) => {
				const serverRes = mcpResourceStore.getServerResources(serverName);
				if (!serverRes || !serverRes.lastFetched) {
					return false;
				}

				// Cache is valid for 5 minutes
				const age = Date.now() - serverRes.lastFetched.getTime();

				return age < DEFAULT_CACHE_TTL_MS;
			});

			if (allServersCached) {
				console.log('[MCPStore] Using cached resources');

				return;
			}
		}

		mcpResourceStore.setLoading(true);

		try {
			await Promise.all(
				serversWithResources.map((serverName) => this.fetchServerResources(serverName))
			);
		} finally {
			mcpResourceStore.setLoading(false);
		}
	}

	/**
	 * Fetch resources from a specific server.
	 * Updates mcpResourceStore with the results.
	 */
	async fetchServerResources(serverName: string): Promise<void> {
		const connection = this.conn.connections.get(serverName);
		if (!connection) {
			console.warn(`[MCPStore] No connection found for server: ${serverName}`);
			return;
		}

		if (!MCPService.supportsResources(connection)) {
			return;
		}

		mcpResourceStore.setServerLoading(serverName, true);

		try {
			const [resources, templates] = await Promise.all([
				MCPService.listAllResources(connection),
				MCPService.listAllResourceTemplates(connection)
			]);

			mcpResourceStore.setServerResources(serverName, resources, templates);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResourceStore.setServerError(serverName, message);
			console.error(`[MCPStore][${serverName}] Failed to fetch resources:`, error);
		}
	}

	/**
	 * Read resource content from a server.
	 * Caches the result in mcpResourceStore.
	 */
	async readResource(uri: string): Promise<MCPResourceContent[] | null> {
		// Check cache first
		const cached = mcpResourceStore.getCachedContent(uri);
		if (cached) {
			return cached.content;
		}

		// Find which server has this resource
		const serverName = mcpResourceStore.findServerForUri(uri);
		if (!serverName) {
			console.error(`[MCPStore] No server found for resource URI: ${uri}`);

			return null;
		}

		const connection = this.conn.connections.get(serverName);
		if (!connection) {
			console.error(`[MCPStore] No connection found for server: ${serverName}`);

			return null;
		}

		try {
			const result = await MCPService.readResource(connection, uri);
			const resourceInfo = mcpResourceStore.findResourceByUri(uri);

			if (resourceInfo) {
				mcpResourceStore.cacheResourceContent(resourceInfo, result.contents);
			}

			return result.contents;
		} catch (error) {
			console.error(`[MCPStore] Failed to read resource ${uri}:`, error);

			return null;
		}
	}

	/**
	 * Subscribe to resource updates.
	 */
	async subscribeToResource(uri: string): Promise<boolean> {
		const serverName = mcpResourceStore.findServerForUri(uri);
		if (!serverName) {
			console.error(`[MCPStore] No server found for resource URI: ${uri}`);

			return false;
		}

		const connection = this.conn.connections.get(serverName);
		if (!connection) {
			console.error(`[MCPStore] No connection found for server: ${serverName}`);

			return false;
		}

		if (!MCPService.supportsResourceSubscriptions(connection)) {
			return false;
		}

		try {
			await MCPService.subscribeResource(connection, uri);
			mcpResourceStore.addSubscription(uri, serverName);

			return true;
		} catch (error) {
			console.error(`[MCPStore] Failed to subscribe to resource ${uri}:`, error);

			return false;
		}
	}

	/**
	 * Unsubscribe from resource updates.
	 */
	async unsubscribeFromResource(uri: string): Promise<boolean> {
		const serverName = mcpResourceStore.findServerForUri(uri);
		if (!serverName) {
			console.error(`[MCPStore] No server found for resource URI: ${uri}`);

			return false;
		}

		const connection = this.conn.connections.get(serverName);
		if (!connection) {
			console.error(`[MCPStore] No connection found for server: ${serverName}`);

			return false;
		}

		try {
			await MCPService.unsubscribeResource(connection, uri);
			mcpResourceStore.removeSubscription(uri);

			return true;
		} catch (error) {
			console.error(`[MCPStore] Failed to unsubscribe from resource ${uri}:`, error);

			return false;
		}
	}

	/**
	 * Add a resource as attachment to chat context.
	 * Automatically fetches content if not cached.
	 */
	async attachResource(uri: string): Promise<MCPResourceAttachment | null> {
		const resourceInfo = mcpResourceStore.findResourceByUri(uri);
		if (!resourceInfo) {
			console.error(`[MCPStore] Resource not found: ${uri}`);

			return null;
		}

		// Check if already attached
		if (mcpResourceStore.isAttached(uri)) {
			return null;
		}

		// Add attachment (initially loading)
		const attachment = mcpResourceStore.addAttachment(resourceInfo);

		// Fetch content
		try {
			const content = await this.readResource(uri);

			if (content) {
				mcpResourceStore.updateAttachmentContent(attachment.id, content);
			} else {
				mcpResourceStore.updateAttachmentError(attachment.id, 'Failed to read resource');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResourceStore.updateAttachmentError(attachment.id, message);
		}

		return mcpResourceStore.getAttachment(attachment.id) ?? null;
	}

	/**
	 * Remove a resource attachment from chat context.
	 */
	removeResourceAttachment(attachmentId: string): void {
		mcpResourceStore.removeAttachment(attachmentId);
	}

	/**
	 * Clear all resource attachments.
	 */
	clearResourceAttachments(): void {
		mcpResourceStore.clearAttachments();
	}

	/**
	 * Get formatted resource context for chat.
	 */
	getResourceContextForChat(): string {
		return mcpResourceStore.formatAttachmentsForContext();
	}

	/**
	 * Convert current resource attachments to DatabaseMessageExtra[] and clear them.
	 * Called during message send to persist resources with the user message.
	 */
	consumeResourceAttachmentsAsExtras(): DatabaseMessageExtraMcpResource[] {
		const extras = mcpResourceStore.toMessageExtras();
		if (extras.length > 0) {
			mcpResourceStore.clearAttachments();
		}
		return extras;
	}
}

export const mcpStore = new MCPStore();

export const mcpIsInitializing = () => mcpStore.isInitializing;
export const mcpIsInitialized = () => mcpStore.isInitialized;
export const mcpError = () => mcpStore.error;
export const mcpIsEnabled = () => mcpStore.isEnabled;
export const mcpIsProxyAvailable = () => mcpStore.isProxyAvailable;
export const mcpAvailableTools = () => mcpStore.availableTools;
export const mcpConnectedServerCount = () => mcpStore.connectedServerCount;
export const mcpConnectedServerNames = () => mcpStore.connectedServerNames;
export const mcpToolCount = () => mcpStore.toolCount;
export const mcpServerInstructions = () => mcpStore.getServerInstructions();
export const mcpHasServerInstructions = () => mcpStore.hasServerInstructions();

// Resources exports
export const mcpHasResourcesCapability = () => mcpStore.hasResourcesCapability();
export const mcpServersWithResources = () => mcpStore.getServersWithResources();
export const mcpResourceContext = () => mcpStore.getResourceContextForChat();
