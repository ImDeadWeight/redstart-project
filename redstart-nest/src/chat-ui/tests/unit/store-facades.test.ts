import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	conversationsStore,
	conversations,
	activeConversation,
	activeMessages,
	isConversationsInitialized
} from '$lib/stores/conversations.svelte';
import {
	mcpStore,
	mcpIsInitializing,
	mcpIsInitialized,
	mcpError,
	mcpIsEnabled,
	mcpIsProxyAvailable,
	mcpAvailableTools,
	mcpConnectedServerCount,
	mcpConnectedServerNames,
	mcpToolCount,
	mcpServerInstructions,
	mcpHasServerInstructions,
	mcpHasResourcesCapability,
	mcpServersWithResources,
	mcpResourceContext
} from '$lib/stores/mcp.svelte';
import { HealthCheckStatus, MCPConnectionPhase } from '$lib/enums';
import type { DatabaseConversation, DatabaseMessage, McpServerOverride } from '$lib/types/database';

/**
 * store-facades - characterization of the two facade targets
 *
 * Item 4½ of docs/notes/god-files-refactor-plan.md, and the stated prerequisite
 * for seams 5 and 6. `mcpStore` and `conversationsStore` are being decomposed
 * into sub-stores behind an unchanged public API, and until this file existed
 * nothing in the suite imported either one: a method that quietly stopped
 * existing, or a getter returning a copy of a sub-store's `$state` instead of
 * forwarding to it, would have reached the dev app before it reached a red test.
 *
 * Two things are pinned here and nothing more:
 *
 *   1. **The public surface** — every getter, method and module-level export a
 *      consumer can reach today, and whether the name resolves to an accessor or
 *      to a method.
 *   2. **Value forwarding** — a write to a sub-store's `$state` is visible
 *      through the facade, a write through the facade lands in the sub-store,
 *      and the getter hands back the state itself rather than a copy of it.
 *
 * These are not behaviour tests. Nothing here calls a method that touches
 * IndexedDB, the network, or a live MCP connection; the round-trips exercised
 * below (health checks, the flow counter, the message array) were picked because
 * they are pure in-memory state and are exactly the state seams 5b, 5d and 6a
 * are about to move.
 *
 * **What this file cannot cover.** The `unit` project compiles runes for the
 * server, where `$state` is a plain field and `$effect` never runs. That reactive
 * half — that Svelte's dependency graph still reaches the owning `$state`
 * through a facade getter — is checked in the browser, in
 * `tests/client/store-facades.svelte.test.ts`. Neither half covers recipe rule 4
 * on its own.
 *
 * **When a seam lands.** Add the newly extracted sub-store's forwarded state to
 * the forwarding tables below, and leave the surface lists alone. A name missing
 * from the surface is the defect; deleting it from the list to get to green is
 * how the seam-3 defects in Appendix B would have shipped silently.
 */

/** Every public getter on `mcpStore`. None of them is writable today. */
const MCP_GETTERS = [
	'isProxyAvailable',
	'isInitializing',
	'isInitialized',
	'error',
	'toolCount',
	'connectedServerCount',
	'connectedServerNames',
	'isEnabled',
	'availableTools'
] as const;

