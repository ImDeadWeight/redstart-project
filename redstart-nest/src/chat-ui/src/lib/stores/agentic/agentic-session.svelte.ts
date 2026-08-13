/**
 * agentic-session - per-conversation agentic session state
 *
 * Owns the six maps behind a running flow: the sessions themselves, the pending
 * permission and continue prompts with their promise resolvers, and the queued
 * steering messages. Everything here is an accessor over those maps — there is
 * no loop logic, which is what makes this the one genuinely separable piece of
 * agentic.svelte.ts (§4.5).
 *
 * The reactive maps are SvelteMaps and the resolver maps deliberately are not:
 * a resolver is a function the UI never reads, and making it reactive would
 * schedule renders for nothing.
 */

import { SvelteMap } from 'svelte/reactivity';
import type { AgenticSession, SteeringMessage } from '$lib/types';
import type { ToolPermissionDecision } from '$lib/enums';

function createDefaultSession(): AgenticSession {
	return {
		isRunning: false,
		currentTurn: 0,
		totalToolCalls: 0,
		lastError: null,
		streamingToolCall: null,
		pendingPermissionRequest: null
	};
}

/**
 * Shared, frozen stand-in returned for a conversation that has no session yet.
 * Frozen so an accidental write surfaces immediately instead of silently
 * corrupting the value every session-less conversation reads.
 */
const EMPTY_SESSION: AgenticSession = Object.freeze(createDefaultSession());

export class AgenticSessionState {

	sessions = new SvelteMap<string, AgenticSession>();

	/** Dedicated reactive state for pending permission requests (ensures immediate UI updates) */
	pendingPermissions = new SvelteMap<
		string,
		{ toolName: string; serverLabel: string } | null
	>();

	/** Non-reactive: stores resolve functions for pending permission Promises */
	permissionResolvers = new Map<string, (decision: ToolPermissionDecision) => void>();

	/** Dedicated reactive state for pending continue requests (turn limit reached) */
	pendingContinueRequests = new SvelteMap<string, boolean>();

	/** Non-reactive: stores resolve functions for pending continue Promises */
	continueResolvers = new Map<string, (shouldContinue: boolean) => void>();

	/** Reactive: queued steering messages to inject between turns */
	steeringMessages = new SvelteMap<string, SteeringMessage>();

	get isAnyRunning(): boolean {
		for (const session of this.sessions.values()) {
			if (session.isRunning) return true;
		}
		return false;
	}

	/**
	 * Read a conversation's agentic session, or a shared empty one.
	 *
	 * Must not insert: this is called during render (deriving a message subtitle
	 * reads lastError, for example), and writing to the reactive map mid-render
	 * throws state_unsafe_mutation in Svelte 5 — an uncaught error that aborts
	 * the render pass. A session is created lazily by updateSession instead,
	 * which only ever runs from event handlers.
	 */
	getSession(conversationId: string): AgenticSession {
		return this.sessions.get(conversationId) ?? EMPTY_SESSION;
	}

	/**
	 * Widened from `private`: runAgenticFlow and executeAgenticLoop still call it,
	 * and they stay on the store. Same shape as seam 5b's widenings — the caller
	 * is now outside this class, so public is the correct visibility.
	 */
	updateSession(conversationId: string, update: Partial<AgenticSession>): void {
		const session = this.getSession(conversationId);
		this.sessions.set(conversationId, { ...session, ...update });
	}

	clearSession(conversationId: string): void {
		this.sessions.delete(conversationId);
	}

	getActiveSessions(): Array<{ conversationId: string; session: AgenticSession }> {
		const active: Array<{ conversationId: string; session: AgenticSession }> = [];
		for (const [conversationId, session] of this.sessions.entries()) {
			if (session.isRunning) active.push({ conversationId, session });
		}
		return active;
	}

	isRunning(conversationId: string): boolean {
		return this.getSession(conversationId).isRunning;
	}

	currentTurn(conversationId: string): number {
		return this.getSession(conversationId).currentTurn;
	}

	totalToolCalls(conversationId: string): number {
		return this.getSession(conversationId).totalToolCalls;
	}

	lastError(conversationId: string): Error | null {
		return this.getSession(conversationId).lastError;
	}

	streamingToolCall(conversationId: string): { name: string; arguments: string } | null {
		return this.getSession(conversationId).streamingToolCall;
	}

	pendingPermissionRequest(
		conversationId: string
	): { toolName: string; serverLabel: string } | null {
		return this.pendingPermissions.get(conversationId) ?? null;
	}

	pendingContinueRequest(conversationId: string): boolean {
		return this.pendingContinueRequests.get(conversationId) ?? false;
	}

	resolveContinue(conversationId: string, shouldContinue: boolean): void {
		const resolver = this.continueResolvers.get(conversationId);
		if (resolver) {
			this.continueResolvers.delete(conversationId);
			resolver(shouldContinue);
		}
	}

	resolvePermission(conversationId: string, decision: ToolPermissionDecision): void {
		const resolver = this.permissionResolvers.get(conversationId);
		if (resolver) {
			this.permissionResolvers.delete(conversationId);
			resolver(decision);
		}
	}

	clearError(conversationId: string): void {
		this.updateSession(conversationId, { lastError: null });
	}

	hasPendingSteeringMessage(conversationId: string): boolean {
		return this.steeringMessages.has(conversationId);
	}

	pendingSteeringMessageContent(conversationId: string): string | null {
		return this.steeringMessages.get(conversationId)?.content ?? null;
	}

	pendingSteeringMessageExtras(conversationId: string): DatabaseMessageExtra[] | undefined {
		return this.steeringMessages.get(conversationId)?.extras;
	}

	/**
	 * Queue a steering message. When the current agentic turn completes,
	 * the flow exits and the caller re-sends the message as a normal chat message.
	 */
	injectSteeringMessage(
		conversationId: string,
		content: string,
		extras?: DatabaseMessageExtra[]
	): void {
		this.steeringMessages.set(conversationId, { content, extras });
	}

	/**
	 * Clear the pending steering message without consuming it.
	 */
	clearSteeringMessage(conversationId: string): void {
		this.steeringMessages.delete(conversationId);
	}

	/**
	 * Consume and return the pending steering message for re-sending.
	 * Called by chatStore after the agentic flow exits.
	 */
	consumePendingSteeringMessage(conversationId: string): SteeringMessage | null {
		const msg = this.steeringMessages.get(conversationId);
		if (!msg) return null;
		this.steeringMessages.delete(conversationId);
		return msg;
	}
}
