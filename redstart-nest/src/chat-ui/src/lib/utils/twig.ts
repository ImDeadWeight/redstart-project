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
	/** OpenAI-shaped tool definitions; empty until the user grants a folder. */
	getTools: () => Promise<OpenAIToolDefinition[]>;
	/** Execute an fs_* tool locally against the granted folder. */
	execute: (name: string, args: unknown) => Promise<TwigFsResult>;
	/** Prompt the user to grant a folder; resolves with the chosen root. */
	pickRoot: () => Promise<{ rootDir: string | null }>;
	/** Current granted root, or null if none. */
	getRoot: () => Promise<{ rootDir: string | null }>;
}

interface TwigApi {
	fs?: TwigFsApi;
}

/** The Twig fs bridge, or null when not running inside the Twig desktop shell. */
export function twigFsApi(): TwigFsApi | null {
	if (typeof window === 'undefined') return null;
	const api = (window as Window & { redstartTwigAPI?: TwigApi }).redstartTwigAPI;
	return api?.fs ?? null;
}