/** Every public method on `mcpStore`, in declaration order. */
const MCP_METHODS = [
	'updateHealthCheck',
	'getHealthCheckState',
	'hasHealthCheck',
	'clearHealthCheck',
	'clearAllHealthChecks',
	'clearError',
	'getServers',
	'getConnections',
	'getServerLabel',
	'getServerById',
	'getServerDisplayName',
	'getServerFavicon',
	'isAnyServerLoading',
	'getServersSorted',
	'syncServersFromHost',
	'syncLocalServersFromTwig',
	'addServer',
	'updateServer',
	'removeServer',
	'hasAvailableServers',
	'hasEnabledServers',
	'getEnabledServersForConversation',
	'ensureInitialized',
	'acquireConnection',
	'releaseConnection',
	'getActiveFlowCount',
	'shutdown',
	'getNestToolMeta',
	'getNestToolNamesForCapability',
	'getToolDefinitionsForLLM',
	'getToolNames',
	'hasTool',
	'getToolServer',
	'hasPromptsSupport',
	'hasPromptsCapability',
	'getAllPrompts',
	'getPrompt',
	'executeTool',
	'executeToolByName',
	'getPromptCompletions',
	'getResourceCompletions',
	'readResourceByUri',
	'runHealthChecksForServers',
	'getExistingConnection',
	'runHealthCheck',
	'getServersStatus',
	'getServerInstructions',
	'getHealthCheckInstructions',
	'hasServerInstructions',
	'hasResourcesCapability',
	'getServersWithResources',
	'fetchAllResources',
	'fetchServerResources',
	'readResource',
	'subscribeToResource',
	'unsubscribeFromResource',
	'attachResource',
	'removeResourceAttachment',
	'clearResourceAttachments',
	'getResourceContextForChat',
	'consumeResourceAttachmentsAsExtras'
] as const;

/** Public accessors on `conversationsStore`. All five are read *and* write. */
const CONVERSATIONS_ACCESSORS = [
	'conversations',
	'activeConversation',
	'activeMessages',
	'isInitialized',
	'pendingMcpServerOverrides'
] as const;

/**
 * Public data fields on `conversationsStore`. Unlike the accessors above, the
 * kind is not pinned: seam 6d moves the three `pending*` defaults into
 * `conversation-prefs`, at which point they legitimately become forwarding
 * accessors. What must not change is that a consumer can still reach them.
 */
const CONVERSATIONS_FIELDS = [
	'core',
	'mcpOverrides',
	'pendingThinkingEnabled',
	'pendingReasoningEffort',
	'pendingPromptMode',
	'titleUpdateConfirmationCallback'
] as const;

/** Every public method on `conversationsStore`, in declaration order. */
const CONVERSATIONS_METHODS = [
	'init',
	'initialize',
	'registerMessageUpdateCallback',
	'addMessageToActive',
	'updateMessageAtIndex',
	'findMessageIndex',
	'sliceActiveMessages',
	'removeMessageAtIndex',
	'setTitleUpdateConfirmationCallback',
	'loadConversations',
	'createConversation',
	'loadConversation',
	'clearActiveConversation',
	'deleteConversation',
	'deleteAll',
	'refreshActiveMessages',
	'getConversationMessages',
	'updateConversationName',
	'toggleConversationPin',
	'updateConversationTitleWithConfirmation',
	'updateConversationTimestamp',
	'updateCurrentNode',
	'navigateToSibling',
	'getMcpServerOverride',
	'getAllMcpServerOverrides',
	'isMcpServerEnabledForChat',
	'setMcpServerOverride',
	'seedMcpServerDefault',
	'toggleMcpServerForChat',
	'removeMcpServerOverride',
	'clearPendingMcpServerOverrides',
	'getThinkingEnabled',
	'setThinkingEnabled',
	'getReasoningEffort',
	'setReasoningEffort',
	'getPromptMode',
	'setPromptMode',
	'forkConversation',
	'generateConversationFilename',
	'downloadConversationFile',
	'downloadConversation',
	'importConversations',
	'importConversationsData'
] as const;

/**
 * The module-level convenience exports. §0.4 step 7 of the plan calls these part
 * of the public API — components call them directly, so a seam that leaves the
 * class intact but breaks one of these has still broken the UI.
 */
