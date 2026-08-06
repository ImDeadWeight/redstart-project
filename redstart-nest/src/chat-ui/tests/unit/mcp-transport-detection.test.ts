import { describe, expect, it } from 'vitest';
import { detectMcpTransportFromUrl } from '$lib/utils';
import { buildServerConfig } from '$lib/stores/mcp/mcp-config';
import { MCPTransportType } from '$lib/enums';
import type { MCPServerSettingsEntry } from '$lib/types';

/**
 * The two HTTP MCP transports are not interchangeable:
 *
 *  - two-endpoint SSE (MCP 2024-11-05): GET /sse opens the stream, POST
 *    /message?sessionId=… sends. This is what the Redstart built-in server
 *    implements.
 *  - Streamable HTTP: the same URL is POSTed to directly.
 *
 * Choosing the wrong one produces a bare 404 on connect and nothing else, so
 * the choice is pinned here.
 */

describe('detectMcpTransportFromUrl', () => {
	it('detects the two-endpoint SSE transport from a /sse path', () => {
		expect(detectMcpTransportFromUrl('http://127.0.0.1:19082/sse')).toBe(MCPTransportType.SSE);
	});

	it('detects SSE regardless of case or surrounding whitespace', () => {
		expect(detectMcpTransportFromUrl('  HTTP://127.0.0.1:19082/SSE  ')).toBe(MCPTransportType.SSE);
	});

	it('detects SSE when a query string follows the path', () => {
		expect(detectMcpTransportFromUrl('http://host:1/sse?token=abc')).toBe(MCPTransportType.SSE);
	});

	it('leaves other HTTP endpoints on streamable http', () => {
		expect(detectMcpTransportFromUrl('http://host:1/mcp')).toBe(MCPTransportType.STREAMABLE_HTTP);
		expect(detectMcpTransportFromUrl('https://example.com/api/v1')).toBe(
			MCPTransportType.STREAMABLE_HTTP
		);
	});

	it('does not mistake a path merely containing "sse" for the SSE endpoint', () => {
		expect(detectMcpTransportFromUrl('http://host:1/assets')).toBe(
			MCPTransportType.STREAMABLE_HTTP
		);
		expect(detectMcpTransportFromUrl('http://host:1/sse/messages')).toBe(
			MCPTransportType.STREAMABLE_HTTP
		);
	});

	it('still detects websocket urls', () => {
		expect(detectMcpTransportFromUrl('ws://host:1/sse')).toBe(MCPTransportType.WEBSOCKET);
		expect(detectMcpTransportFromUrl('wss://host:1/mcp')).toBe(MCPTransportType.WEBSOCKET);
	});
});

describe('buildServerConfig transport selection', () => {
	// The exact entry syncServersFromHost builds for the built-in server.
	it('marks the Redstart built-in server as SSE', () => {
		const entry: MCPServerSettingsEntry = {
			id: 'redstart-http-127-0-0-1-19082-sse',
			enabled: true,
			url: 'http://127.0.0.1:19082/sse',
			name: 'Redstart Built-in',
			requestTimeoutSeconds: 30
		};
		expect(buildServerConfig(entry)?.transport).toBe(MCPTransportType.SSE);
	});
});
