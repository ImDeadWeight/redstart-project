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

import { config } from '$lib/stores/settings.svelte';
import { mcpResourceStore } from '$lib/stores/mcp-resources.svelte';
import { serverStore } from '$lib/stores/server.svelte';
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
import { MCPPrompts } from '$lib/stores/mcp/mcp-prompts';
import { MCPResourceOps } from '$lib/stores/mcp/mcp-resource-ops';

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
	 * The prompts surface. Reads capability from the health record first and the
	 * live pool second, so it takes both.
	 */
	readonly prompts = new MCPPrompts(this.conn, this.health);

	/**
	 * The resource surface that needs a connection. Pairs with mcpResourceStore,
	 * which owns the caches and attachments; see the header there.
	 */
	readonly resources = new MCPResourceOps(this.conn, this.health);

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

	hasPromptsSupport(): boolean {
		return this.prompts.hasPromptsSupport();
	}

	hasPromptsCapability(perChatOverrides?: McpServerOverride[]): boolean {
		return this.prompts.hasPromptsCapability(perChatOverrides);
	}

	async getAllPrompts(): Promise<MCPPromptInfo[]> {
		return this.prompts.getAllPrompts();
	}

	async getPrompt(
		serverName: string,
		promptName: string,
		args?: Record<string, string>
	): Promise<GetPromptResult> {
		return this.prompts.getPrompt(serverName, promptName, args);
	}

	async getPromptCompletions(
		serverName: string,
		promptName: string,
		argumentName: string,
		argumentValue: string
	): Promise<{ values: string[]; total?: number; hasMore?: boolean } | null> {
		return this.prompts.getPromptCompletions(serverName, promptName, argumentName, argumentValue);
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
	getNestToolMeta(toolName: string): {
		capability: string | null;
		toolClass: string | null;
		source: string | null;
	} {
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


	async getResourceCompletions(
		serverName: string,
		uriTemplate: string,
		argumentName: string,
		argumentValue: string
	): Promise<{ values: string[]; total?: number; hasMore?: boolean } | null> {
		return this.resources.getResourceCompletions(serverName, uriTemplate, argumentName, argumentValue);
	}

	async readResourceByUri(serverName: string, uri: string): Promise<MCPResourceContent[] | null> {
		return this.resources.readResourceByUri(serverName, uri);
	}

	hasResourcesCapability(perChatOverrides?: McpServerOverride[]): boolean {
		return this.resources.hasResourcesCapability(perChatOverrides);
	}

	getServersWithResources(): string[] {
		return this.resources.getServersWithResources();
	}

	async fetchAllResources(forceRefresh: boolean = false): Promise<void> {
		return this.resources.fetchAllResources(forceRefresh);
	}

	async fetchServerResources(serverName: string): Promise<void> {
		return this.resources.fetchServerResources(serverName);
	}

	async readResource(uri: string): Promise<MCPResourceContent[] | null> {
		return this.resources.readResource(uri);
	}

	async subscribeToResource(uri: string): Promise<boolean> {
		return this.resources.subscribeToResource(uri);
	}

	async unsubscribeFromResource(uri: string): Promise<boolean> {
		return this.resources.unsubscribeFromResource(uri);
	}

	async attachResource(uri: string): Promise<MCPResourceAttachment | null> {
		return this.resources.attachResource(uri);
	}

	removeResourceAttachment(attachmentId: string): void {
		this.resources.removeResourceAttachment(attachmentId);
	}

	clearResourceAttachments(): void {
		this.resources.clearResourceAttachments();
	}

	getResourceContextForChat(): string {
		return this.resources.getResourceContextForChat();
	}

	consumeResourceAttachmentsAsExtras(): DatabaseMessageExtraMcpResource[] {
		return this.resources.consumeResourceAttachmentsAsExtras();
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