const MCP_EXPORT_MIRRORS: ReadonlyArray<[string, () => unknown, () => unknown]> = [
	['mcpIsInitializing', mcpIsInitializing, () => mcpStore.isInitializing],
	['mcpIsInitialized', mcpIsInitialized, () => mcpStore.isInitialized],
	['mcpError', mcpError, () => mcpStore.error],
	['mcpIsEnabled', mcpIsEnabled, () => mcpStore.isEnabled],
	['mcpIsProxyAvailable', mcpIsProxyAvailable, () => mcpStore.isProxyAvailable],
	['mcpAvailableTools', mcpAvailableTools, () => mcpStore.availableTools],
	['mcpConnectedServerCount', mcpConnectedServerCount, () => mcpStore.connectedServerCount],
	['mcpConnectedServerNames', mcpConnectedServerNames, () => mcpStore.connectedServerNames],
	['mcpToolCount', mcpToolCount, () => mcpStore.toolCount],
	['mcpServerInstructions', mcpServerInstructions, () => mcpStore.getServerInstructions()],
	['mcpHasServerInstructions', mcpHasServerInstructions, () => mcpStore.hasServerInstructions()],
	[
		'mcpHasResourcesCapability',
		mcpHasResourcesCapability,
		() => mcpStore.hasResourcesCapability()
	],
	['mcpServersWithResources', mcpServersWithResources, () => mcpStore.getServersWithResources()],
	['mcpResourceContext', mcpResourceContext, () => mcpStore.getResourceContextForChat()]
];

const CONVERSATIONS_EXPORT_MIRRORS: ReadonlyArray<[string, () => unknown, () => unknown]> = [
	['conversations', conversations, () => conversationsStore.conversations],
	['activeConversation', activeConversation, () => conversationsStore.activeConversation],
	['activeMessages', activeMessages, () => conversationsStore.activeMessages],
	[
		'isConversationsInitialized',
		isConversationsInitialized,
		() => conversationsStore.isInitialized
	]
];

/**
 * Walks the prototype chain for `name`, reporting whether the property was found
 * on the instance itself. `own` is the interesting part: under the server rune
 * compilation this project's `unit` tests use, a class `$state` field is a plain
 * own data property, while a forwarding getter is an accessor on the prototype.
 * A public name that turns into an own field is therefore the copied-state
 * mistake recipe rule 4 exists to prevent.
 */
function descriptorOf(
	target: object,
	name: string
): (PropertyDescriptor & { own: boolean }) | null {
	let cursor: object | null = target;

	while (cursor) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
		if (descriptor) return { ...descriptor, own: cursor === target };
		cursor = Object.getPrototypeOf(cursor);
	}

	return null;
}

function expectAccessor(store: object, name: string, options: { writable: boolean }): void {
	const descriptor = descriptorOf(store, name);

	expect(descriptor, `${name} is gone from the public surface`).not.toBeNull();
	expect(descriptor!.own, `${name} is an own field, not a forwarding accessor`).toBe(false);
	expect(typeof descriptor!.get, `${name} has no getter`).toBe('function');
	expect(typeof descriptor!.set, `${name} setter`).toBe(
		options.writable ? 'function' : 'undefined'
	);
}

function expectMethod(store: object, name: string): void {
	const descriptor = descriptorOf(store, name);

	expect(descriptor, `${name} is gone from the public surface`).not.toBeNull();
	expect(typeof descriptor!.value, `${name} is no longer a method`).toBe('function');
}

function conversation(overrides: Partial<DatabaseConversation> = {}): DatabaseConversation {
	return {
		id: 'conv-characterization',
		name: 'Characterization',
		currNode: null,
		lastModified: 0,
		...overrides
	};
}

// Only `id` matters to the array operations exercised below, so the fixture
// stays minimal rather than restating a shape no assertion reads.
function message(id: string): DatabaseMessage {
	return { id } as unknown as DatabaseMessage;
}

describe('mcpStore public surface', () => {
	it.each(MCP_GETTERS)('exposes %s as a read-only accessor', (name) => {
		expectAccessor(mcpStore, name, { writable: false });
	});

	it.each(MCP_METHODS)('exposes %s as a method', (name) => {
		expectMethod(mcpStore, name);
	});

	it('reads every getter without throwing', () => {
		for (const name of MCP_GETTERS) {
			expect(() => (mcpStore as unknown as Record<string, unknown>)[name]).not.toThrow();
		}
	});

	it.each(MCP_EXPORT_MIRRORS)('module export %s mirrors the store', (_name, exported, direct) => {
		expect(exported()).toEqual(direct());
	});
});

