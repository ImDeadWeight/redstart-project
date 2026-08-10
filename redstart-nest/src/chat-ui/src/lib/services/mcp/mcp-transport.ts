/**
 * mcp-transport - transport creation for MCP server connections
 *
 * Owns stdio / WebSocket / StreamableHTTP / SSE transport instantiation plus
 * proxy selection and the diagnostic-fetch wrapper. Does not know about
 * session lifecycle, capability exchange, or protocol operations.
 */

import { Client } from '@modelcontextprotocol/sdk/client';
import {
	StreamableHTTPClientTransport
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { IpcStdioTransport } from '$lib/services/mcp-stdio-transport';
import { twigMcpApi } from '$lib/utils/twig';
import {
	DEFAULT_MCP_CONFIG,
	MCP_PARTIAL_REDACT_HEADERS
} from '$lib/constants';
import {
	MCPConnectionPhase,
	MCPTransportType,
	MCPLogLevel
} from '$lib/enums';
import type { MCPServerConfig, MCPConnectionLog } from '$lib/types';
import {
	buildProxiedUrl,
	buildProxiedHeaders,
	getAuthHeaders,
	sanitizeHeaders
} from '$lib/utils';
import { createLog, createDiagnosticFetch } from './mcp-diagnostics';

export function createTransport(
	serverName: string,
	config: MCPServerConfig,
	onLog?: (log: MCPConnectionLog) => void
): {
	transport: Transport;
	type: MCPTransportType;
	stopPhaseLogging: () => void;
} {
	if (config.transport === MCPTransportType.STDIO) {
		const api = twigMcpApi();
		if (!api) {
			throw new Error(
				'Local stdio MCP servers are only available in the Redstart Twig desktop app'
			);
		}

		const serverId = config.stdioId ?? serverName;

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService] Creating stdio transport for local server "${serverId}"`);
		}

		onLog?.(
			createLog(
				MCPConnectionPhase.TRANSPORT_CREATING,
				`Starting local stdio server "${serverId}"`
			)
		);

		return {
			transport: new IpcStdioTransport(serverId, api),
			type: MCPTransportType.STDIO,
			stopPhaseLogging: () => {}
		};
	}

	if (!config.url) {
		throw new Error('MCP server configuration is missing url');
	}

	const useProxy = config.useProxy ?? false;
	const requestInit: RequestInit = {};

	if (config.headers) {
		requestInit.headers = config.useProxy ? buildProxiedHeaders(config.headers) : config.headers;
	}

	requestInit.headers = {
		...getAuthHeaders(),
		...(requestInit.headers as Record<string, string>)
	};

	if (config.credentials) {
		requestInit.credentials = config.credentials;
	}

	if (config.transport === MCPTransportType.WEBSOCKET) {
		if (useProxy) {
			throw new Error(
				'WebSocket transport is not supported when using CORS proxy. Use HTTP transport instead.'
			);
		}

		const url = new URL(config.url);

		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService] Creating WebSocket transport for ${url.href}`);
		}

		return {
			transport: new WebSocketClientTransport(url),
			type: MCPTransportType.WEBSOCKET,
			stopPhaseLogging: () => {}
		};
	}

	const url = useProxy ? buildProxiedUrl(config.url) : new URL(config.url);
	const { fetch: diagnosticFetch, disable: stopPhaseLogging } = createDiagnosticFetch(
		serverName,
		config,
		requestInit,
		url,
		useProxy,
		onLog
	);

	if (useProxy && import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
		console.log(`[MCPService] Using CORS proxy for ${config.url} -> ${url.href}`);
	}

	if (config.transport === MCPTransportType.SSE) {
		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService] Creating SSE transport for ${url.href}`);
		}

		return {
			transport: new SSEClientTransport(url, {
				requestInit,
				fetch: diagnosticFetch,
				eventSourceInit: { fetch: diagnosticFetch }
			}),
			type: MCPTransportType.SSE,
			stopPhaseLogging
		};
	}

	try {
		if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
			console.log(`[MCPService] Creating StreamableHTTP transport for ${url.href}`);
		}

		return {
			transport: new StreamableHTTPClientTransport(url, {
				requestInit,
				fetch: diagnosticFetch
			}),
			type: MCPTransportType.STREAMABLE_HTTP,
			stopPhaseLogging
		};
	} catch (httpError) {
		console.warn(`[MCPService] StreamableHTTP failed, trying SSE transport...`, httpError);

		try {
			return {
				transport: new SSEClientTransport(url, {
					requestInit,
					fetch: diagnosticFetch,
					eventSourceInit: { fetch: diagnosticFetch }
				}),
				type: MCPTransportType.SSE,
				stopPhaseLogging
			};
		} catch (sseError) {
			const httpMsg = httpError instanceof Error ? httpError.message : String(httpError);
			const sseMsg = sseError instanceof Error ? sseError.message : String(sseError);

			throw new Error(`Failed to create transport. StreamableHTTP: ${httpMsg}; SSE: ${sseMsg}`);
		}
	}
}
