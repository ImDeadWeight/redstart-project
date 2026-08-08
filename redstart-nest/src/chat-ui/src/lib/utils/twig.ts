import type { OpenAIToolDefinition } from '$lib/types';

/**
 * Bridge to the Redstart Twig (Windows) desktop shell.
 *
 * When the chat-ui runs inside Twig, its preload exposes `window.redstartTwigAPI`.
 * The `fs` surface lets the chat-ui execute `fs_*` tool calls against a folder on
 * the user's own machine — the "Claude Desktop" model — instead of running them
 * on the remote Redstart Nest server. On plain web / Android these helpers return
 * null and callers fall back to the normal server-side path.
 */

/** MCP-shaped result returned by the local fs tool executor. */
export interface TwigFsResult {
	isError?: boolean;
	content?: Array<{ type: string; text: string }>;
}

export interface TwigFsApi {
	/**
	 * OpenAI-shaped tool definitions, plus the class of each one
	 * ('read' | 'write' | 'destructive'). Empty until the user grants a folder.
	 *
	 * The array form is what older Twig builds return; the chat-ui ships
	 * independently of the desktop shell, so both shapes stay supported. The
	 * classes matter because these tools never travel over MCP — there is
	 * nowhere in an OpenAI function definition to put an annotation, and
	 * fs_delete_file must never become "always allowed".
	 */
	getTools: () => Promise<
		OpenAIToolDefinition[] | { tools: OpenAIToolDefinition[]; classes?: Record<string, string> }
	>;
	/** Execute an fs_* tool locally against the granted folder. */
	execute: (name: string, args: unknown) => Promise<TwigFsResult>;
	/** Prompt the user to grant a folder; resolves with the chosen root. */
	pickRoot: () => Promise<{ rootDir: string | null }>;
	/** Current granted root, or null if none. */
	getRoot: () => Promise<{ rootDir: string | null }>;

	/**
	 * Structured explorer API, mirroring Redstart Nest's /files/* shapes so one
	 * component can browse either machine. Optional throughout: an older Twig
	 * predates these channels, and the Files tab hides the local view when they
	 * are absent rather than calling something that does not exist.
	 *
	 * These resolve with `{ error }` instead of rejecting — the bridge cannot
	 * carry an Error across IPC — so callers convert. See file-browser.ts.
	 */
	browse?: (path: string) => Promise<{ path: string; entries: LocalFileEntry[]; error?: string }>;
	preview?: (path: string) => Promise<{ text: string; truncated: boolean; error?: string }>;
	mkdir?: (path: string) => Promise<{ path?: string; error?: string }>;
	move?: (from: string, to: string) => Promise<{ path?: string; error?: string }>;
	trash?: (
		path: string
	) => Promise<{ path?: string; recoverable?: string; hint?: string; error?: string }>;
}

/** One row in the local folder listing. Same shape the server's explorer uses. */
export interface LocalFileEntry {
	name: string;
	path: string;
	type: 'file' | 'folder';
	size: number | null;
	modified: string;
	previewable: boolean;
}

/** A local stdio MCP server entry as configured in twig-mcp.json. */
export interface TwigMcpServerEntry {
	id: string;
	command: string;
	args: string[];
	running: boolean;
}

export interface TwigMcpApi {
	/** List servers configured in the desktop-local twig-mcp.json. */
	list: () => Promise<TwigMcpServerEntry[]>;
	/** Spawn (or reuse) the child process for a configured server. */
	start: (id: string) => Promise<{ ok: boolean; error?: string }>;
	/** Stop a running server (no crash-restart follows a deliberate stop). */
	stop: (id: string) => Promise<{ ok: boolean }>;
	/** Send one serialized JSON-RPC message; main appends the newline frame. */
	send: (id: string, line: string) => Promise<{ ok: boolean; error?: string }>;
	/** Add or replace a server entry in twig-mcp.json. */
	add: (
		id: string,
		config: { command: string; args?: string[]; env?: Record<string, string> }
	) => Promise<{ ok: boolean; error?: string }>;
	/** Remove a server entry from twig-mcp.json (stops it if running). */
	remove: (id: string) => Promise<{ ok: boolean }>;
	/** Subscribe to whole JSON-RPC lines from the child; returns unsubscribe. */
	onMessage: (id: string, callback: (line: string) => void) => () => void;
	/** Subscribe to child exit events; returns unsubscribe. */
	onExit: (
		id: string,
		callback: (info: { code?: number | null; signal?: string | null; error?: string }) => void
	) => () => void;
}

export interface TwigShellApi {
	/**
	 * Keep the native window chrome in step with the app: report the theme and
	 * the background colour it is actually painting.
	 *
	 * `background` is optional so an older Twig shell (which ignores the second
	 * argument and uses its own hardcoded colour) still works — the two apps ship
	 * separately. Any CSS colour string; the shell parses it.
	 */
	setTheme: (theme: 'light' | 'dark' | 'system', background?: string) => Promise<void>;
}

interface TwigApi {
	fs?: TwigFsApi;
	mcp?: TwigMcpApi;
	shell?: TwigShellApi;
}

/** The Twig fs bridge, or null when not running inside the Twig desktop shell. */
export function twigFsApi(): TwigFsApi | null {
	if (typeof window === 'undefined') return null;
	const api = (window as Window & { redstartTwigAPI?: TwigApi }).redstartTwigAPI;
	return api?.fs ?? null;
}

/**
 * The Twig local-MCP bridge, or null outside the Twig desktop shell.
 * Null on phone/web is the feature gate: without the bridge the UI never
 * offers local servers and createTransport can never be asked for stdio.
 */
export function twigMcpApi(): TwigMcpApi | null {
	if (typeof window === 'undefined') return null;
	const api = (window as Window & { redstartTwigAPI?: TwigApi }).redstartTwigAPI;
	return api?.mcp ?? null;
}

/** The Twig window-chrome bridge, or null outside the Twig desktop shell. */
export function twigShellApi(): TwigShellApi | null {
	if (typeof window === 'undefined') return null;
	const api = (window as Window & { redstartTwigAPI?: TwigApi }).redstartTwigAPI;
	return api?.shell ?? null;
}