describe('conversationsStore public surface', () => {
	it.each(CONVERSATIONS_ACCESSORS)('exposes %s as a read-write accessor', (name) => {
		expectAccessor(conversationsStore, name, { writable: true });
	});

	it.each(CONVERSATIONS_METHODS)('exposes %s as a method', (name) => {
		expectMethod(conversationsStore, name);
	});

	it.each(CONVERSATIONS_FIELDS)('still exposes %s', (name) => {
		expect(descriptorOf(conversationsStore, name), `${name} is gone`).not.toBeNull();
	});

	it.each(CONVERSATIONS_EXPORT_MIRRORS)(
		'module export %s mirrors the store',
		(_name, exported, direct) => {
			expect(exported()).toBe(direct());
		}
	);
});

describe('conversationsStore forwards conversation-core state', () => {
	let saved: {
		conversations: DatabaseConversation[];
		activeConversation: DatabaseConversation | null;
		activeMessages: DatabaseMessage[];
		isInitialized: boolean;
	};

	beforeEach(() => {
		saved = {
			conversations: conversationsStore.core.conversations,
			activeConversation: conversationsStore.core.activeConversation,
			activeMessages: conversationsStore.core.activeMessages,
			isInitialized: conversationsStore.core.isInitialized
		};
	});

	afterEach(() => {
		conversationsStore.core.conversations = saved.conversations;
		conversationsStore.core.activeConversation = saved.activeConversation;
		conversationsStore.core.activeMessages = saved.activeMessages;
		conversationsStore.core.isInitialized = saved.isInitialized;
	});

	// `toBe`, not `toEqual`. A getter that returns a fresh copy
	// (`[...this.core.conversations]`) satisfies both the type and value
	// equality while silently breaking the in-place mutations below.
	it('reads the conversation list from the sub-store by reference', () => {
		const list = [conversation()];
		conversationsStore.core.conversations = list;

		expect(conversationsStore.conversations).toBe(list);
	});

	it('reads the active conversation from the sub-store', () => {
		const conv = conversation({ id: 'active-1' });
		conversationsStore.core.activeConversation = conv;

		expect(conversationsStore.activeConversation).toBe(conv);
	});

	it('reads the message path from the sub-store by reference', () => {
		const messages = [message('m1')];
		conversationsStore.core.activeMessages = messages;

		expect(conversationsStore.activeMessages).toBe(messages);
	});

	it('reads the init flag from the sub-store', () => {
		conversationsStore.core.isInitialized = false;
		expect(conversationsStore.isInitialized).toBe(false);

		conversationsStore.core.isInitialized = true;
		expect(conversationsStore.isInitialized).toBe(true);
	});

	it('writes every core field through to the sub-store', () => {
		const list = [conversation({ id: 'written' })];
		const conv = conversation({ id: 'written-active' });
		const messages = [message('written-message')];

		conversationsStore.conversations = list;
		conversationsStore.activeConversation = conv;
		conversationsStore.activeMessages = messages;
		conversationsStore.isInitialized = true;

		expect(conversationsStore.core.conversations).toBe(list);
		expect(conversationsStore.core.activeConversation).toBe(conv);
		expect(conversationsStore.core.activeMessages).toBe(messages);
		expect(conversationsStore.core.isInitialized).toBe(true);
	});

	// The facade's own message operations mutate `this.activeMessages` in place,
	// i.e. through the forwarding getter. Appendix C of the plan is explicit that
	// this only works while the getter hands back the state itself.
	it('mutates the sub-store array in place through the public message methods', () => {
		conversationsStore.core.activeMessages = [];

		conversationsStore.addMessageToActive(message('m1'));
		conversationsStore.addMessageToActive(message('m2'));

		expect(conversationsStore.core.activeMessages).toHaveLength(2);
		expect(conversationsStore.findMessageIndex('m2')).toBe(1);

		expect(conversationsStore.removeMessageAtIndex(0)?.id).toBe('m1');
		expect(conversationsStore.core.activeMessages).toHaveLength(1);
	});
});

