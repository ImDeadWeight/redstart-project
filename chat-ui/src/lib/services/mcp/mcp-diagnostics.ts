/**
 * mcp-diagnostics - connection logging and diagnostic fetch instrumentation
 *
 * Owns the log-entry factory, request detail capture, error summarisation,
 * browser-context capture, connection-hint generation, and the diagnostic
 * fetch wrapper. Does not know about transport creation or session lifecycle.
 */

import type { MCPConnectionLog } from '$lib/types';
import {
	MCPConnectionPhase,
	MCPLogLevel
} from '$lib/enums';
import {
	MCP_PARTIAL_REDACT_HEADERS
} from '$lib/constants';
import type { MCPServerConfig } from '$lib/types';
import {
	sanitizeHeaders,
	getRequestBody,
	getRequestUrl,
	getRequestMethod,
	summarizeRequestBody,
	formatDiagnosticErrorMessage,
	extractJsonRpcMethods,
	type RequestBodySummary
} from '$lib/utils';

interface DiagnosticRequestDetails {
	url: string;
	method: string;
	credentials?: RequestCredentials;
	mode?: RequestMode;
	headers: Record<string, string>;
	body: RequestBodySummary;
	jsonRpcMethods?: string[];
}

export function createLog(
	phase: MCPConnectionPhase,
	message: string,
	level: MCPLogLevel = MCPLogLevel.INFO,
	details?: unknown
): MCPConnectionLog {
	return {
		timestamp: new Date(),
		phase,
		message,
		level,
		details
	};
}

export function createDiagnosticRequestDetails(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	baseInit: RequestInit,
	requestHeaders: Headers,
	extraRedactedHeaders?: Iterable<string>
): DiagnosticRequestDetails {
	const body = getRequestBody(input, init);
	const details: DiagnosticRequestDetails = {
		url: getRequestUrl(input),
		method: getRequestMethod(input, init, baseInit).toUpperCase(),
		credentials: init?.credentials ?? baseInit.credentials,
		mode: init?.mode ?? baseInit.mode,
		headers: sanitizeHeaders(requestHeaders, extraRedactedHeaders, MCP_PARTIAL_REDACT_HEADERS),
		body: summarizeRequestBody(body)
	};
	const jsonRpcMethods = extractJsonRpcMethods(body);

	if (jsonRpcMethods) {
		details.jsonRpcMethods = jsonRpcMethods;
	}

	return details;
}

export function summarizeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			cause:
				error.cause instanceof Error
					? { name: error.cause.name, message: error.cause.message }
					: error.cause,
			stack: error.stack?.split('\n').slice(0, 6).join('\n')
		};
	}

	return { value: String(error) };
}

export function getBrowserContext(
	targetUrl: URL,
	useProxy: boolean
): Record<string, unknown> | undefined {
	if (typeof window === 'undefined') {
		return undefined;
	}

	return {
		location: window.location.href,
		origin: window.location.origin,
		protocol: window.location.protocol,
		isSecureContext: window.isSecureContext,
		targetOrigin: targetUrl.origin,
		targetProtocol: targetUrl.protocol,
		sameOrigin: window.location.origin === targetUrl.origin,
		useProxy
	};
}

export function getConnectionHints(
	targetUrl: URL,
	config: MCPServerConfig,
	error: unknown
): string[] {
	const hints: string[] = [];
	const message = error instanceof Error ? error.message : String(error);
	const headerNames = Object.keys(config.headers ?? {});

	if (typeof window !== 'undefined') {
		if (
			window.location.protocol === 'https:' &&
			targetUrl.protocol === 'http:' &&
			!config.useProxy
		) {
			hints.push(
				'The page is running over HTTPS but the MCP server is HTTP. Browsers often block this as mixed content; enable the proxy or use HTTPS/WSS for the MCP server.'
			);
		}

		if (window.location.origin !== targetUrl.origin && !config.useProxy) {
			hints.push(
				'This is a cross-origin browser request. If the server is reachable from curl or Node but not from the browser, missing CORS headers are the most likely cause.'
			);
		}
	}

	if (headerNames.length > 0) {
		hints.push(
			`Custom request headers are configured (${headerNames.join(', ')}). That triggers a CORS preflight, so the server must allow OPTIONS and include the matching Access-Control-Allow-Headers response.`
		);
	}

	if (config.credentials && config.credentials !== 'omit') {
		hints.push(
			'Credentials are enabled for this connection. Cross-origin credentialed requests need Access-Control-Allow-Credentials: true and cannot use a wildcard Access-Control-Allow-Origin.'
		);
	}

	if (message.includes('Failed to fetch')) {
		hints.push(
			'"Failed to fetch" is a browser-level network failure. Common causes are CORS rejection, mixed-content blocking, certificate/TLS errors, DNS failures, or nothing listening on the target port.'
		);
	}

	return hints;
}

export function createDiagnosticFetch(
	serverName: string,
	config: MCPServerConfig,
	baseInit: RequestInit,
	targetUrl: URL,
	useProxy: boolean,
	onLog?: (log: MCPConnectionLog) => void
): {
	fetch: typeof fetch;
	disable: () => void;
} {
	let enabled = true;
	const logIfEnabled = (log: MCPConnectionLog) => {
		if (enabled) {
			onLog?.(log);
		}
	};

	return {
		fetch: async (input, init) => {
			const startedAt = performance.now();
			const requestHeaders = new Headers(baseInit.headers);

			if (typeof Request !== 'undefined' && input instanceof Request) {
				for (const [key, value] of input.headers.entries()) {
					requestHeaders.set(key, value);
				}
			}

			if (init?.headers) {
				for (const [key, value] of new Headers(init.headers).entries()) {
					requestHeaders.set(key, value);
				}
			}

			const request = createDiagnosticRequestDetails(
				input,
				init,
				baseInit,
				requestHeaders,
				Object.keys(config.headers ?? {})
			);
			const { method, url } = request;

			logIfEnabled(
				createLog(
					MCPConnectionPhase.INITIALIZING,
					`HTTP ${method} ${url}`,
					MCPLogLevel.INFO,
					{
						serverName,
						request
					}
				)
			);

			try {
				const response = await fetch(input, {
					...baseInit,
					...init,
					headers: requestHeaders
				});
				const durationMs = Math.round(performance.now() - startedAt);

				logIfEnabled(
					createLog(
						MCPConnectionPhase.INITIALIZING,
						`HTTP ${response.status} ${method} ${url} (${durationMs}ms)`,
						response.ok ? MCPLogLevel.INFO : MCPLogLevel.WARN,
						{
							response: {
								url,
								status: response.status,
								statusText: response.statusText,
								headers: sanitizeHeaders(response.headers, undefined, MCP_PARTIAL_REDACT_HEADERS),
								durationMs
							}
						}
					)
				);

				return response;
			} catch (error) {
				const durationMs = Math.round(performance.now() - startedAt);

				logIfEnabled(
					createLog(
						MCPConnectionPhase.ERROR,
						`HTTP ${method} ${url} failed: ${formatDiagnosticErrorMessage(error)}`,
						MCPLogLevel.ERROR,
						{
							serverName,
							request,
							error: summarizeError(error),
							browser: getBrowserContext(targetUrl, useProxy),
							hints: getConnectionHints(targetUrl, config, error),
							durationMs
						}
					)
				);

				throw error;
			}
		},
		disable: () => {
			enabled = false;
		}
	};
}
