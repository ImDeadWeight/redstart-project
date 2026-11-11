/**
 * The globals the loop core may use: the ones every host has (a browser,
 * Node, the daemon). redstart-nest/tsconfig.agent-core.json loads no DOM and
 * no Node types, so anything else the core reaches for is a type error there.
 * Widen this list only with a global all three hosts provide.
 *
 * Nothing imports this file; only the Nest-side typecheck includes it, so it
 * never meets chat-ui's DOM declarations.
 */

declare function setTimeout(handler: () => void, timeout?: number): unknown;

declare const performance: { now(): number };

interface AbortSignal {
	readonly aborted: boolean;
}

declare class DOMException extends Error {}