describe('conversationsStore forwards conversation-mcp-overrides state', () => {
	let savedOverrides: McpServerOverride[];
	let savedActive: DatabaseConversation | null;

	beforeEach(() => {
		savedOverrides = conversationsStore.mcpOverrides.pendingMcpServerOverrides;
		savedActive = conversationsStore.core.activeConversation;
	});

	afterEach(() => {
		conversationsStore.mcpOverrides.pendingMcpServerOverrides = savedOverrides;
		conversationsStore.core.activeConversation = savedActive;
	});

	it('reads the pending overrides from the sub-store by reference', () => {
		const pending: McpServerOverride[] = [{ serverId: 'srv-1', enabled: true }];
		conversationsStore.mcpOverrides.pendingMcpServerOverrides = pending;

		expect(conversationsStore.pendingMcpServerOverrides).toBe(pending);
	});

	it('writes the pending overrides through to the sub-store', () => {
		const pending: McpServerOverride[] = [{ serverId: 'srv-2', enabled: false }];
		conversationsStore.pendingMcpServerOverrides = pending;

		expect(conversationsStore.mcpOverrides.pendingMcpServerOverrides).toBe(pending);
	});

	// The seam-2a injection contract: the sub-store resolves overrides against
	// the *same* core state the facade writes. If it were ever given its own
	// copy, this would read an override that no longer exists.
	it('resolves an override against the core state the facade wrote', () => {
		conversationsStore.activeConversation = conversation({
			mcpServerOverrides: [{ serverId: 'srv-3', enabled: true }]
		});

		expect(conversationsStore.getMcpServerOverride('srv-3')).toEqual({
			serverId: 'srv-3',
			enabled: true
		});
		expect(conversationsStore.isMcpServerEnabledForChat('srv-3')).toBe(true);
	});

	it('falls back to the pending defaults when the conversation never chose', () => {
		conversationsStore.activeConversation = conversation({ mcpServerOverrides: [] });
		conversationsStore.pendingMcpServerOverrides = [{ serverId: 'srv-4', enabled: true }];

		expect(conversationsStore.isMcpServerEnabledForChat('srv-4')).toBe(true);
	});
});

/**
 * Seam 5a0 moved the health-check record into `mcp/mcp-health.svelte.ts`; the
 * connection flow counter (`activeFlowCount`, seam 5b) is still facade-private.
 * These round-trips are the public-API view of both and predate the seam, so
 * they are the regression net for it. Each seam should extend this block with
 * the state it moved, and add the sub-store cross-check below.
 */
describe('mcpStore round-trips the state seam 5 will move', () => {
	afterEach(() => {
		mcpStore.clearAllHealthChecks();
	});

	it('round-trips a health check through the public API', () => {
		expect(mcpStore.hasHealthCheck('srv-1')).toBe(false);
		expect(mcpStore.getHealthCheckState('srv-1')).toEqual({ status: HealthCheckStatus.IDLE });

		mcpStore.updateHealthCheck('srv-1', {
			status: HealthCheckStatus.CONNECTING,
			phase: MCPConnectionPhase.INITIALIZING,
			logs: []
		});

		expect(mcpStore.hasHealthCheck('srv-1')).toBe(true);
		expect(mcpStore.getHealthCheckState('srv-1').status).toBe(HealthCheckStatus.CONNECTING);

		mcpStore.clearHealthCheck('srv-1');

		expect(mcpStore.hasHealthCheck('srv-1')).toBe(false);
	});

	it('reports an idle server as having no health check', () => {
		mcpStore.updateHealthCheck('srv-idle', { status: HealthCheckStatus.IDLE });

		expect(mcpStore.hasHealthCheck('srv-idle')).toBe(false);
	});

	it('clears every health check at once', () => {
		mcpStore.updateHealthCheck('srv-a', {
			status: HealthCheckStatus.ERROR,
			message: 'boom',
			logs: []
		});
		mcpStore.updateHealthCheck('srv-b', {
			status: HealthCheckStatus.ERROR,
			message: 'boom',
			logs: []
		});

		mcpStore.clearAllHealthChecks();

		expect(mcpStore.hasHealthCheck('srv-a')).toBe(false);
		expect(mcpStore.hasHealthCheck('srv-b')).toBe(false);
	});

	// `releaseConnection(false)` only decrements; it is the `true` argument that
	// would shut the pool down, and nothing here passes it.
	it('round-trips the connection flow counter', async () => {
		const before = mcpStore.getActiveFlowCount();

		mcpStore.acquireConnection();
		mcpStore.acquireConnection();

		expect(mcpStore.getActiveFlowCount()).toBe(before + 2);

		await mcpStore.releaseConnection();
		await mcpStore.releaseConnection();

		expect(mcpStore.getActiveFlowCount()).toBe(before);
	});

	it('clears the error through the public API', () => {
		mcpStore.clearError();

		expect(mcpStore.error).toBeNull();
	});
});

