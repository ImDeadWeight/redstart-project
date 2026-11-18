import { base } from '$app/paths';
import { getJsonHeaders, getAuthHeaders } from './api-headers';
import { getServerBaseUrl } from './server-url';
import { UrlProtocol } from '$lib/enums';
import { ERROR_MESSAGES, HTTP_CODE_TO_STRING } from '$lib/constants/error';

/**
 * API Fetch Utilities
 *
 * Provides common fetch patterns used across services:
 * - Automatic JSON headers
 * - Error handling with proper error messages
 * - Base path resolution
 */

/**
 * Thrown by apiFetch/apiFetchWithParams on a non-ok HTTP response. Carries
 * the status code so callers can distinguish "not logged in" (401) from a
 * genuine connectivity failure — both used to surface as an identical
 * generic Error, which meant a 401 rendered as "server unavailable" instead
 * of ever triggering the login gate.
 */
export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/**
 * Central 401 handler, registered once by the auth store (see auth.svelte.ts).
 * Any authenticated request that comes back 401 — session expired, Redstart
 * Nest restarted (sessions are in-memory), or the account was revoked — drops
 * the session so the reactive login gate reappears, instead of every call site
 * reinventing this or surfacing a generic "server unavailable" error.
 *
 * 401 only: a 403 means "logged in but not permitted" (e.g. a non-admin
 * hitting an admin route) and must NOT clear the session. Registered via a
 * callback rather than importing authStore here, to avoid a circular import
 * (the auth store imports this module).
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
	onUnauthorized = handler;
}

/**
 * Resolves an API path to an absolute URL.
 * When running inside the Capacitor Android shell, prepends the user-configured
 * server base URL so that paths like '/v1/models' or './props' hit the correct
 * llama server instead of the WebView's local origin.
 */
export function resolveApiPath(path: string): string {
	const serverBase = getServerBaseUrl();
	if (serverBase) {
		// Normalise './foo' → '/foo' so concatenation produces a valid URL.
		const normalised = path.startsWith('./') ? path.slice(1) : path;
		return `${serverBase}${normalised}`;
	}
	return `${base}${path}`;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'headers'> {
	/**
	 * Use auth-only headers (no Content-Type).
	 * Default: false (uses JSON headers with Content-Type: application/json)
	 */
	authOnly?: boolean;
	/**
	 * Additional headers to merge with default headers.
	 */
	headers?: Record<string, string>;
}

/**
 * Fetch JSON data from an API endpoint with standard headers and error handling.
 *
 * @param path - API path (will be prefixed with base path)
 * @param options - Fetch options with additional authOnly flag
 * @returns Parsed JSON response
 * @throws Error with formatted message on failure
 *
 * @example
 * ```typescript
 * // GET request
 * const models = await apiFetch<ApiModelListResponse>('/v1/models');
 *
 * // POST request
 * const result = await apiFetch<ApiResponse>('/models/load', {
 *   method: 'POST',
 *   body: JSON.stringify({ model: 'gpt-4' })
 * });
 * ```
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
	const { authOnly = false, headers: customHeaders, ...fetchOptions } = options;

	const baseHeaders = authOnly ? getAuthHeaders() : getJsonHeaders();
	const headers = { ...baseHeaders, ...customHeaders };

	const url =
		path.startsWith(UrlProtocol.HTTP) || path.startsWith(UrlProtocol.HTTPS)
			? path
			: resolveApiPath(path);

	let response;
	try {
		response = await fetch(url, {
			...fetchOptions,
			headers
		});
	} catch (e) {
		throw new Error(beautifyNetworkError(e));
	}

	if (!response.ok) {
		if (response.status === 401) onUnauthorized?.();
		const errorMessage = await parseErrorMessage(response);
		throw new ApiError(errorMessage, response.status);
	}

	return response.json() as Promise<T>;
}

/**
 * Fetch with URL constructed from base URL and query parameters.
 *
 * @param basePath - Base API path
 * @param params - Query parameters to append
 * @param options - Fetch options
 * @returns Parsed JSON response
 *
 * @example
 * ```typescript
 * const props = await apiFetchWithParams<ApiProps>('./props', {
 *   model: 'gpt-4',
 *   autoload: 'false'
 * });
 * ```
 */
export async function apiFetchWithParams<T>(
	basePath: string,
	params: Record<string, string>,
	options: ApiFetchOptions = {}
): Promise<T> {
	const serverBase = getServerBaseUrl();
	const baseHref = serverBase ? `${serverBase}/` : window.location.href;
	const url = new URL(basePath, baseHref);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			url.searchParams.set(key, value);
		}
	}

	const { authOnly = false, headers: customHeaders, ...fetchOptions } = options;

	const baseHeaders = authOnly ? getAuthHeaders() : getJsonHeaders();
	const headers = { ...baseHeaders, ...customHeaders };

	let response;
	try {
		response = await fetch(url.toString(), {
			...fetchOptions,
			headers
		});
	} catch (e) {
		throw new Error(beautifyNetworkError(e));
	}

	if (!response.ok) {
		if (response.status === 401) onUnauthorized?.();
		const errorMessage = await parseErrorMessage(response);
		throw new ApiError(errorMessage, response.status);
	}

	return response.json() as Promise<T>;
}

/**
 * POST JSON data to an API endpoint.
 *
 * @param path - API path
 * @param body - Request body (will be JSON stringified)
 * @param options - Additional fetch options
 * @returns Parsed JSON response
 */
export async function apiPost<T, B = unknown>(
	path: string,
	body: B,
	options: ApiFetchOptions = {}
): Promise<T> {
	return apiFetch<T>(path, {
		method: 'POST',
		body: JSON.stringify(body),
		...options
	});
}

/**
 * Parse error message from a failed response.
 * Tries to extract error message from JSON body, falls back to status text.
 */
async function parseErrorMessage(response: Response): Promise<string> {
	try {
		const errorData = await response.json();
		if (errorData?.error?.message) {
			return errorData.error.message;
		}
		if (errorData?.error && typeof errorData.error === 'string') {
			return errorData.error;
		}
		if (errorData?.message) {
			return errorData.message;
		}
	} catch {
		// JSON parsing failed, use status text
	}

	const httpErrorStr = HTTP_CODE_TO_STRING[response.status];
	if (httpErrorStr) {
		return httpErrorStr;
	}

	return `${ERROR_MESSAGES.HTTP.GENERIC}: ${response.status} ${response.statusText}`;
}

/**
 * Converts a network issue into a human-readable message.
 * @param throwable - The throwable raised during fetch operation
 * @returns Error in an human-readable format
 */
function beautifyNetworkError(throwable: unknown): string {
	let message;
	if (throwable instanceof Error) {
		message = throwable.message;
		if (throwable.name === 'TypeError' && message.includes('fetch')) {
			return ERROR_MESSAGES.NETWORK.UNREACHABLE;
		}
	} else {
		message = String(throwable);
	}

	if (message.includes('ECONNREFUSED')) {
		return ERROR_MESSAGES.NETWORK.REFUSED;
	} else if (message.includes('ENOTFOUND')) {
		return ERROR_MESSAGES.NETWORK.NXDOMAIN;
	} else if (message.includes('ETIMEDOUT')) {
		return ERROR_MESSAGES.NETWORK.TIMEOUT;
	}

	return `${ERROR_MESSAGES.NETWORK.GENERIC} (${message})`;
}
