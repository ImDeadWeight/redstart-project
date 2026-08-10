import { Client } from '@modelcontextprotocol/sdk/client';
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type {
	Tool,
	Prompt,
	GetPromptResult,
	ListChangedHandlers
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { IpcStdioTransport } from '$lib/services/mcp-stdio-transport';
import { twigMcpApi } from '$lib/utils/twig';
import {
	DEFAULT_MCP_CONFIG,
	DEFAULT_CLIENT_VERSION,
	DEFAULT_IMAGE_MIME_TYPE,
	MCP_PARTIAL_REDACT_HEADERS
} from '$lib/constants';
import {
	MCPConnectionPhase,
	MCPLogLevel,
	MCPTransportType,
	MCPContentType,
	MCPRefType
} from '$lib/enums';
import type {
	MCPServerConfig,
	MCPResourceIcon,
	ToolCallParams,
	ToolExecutionResult,
	Implementation,
	ClientCapabilities,
	MCPConnection,
	MCPPhaseCallback,
	MCPConnectionLog,
	MCPServerInfo,
	MCPResource,
	MCPResourceTemplate,
	MCPResourceContent,
	MCPReadResourceResult
} from '$lib/types';
import {
	buildProxiedUrl,
	buildProxiedHeaders,
	getAuthHeaders,
	sanitizeHeaders,
	throwIfAborted,
	isAbortError,
	createBase64DataUrl
} from '$lib/utils';
import {
	createLog,
	createDiagnosticRequestDetails,
	summarizeError,
	getBrowserContext,
	getConnectionHints,
	createDiagnosticFetch
} from './mcp/mcp-diagnostics';
import { createTransport } from './mcp/mcp-transport';

interface ToolResultContentItem {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { text?: string; blob?: string; uri?: string };
}

interface ToolCallResult {
	content?: ToolResultContentItem[];
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

export class MCPService {
	/**
	 * Detect if an error indicates an expired/invalidated MCP session.
	 * Per MCP spec 2025-11-25: HTTP 404 means session invalidated, client MUST
	 * discard its session ID and start a new session with a fresh initialize request.
	 *
	 * @param error - The caught error to inspect
	 * @returns true if the error is a StreamableHTTP 404 (session not found)
	 */
	static isSessionExpiredError(error: unknown): boolean {
		return error instanceof StreamableHTTPError && error.code === 404;
	}

	/**
	 * Extract server info from SDK Implementation type.
	 * Normalizes the SDK's server version response into our MCPServerInfo type.
	 *
	 * @param impl - Raw Implementation object from MCP SDK
	 * @returns Normalized server info or undefined if input is empty
	 */
	private static extractServerInfo(impl: Implementation | undefined): MCPServerInfo | undefined {
		if (!impl) {
			return undefined;
		}

		return {
			name: impl.name,
			version: impl.version,
			title: impl.title,
			description: impl.description,
			websiteUrl: impl.websiteUrl,
			icons: impl.icons?.map((icon: MCPResourceIcon) => ({
				src: icon.src,
				mimeType: icon.mimeType,
				sizes: icon.sizes,
				theme: icon.theme
			}))
		};
	}

	/**
	 * Connect to a single MCP server with detailed phase tracking.
	 *
	 * Performs the full MCP connection lifecycle:
	 * 1. Transport creation (with automatic fallback)
	 * 2. Client initialization and capability exchange
	 * 3. Tool discovery via `listTools`
	 *
	 * Reports progress via `onPhase` callback at each step, enabling
	 * UI progress indicators during connection.
	 *
	 * @param serverName - Display name for the server (used in logging)
	 * @param serverConfig - Server URL, transport type, proxy, and auth configuration
	 * @param clientInfo - Optional client identification (defaults to app info)
	 * @param capabilities - Optional client capability declaration
	 * @param onPhase - Optional callback for connection phase progress updates
	 * @param listChangedHandlers - Optional handlers for server-initiated list change notifications
	 * @returns Full connection object with client, transport, tools, server info, and timing
	 * @throws {Error} If transport creation or connection fails
	 */
	static async connect(
		serverName: string,
		serverConfig: MCPServerConfig,
		clientInfo?: Implementation,
		capabilities?: ClientCapabilities,
		onPhase?: MCPPhaseCallback,
		listChangedHandlers?: ListChangedHandlers
	): Promise<MCPConnection> {
		const startTime = performance.now();
		const effectiveClientInfo = clientInfo ?? DEFAULT_MCP_CONFIG.clientInfo;
		const effectiveCapabilities = capabilities ?? DEFAULT_MCP_CONFIG.capabilities;

		// Phase: Creating transport
		onPhase?.(
			MCPConnectionPhase.TRANSPORT_CREATING,
			createLog(
				MCPConnectionPhase.TRANSPORT_CREATING,
				`Creating transport for ${serverConfig.url ?? `local stdio server "${serverName}"`}`
			)
		);

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService][${serverName}] Creating transport...`);
		}

		const {
			transport,
			type: transportType,
			stopPhaseLogging
		} = createTransport(serverName, serverConfig, (log) => onPhase?.(log.phase, log));

		// Setup reconnection handler for connection-oriented transports. For
		// stdio, the manager restarts a crashed child but the fresh process has
		// no session state — the host must reconnect (re-initialize) like any
		// dropped connection.
		if (
			transportType === MCPTransportType.WEBSOCKET ||
			transportType === MCPTransportType.STDIO
		) {
			transport.onclose = () => {
				console.log(`[MCPService][${serverName}] Connection closed, notifying for reconnection`);
				onPhase?.(
					MCPConnectionPhase.DISCONNECTED,
					createLog(MCPConnectionPhase.DISCONNECTED, `Connection closed (${transportType})`)
				);
			};
		}

		// Phase: Transport ready
		onPhase?.(
			MCPConnectionPhase.TRANSPORT_READY,
			createLog(MCPConnectionPhase.TRANSPORT_READY, `Transport ready (${transportType})`),
			{ transportType }
		);

		const client = new Client(
			{
				name: effectiveClientInfo.name,
				version: effectiveClientInfo.version ?? DEFAULT_CLIENT_VERSION
			},
			{
				capabilities: effectiveCapabilities,
				listChanged: listChangedHandlers
			}
		);

		const runtimeErrorHandler = (error: Error) => {
			// Ignore errors that are expected when the SDK's transport is closed,
			// or when connecting to servers that don't support SSE (stateless-only
			// endpoints returning 405). The SDK wraps the original AbortError in
			// a new Error with the message "SSE stream disconnected: AbortError",
			// and also produces "Cannot cancel a stream locked by a reader".
			// DOMException is thrown by the browser when aborting fetch requests.
			const msg = error.message || String(error);
			if (
				error.name === 'AbortError' ||
				error instanceof DOMException ||
				msg.includes('SSE stream disconnected') ||
				msg.includes('stream locked by a reader') ||
				msg.includes('The operation was aborted')
			) {
				return;
			}
			console.error(`[MCPService][${serverName}] Protocol error after initialize:`, error);
		};

		client.onerror = (error) => {
			onPhase?.(
				MCPConnectionPhase.ERROR,
				createLog(
					MCPConnectionPhase.ERROR,
					`Protocol error: ${error.message}`,
					MCPLogLevel.ERROR,
					{
						error: summarizeError(error)
					}
				)
			);
		};

		// Phase: Initializing
		onPhase?.(
			MCPConnectionPhase.INITIALIZING,
			createLog(MCPConnectionPhase.INITIALIZING, 'Sending initialize request...')
		);

		try {
			await client.connect(transport);
			// Transport diagnostics are only for the initial handshake, not long-lived traffic.
			stopPhaseLogging();
			client.onerror = runtimeErrorHandler;
		} catch (error) {
			client.onerror = runtimeErrorHandler;
			// stdio entries have no URL — skip the browser/CORS diagnostics that
			// only make sense for HTTP transports.
			const url = serverConfig.url
				? (serverConfig.useProxy ?? false)
					? buildProxiedUrl(serverConfig.url)
					: new URL(serverConfig.url)
				: undefined;

			onPhase?.(
				MCPConnectionPhase.ERROR,
				createLog(
					MCPConnectionPhase.ERROR,
					`Connection failed during initialize: ${
						error instanceof Error ? error.message : String(error)
					}`,
					MCPLogLevel.ERROR,
					{
						error: summarizeError(error),
						config: {
							serverName,
							configuredUrl: serverConfig.url,
							effectiveUrl: url?.href,
							transportType,
							useProxy: serverConfig.useProxy ?? false,
							headers: sanitizeHeaders(
								serverConfig.headers,
								Object.keys(serverConfig.headers ?? {}),
								MCP_PARTIAL_REDACT_HEADERS
							),
							credentials: serverConfig.credentials
						},
						browser: url ? getBrowserContext(url, serverConfig.useProxy ?? false) : undefined,
						hints: url ? getConnectionHints(url, serverConfig, error) : []
					}
				)
			);

			throw error;
		}

		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities();
		const instructions = client.getInstructions();
		const serverInfo = this.extractServerInfo(serverVersion);

		// Phase: Capabilities exchanged
		onPhase?.(
			MCPConnectionPhase.CAPABILITIES_EXCHANGED,
			createLog(
				MCPConnectionPhase.CAPABILITIES_EXCHANGED,
				'Capabilities exchanged successfully',
				MCPLogLevel.INFO,
				{
					serverCapabilities,
					serverInfo
				}
			),
			{
				serverInfo,
				serverCapabilities,
				clientCapabilities: effectiveCapabilities,
				instructions
			}
		);

		// Phase: Listing tools
		onPhase?.(
			MCPConnectionPhase.LISTING_TOOLS,
			createLog(MCPConnectionPhase.LISTING_TOOLS, 'Listing available tools...')
		);

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService][${serverName}] Connected, listing tools...`);
		}

		const tools = await this.listTools({
			client,
			transport,
			tools: [],
			serverName,
			transportType,
			connectionTimeMs: 0,
			requestTimeoutMs:
				serverConfig.requestTimeoutMs ?? DEFAULT_MCP_CONFIG.requestTimeoutSeconds * 1000
		});

		const connectionTimeMs = Math.round(performance.now() - startTime);

		// Phase: Connected
		onPhase?.(
			MCPConnectionPhase.CONNECTED,
			createLog(
				MCPConnectionPhase.CONNECTED,
				`Connection established with ${tools.length} tools (${connectionTimeMs}ms)`
			)
		);
		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(
				`[MCPService][${serverName}] Initialization complete with ${tools.length} tools in ${connectionTimeMs}ms`
			);
		}

		return {
			client,
			transport,
			tools,
			serverName,
			transportType,
			serverInfo,
			serverCapabilities,
			clientCapabilities: effectiveCapabilities,
			protocolVersion: DEFAULT_MCP_CONFIG.protocolVersion,
			instructions,
			connectionTimeMs,
			requestTimeoutMs:
				serverConfig.requestTimeoutMs ?? DEFAULT_MCP_CONFIG.requestTimeoutSeconds * 1000
		};
	}

	/**
	 * Disconnect from a server.
	 * Clears the `onclose` handler to prevent reconnection attempts on voluntary disconnect.
	 *
	 * @param connection - The active MCP connection to close
	 */
	static async disconnect(connection: MCPConnection): Promise<void> {
		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService][${connection.serverName}] Disconnecting...`);
		}

		try {
			// Terminate the session first for streamable-http transports to cleanly
			// close streams, matching the inspector's disconnect flow.
			if (connection.transport instanceof StreamableHTTPClientTransport) {
				await connection.transport.terminateSession();
			}

			// Clear error handlers before closing to prevent noise from expected
			// abort errors during shutdown. The inspector avoids this entirely
			// by not setting onerror, but since we use it for protocol logging,
			// we must clear it before disconnect.
			connection.client.onerror = undefined;
			if (connection.transport.onclose) {
				connection.transport.onclose = undefined;
			}

			await connection.client.close();
		} catch (error) {
			console.warn(`[MCPService][${connection.serverName}] Error during disconnect:`, error);
		}
	}

	/**
	 * List tools from a connection.
	 * Silently returns empty array on failure (logged as warning).
	 *
	 * @param connection - The MCP connection to query
	 * @returns Array of available tools, or empty array on error
	 */
	static async listTools(connection: MCPConnection): Promise<Tool[]> {
		try {
			const result = await connection.client.listTools();

			return result.tools ?? [];
		} catch (error) {
			// Let session-expired errors propagate for reconnection handling
			if (this.isSessionExpiredError(error)) {
				throw error;
			}

			console.warn(`[MCPService][${connection.serverName}] Failed to list tools:`, error);

			return [];
		}
	}

	/**
	 * List prompts from a connection.
	 * Silently returns empty array on failure (logged as warning).
	 *
	 * @param connection - The MCP connection to query
	 * @returns Array of available prompts, or empty array on error
	 */
	static async listPrompts(connection: MCPConnection): Promise<Prompt[]> {
		try {
			const result = await connection.client.listPrompts();

			return result.prompts ?? [];
		} catch (error) {
			// Let session-expired errors propagate for reconnection handling
			if (this.isSessionExpiredError(error)) {
				throw error;
			}

			console.warn(`[MCPService][${connection.serverName}] Failed to list prompts:`, error);

			return [];
		}
	}

	/**
	 * Get a specific prompt with arguments.
	 * Unlike list operations, this throws on failure since the caller explicitly
	 * requested a specific prompt and needs to handle the error.
	 *
	 * @param connection - The MCP connection to use
	 * @param name - The prompt name to retrieve
	 * @param args - Optional key-value arguments to pass to the prompt
	 * @returns The prompt result with messages and metadata
	 * @throws {Error} If the prompt retrieval fails
	 */
	static async getPrompt(
		connection: MCPConnection,
		name: string,
		args?: Record<string, string>
	): Promise<GetPromptResult> {
		try {
			return await connection.client.getPrompt({ name, arguments: args });
		} catch (error) {
			console.error(`[MCPService][${connection.serverName}] Failed to get prompt:`, error);

			throw error;
		}
	}

	/**
	 * Execute a tool call on a connection.
	 * Supports abort signal for cancellable operations (e.g., when user stops generation).
	 * Formats the raw tool result into a string representation.
	 *
	 * @param connection - The MCP connection to execute against
	 * @param params - Tool name and arguments to execute
	 * @param signal - Optional AbortSignal for cancellation support
	 * @returns Formatted tool execution result with content string and error flag
	 * @throws {Error} If tool execution fails or is aborted
	 */
	static async callTool(
		connection: MCPConnection,
		params: ToolCallParams,
		signal?: AbortSignal
	): Promise<ToolExecutionResult> {
		throwIfAborted(signal);

		try {
			const result = await connection.client.callTool(
				{ name: params.name, arguments: params.arguments },
				undefined,
				{ signal, timeout: connection.requestTimeoutMs }
			);

			return {
				content: this.formatToolResult(result as ToolCallResult),
				isError: (result as ToolCallResult).isError ?? false
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			// Let session-expired errors propagate unwrapped for reconnection handling
			if (this.isSessionExpiredError(error)) {
				throw error;
			}

			const message = error instanceof Error ? error.message : String(error);

			throw new Error(
				`Tool "${params.name}" execution failed on server "${connection.serverName}": ${message}`,
				{ cause: error instanceof Error ? error : undefined }
			);
		}
	}

	/**
	 * Format tool result content items to a single string.
	 * Handles text, image (base64 data URL), and embedded resource content types.
	 *
	 * @param result - Raw tool call result from MCP SDK
	 * @returns Concatenated string representation of all content items
	 */
	private static formatToolResult(result: ToolCallResult): string {
		const content = result.content;
		if (!Array.isArray(content)) return '';

		return content
			.map((item) => this.formatSingleContent(item))
			.filter(Boolean)
			.join('\n');
	}

	private static formatSingleContent(content: ToolResultContentItem): string {
		if (content.type === MCPContentType.TEXT && content.text) {
			return content.text;
		}

		if (content.type === MCPContentType.IMAGE && content.data) {
			return createBase64DataUrl(content.mimeType ?? DEFAULT_IMAGE_MIME_TYPE, content.data);
		}

		if (content.type === MCPContentType.RESOURCE && content.resource) {
			const resource = content.resource;

			if (resource.text) return resource.text;
			if (resource.blob) return resource.blob;

			return JSON.stringify(resource);
		}

		if (content.data && content.mimeType) {
			return createBase64DataUrl(content.mimeType, content.data);
		}

		return JSON.stringify(content);
	}

	/**
	 *
	 *
	 * Completions Operations
	 *
	 *
	 */

	/**
	 * Request completion suggestions from a server.
	 * Used for autocompleting prompt arguments or resource URI templates.
	 *
	 * @param connection - The MCP connection to use
	 * @param ref - Reference to the prompt or resource template
	 * @param argument - The argument being completed (name and current value)
	 * @returns Completion result with suggested values
	 */
	static async complete(
		connection: MCPConnection,
		ref: { type: MCPRefType.PROMPT; name: string } | { type: MCPRefType.RESOURCE; uri: string },
		argument: { name: string; value: string }
	): Promise<{ values: string[]; total?: number; hasMore?: boolean } | null> {
		try {
			const result = await connection.client.complete({
				ref,
				argument
			});

			return result.completion;
		} catch (error) {
			console.error(`[MCPService] Failed to get completions:`, error);

			return null;
		}
	}

	/**
	 *
	 *
	 * Resources Operations
	 *
	 *
	 */

	/**
	 * List resources from a connection.
	 * @param connection - The MCP connection to use
	 * @param cursor - Optional pagination cursor
	 * @returns Array of available resources and optional next cursor
	 */
	static async listResources(
		connection: MCPConnection,
		cursor?: string
	): Promise<{ resources: MCPResource[]; nextCursor?: string }> {
		try {
			const result = await connection.client.listResources(cursor ? { cursor } : undefined);

			return {
				resources: (result.resources ?? []) as MCPResource[],
				nextCursor: result.nextCursor
			};
		} catch (error) {
			if (this.isSessionExpiredError(error)) {
				throw error;
			}

			console.warn(`[MCPService][${connection.serverName}] Failed to list resources:`, error);

			return { resources: [] };
		}
	}

	/**
	 * List all resources from a connection (handles pagination automatically).
	 * @param connection - The MCP connection to use
	 * @returns Array of all available resources
	 */
	static async listAllResources(connection: MCPConnection): Promise<MCPResource[]> {
		const allResources: MCPResource[] = [];
		let cursor: string | undefined;

		do {
			const result = await this.listResources(connection, cursor);
			allResources.push(...result.resources);
			cursor = result.nextCursor;
		} while (cursor);

		return allResources;
	}

	/**
	 * List resource templates from a connection.
	 * @param connection - The MCP connection to use
	 * @param cursor - Optional pagination cursor
	 * @returns Array of available resource templates and optional next cursor
	 */
	static async listResourceTemplates(
		connection: MCPConnection,
		cursor?: string
	): Promise<{ resourceTemplates: MCPResourceTemplate[]; nextCursor?: string }> {
		try {
			const result = await connection.client.listResourceTemplates(cursor ? { cursor } : undefined);

			return {
				resourceTemplates: (result.resourceTemplates ?? []) as MCPResourceTemplate[],
				nextCursor: result.nextCursor
			};
		} catch (error) {
			if (this.isSessionExpiredError(error)) {
				throw error;
			}

			console.warn(
				`[MCPService][${connection.serverName}] Failed to list resource templates:`,
				error
			);

			return { resourceTemplates: [] };
		}
	}

	/**
	 * List all resource templates from a connection (handles pagination automatically).
	 * @param connection - The MCP connection to use
	 * @returns Array of all available resource templates
	 */
	static async listAllResourceTemplates(connection: MCPConnection): Promise<MCPResourceTemplate[]> {
		const allTemplates: MCPResourceTemplate[] = [];
		let cursor: string | undefined;

		do {
			const result = await this.listResourceTemplates(connection, cursor);
			allTemplates.push(...result.resourceTemplates);
			cursor = result.nextCursor;
		} while (cursor);

		return allTemplates;
	}

	/**
	 * Read the contents of a resource.
	 * @param connection - The MCP connection to use
	 * @param uri - The URI of the resource to read
	 * @returns The resource contents
	 */
	static async readResource(
		connection: MCPConnection,
		uri: string
	): Promise<MCPReadResourceResult> {
		try {
			const result = await connection.client.readResource({ uri });

			return {
				contents: (result.contents ?? []) as MCPResourceContent[],
				_meta: result._meta
			};
		} catch (error) {
			console.error(`[MCPService][${connection.serverName}] Failed to read resource:`, error);

			throw error;
		}
	}

	/**
	 * Subscribe to updates for a resource.
	 * The server will send notifications/resources/updated when the resource changes.
	 * @param connection - The MCP connection to use
	 * @param uri - The URI of the resource to subscribe to
	 */
	static async subscribeResource(connection: MCPConnection, uri: string): Promise<void> {
		try {
			await connection.client.subscribeResource({ uri });

			console.log(`[MCPService][${connection.serverName}] Subscribed to resource: ${uri}`);
		} catch (error) {
			console.error(
				`[MCPService][${connection.serverName}] Failed to subscribe to resource:`,
				error
			);

			throw error;
		}
	}

	/**
	 * Unsubscribe from updates for a resource.
	 * @param connection - The MCP connection to use
	 * @param uri - The URI of the resource to unsubscribe from
	 */
	static async unsubscribeResource(connection: MCPConnection, uri: string): Promise<void> {
		try {
			await connection.client.unsubscribeResource({ uri });

			if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
				console.log(`[MCPService][${connection.serverName}] Unsubscribed from resource: ${uri}`);
			}
		} catch (error) {
			console.error(
				`[MCPService][${connection.serverName}] Failed to unsubscribe from resource:`,
				error
			);

			throw error;
		}
	}

	/**
	 * Check if a connection supports resources.
	 * Per MCP spec: presence of the `resources` key (even as empty object `{}`) indicates support.
	 * Empty object means resources are supported but no sub-features (subscribe, listChanged).
	 *
	 * @param connection - The MCP connection to check
	 * @returns Whether the server declares the resources capability
	 */
	static supportsResources(connection: MCPConnection): boolean {
		// Per MCP spec: "Servers that support resources MUST declare the resources capability"
		// The presence of the key indicates support, even if it's an empty object
		return connection.serverCapabilities?.resources !== undefined;
	}

	/**
	 * Check if a connection supports resource subscriptions.
	 * @param connection - The MCP connection to check
	 * @returns Whether the server supports resource subscriptions
	 */
	static supportsResourceSubscriptions(connection: MCPConnection): boolean {
		return !!connection.serverCapabilities?.resources?.subscribe;
	}
}