describe('mcpStore forwards mcp-health state, and mcp-servers reads it', () => {
	afterEach(() => {
		mcpStore.health.clearAllHealthChecks();
	});

	// The round-trips above all write *and* read through the facade, so a facade
	// that kept its own `_healthChecks` would satisfy every one of them. These
	// cross the boundary in one direction only, which is what distinguishes
	// forwarding from a second copy of the state.
	it('reads a health check the sub-store recorded', () => {
		mcpStore.health.updateHealthCheck('srv-sub', {
			status: HealthCheckStatus.ERROR,
			message: 'from the sub-store',
			logs: []
		});

		expect(mcpStore.hasHealthCheck('srv-sub')).toBe(true);
		expect(mcpStore.getHealthCheckState('srv-sub')).toBe(mcpStore.health.healthChecks['srv-sub']);
	});

	it('writes a health check through to the sub-store', () => {
		mcpStore.updateHealthCheck('srv-facade', {
			status: HealthCheckStatus.ERROR,
			message: 'from the facade',
			logs: []
		});

		expect(mcpStore.health.hasHealthCheck('srv-facade')).toBe(true);
	});

	it('clears through to the sub-store', () => {
		mcpStore.health.updateHealthCheck('srv-clear', {
			status: HealthCheckStatus.ERROR,
			message: 'boom',
			logs: []
		});

		mcpStore.clearHealthCheck('srv-clear');

		expect(mcpStore.health.hasHealthCheck('srv-clear')).toBe(false);
	});

	// The seam-5a injection contract: `mcp-servers` derives a server's display
	// name from the *same* health record the facade writes. Given its own copy it
	// would keep returning the URL fallback forever, which is also what a
	// perfectly healthy server looks like before its first check — the reason
	// this is asserted rather than left to the dev-app pass.
	it('labels a server from the health check the facade recorded', () => {
		const server = {
			id: 'srv-label',
			enabled: true,
			url: 'https://example.test/mcp',
			requestTimeoutSeconds: 30
		};

		expect(mcpStore.getServerLabel(server)).toBe('https://example.test/mcp');

		mcpStore.updateHealthCheck('srv-label', {
			status: HealthCheckStatus.SUCCESS,
			tools: [],
			serverInfo: { name: 'Example Server', version: '1.0.0' },
			logs: []
		});

		expect(mcpStore.getServerLabel(server)).toBe('Example Server');
	});

	// Read by the settings UI. It iterates the same record, so it is the one
	// health accessor that would keep working against a stale copy — for exactly
	// as long as nothing wrote to the other one.
	it('reports instructions the sub-store holds', () => {
		mcpStore.health.updateHealthCheck('srv-instructions', {
			status: HealthCheckStatus.SUCCESS,
			tools: [],
			instructions: 'be brief',
			logs: []
		});

		expect(mcpStore.getHealthCheckInstructions()).toEqual([
			{ serverId: 'srv-instructions', serverTitle: undefined, instructions: 'be brief' }
		]);
	});
});

describe('mcpStore forwards mcp-tools state', () => {
	afterEach(() => {
		mcpStore.tools.toolsIndex.clear();
		mcpStore.tools.toolCount = 0;
	});

	// The index is a plain Map that the connection and health layers mutate in
	// place from a dozen private call sites. A facade-local copy — its own Map,
	// or a getter returning `new Map(...)` — reads back value-identical through
	// every public accessor below, so nothing else here can see it. What it
	// breaks is the writes, in code no unit test can reach without a live
	// connection. So the absence of a second index is asserted structurally.
	it('keeps no index of its own', () => {
		expect(descriptorOf(mcpStore, 'toolsIndex'), 'the facade grew a second tool index').toBeNull();
	});

	it('reads the tool index the sub-store holds', () => {
		mcpStore.tools.toolsIndex.set('search', 'srv-search');

		expect(mcpStore.hasTool('search')).toBe(true);
		expect(mcpStore.getToolServer('search')).toBe('srv-search');
		expect(mcpStore.getToolNames()).toEqual(['search']);
		expect(mcpStore.availableTools).toEqual(['search']);
	});

	it('reports an unknown tool as absent', () => {
		expect(mcpStore.hasTool('nothing-here')).toBe(false);
		expect(mcpStore.getToolServer('nothing-here')).toBeUndefined();
	});

	it('reads the tool count from the sub-store', () => {
		mcpStore.tools.toolCount = 7;

		expect(mcpStore.toolCount).toBe(7);
		expect(mcpToolCount()).toBe(7);
	});
});

describe('mcpStore forwards mcp-connections state', () => {
	afterEach(() => {
		mcpStore.conn.connections.clear();
		mcpStore.conn.connectedServers = [];
		mcpStore.conn.error = null;
		mcpStore.conn.isInitializing = false;
	});

	// Same hazard as the tool index, and worse: `runHealthCheck` deletes from this
	// map and `promoteHealthCheckToConnection` sets into it, both from the facade,
	// both private. A facade-local map or a copying getter reads back identical
	// through every accessor below while dropping those writes on the floor.
	it('keeps no connection map of its own', () => {
		expect(descriptorOf(mcpStore, 'connections'), 'the facade grew a second pool').toBeNull();
		expect(descriptorOf(mcpStore, 'serverConfigs'), 'the facade grew a second config map').toBeNull();
	});

	it('hands back the sub-store pool itself, not a copy', () => {
		expect(mcpStore.getConnections()).toBe(mcpStore.conn.connections);
	});

	it('derives isInitialized from the sub-store pool', () => {
		expect(mcpStore.isInitialized).toBe(false);

		mcpStore.conn.connections.set('srv-1', {} as never);

		expect(mcpStore.isInitialized).toBe(true);
	});

	it('reads the connected server list from the sub-store by reference', () => {
		const names = ['srv-a', 'srv-b'];
		mcpStore.conn.connectedServers = names;

		expect(mcpStore.connectedServerNames).toBe(names);
		expect(mcpStore.connectedServerCount).toBe(2);
		expect(mcpConnectedServerNames()).toBe(names);
		expect(mcpConnectedServerCount()).toBe(2);
	});

	it('reads the init flag and the error from the sub-store', () => {
		mcpStore.conn.isInitializing = true;
		mcpStore.conn.error = 'All MCP server connections failed';

		expect(mcpStore.isInitializing).toBe(true);
		expect(mcpStore.error).toBe('All MCP server connections failed');
		expect(mcpIsInitializing()).toBe(true);
		expect(mcpError()).toBe('All MCP server connections failed');
	});

	it('clears the error through to the sub-store', () => {
		mcpStore.conn.error = 'boom';

		mcpStore.clearError();

		expect(mcpStore.conn.error).toBeNull();
	});
});

describe('conversationsStore callback registration contracts', () => {
	// Wired from +layout.svelte and called from chat-message-ops; seam 6c moves
	// the title concern out and must keep this contract.
	it('stores the title confirmation callback where the facade exposes it', () => {
		const previous = conversationsStore.titleUpdateConfirmationCallback;
		const callback = async () => true;

		conversationsStore.setTitleUpdateConfirmationCallback(callback);

		expect(conversationsStore.titleUpdateConfirmationCallback).toBe(callback);

		conversationsStore.titleUpdateConfirmationCallback = previous;
	});

	// Registered by chatStore to avoid a circular import. The callback itself is
	// private, so the contract worth pinning is that registration is accepted.
	it('accepts a message update callback', () => {
		expect(() => conversationsStore.registerMessageUpdateCallback(() => {})).not.toThrow();
	});
});
