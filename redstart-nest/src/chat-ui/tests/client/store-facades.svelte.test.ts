import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';

import { conversationsStore, isConversationsInitialized } from '$lib/stores/conversations.svelte';
import { mcpStore } from '$lib/stores/mcp.svelte';
import { HealthCheckStatus } from '$lib/enums';
import type { DatabaseConversation, DatabaseMessage, McpServerOverride } from '$lib/types/database';

import { observeReads } from './reactive-observer.svelte';

/**
 * store-facades (client half) - reactive forwarding through the facades
 *
 * The other half of item 4½; `tests/unit/store-facades.test.ts` pins the public
 * surface and value forwarding, and explains why. This file exists separately
 * because the `unit` project compiles runes for the server, where `$state` is a
 * plain field and `$effect` never runs — so the one failure mode §8 of the plan
 * says no gate can see is invisible there too.
 *
 * Here, in a real browser, `$state` is a proxy and effects run. That makes the
 * actual hazard testable: a facade getter that returns the right *value* but is
 * not wired into Svelte's dependency graph — a copied `$state`, or a getter
 * handing back `[...this.sub.items]` instead of the state itself. Both type-check,
 * both pass the unit half, and both show up in the dev app as a panel that never
 * updates.
 *
 * Each test asserts on the *number of effect runs*, not just the final value: one
 * entry is the initial read, a second means the mutation propagated. A single
 * entry is the defect.
 *
 * **When a seam lands**, add the state it moved to the table below.
 */

function conversation(id: string): DatabaseConversation {
	return { id, name: id, currNode: null, lastModified: 0 };
}

function message(id: string): DatabaseMessage {
	return { id } as unknown as DatabaseMessage;
}

/**
 * One row per piece of reactive state a facade forwards from a sub-store:
 * what a component reads, and how the sub-store that owns it changes.
 */
const FORWARDED: ReadonlyArray<{
	name: string;
	read: () => unknown;
	mutateSubStore: () => void;
}> = [
	{
		name: 'conversations',
		read: () => conversationsStore.conversations,
		mutateSubStore: () => {
			conversationsStore.core.conversations = [conversation('reactive-1')];
		}
	},
	{
		name: 'activeConversation',
		read: () => conversationsStore.activeConversation,
		mutateSubStore: () => {
			conversationsStore.core.activeConversation = conversation('reactive-2');
		}
	},
	{
		name: 'activeMessages',
		read: () => conversationsStore.activeMessages,
		mutateSubStore: () => {
			conversationsStore.core.activeMessages = [message('reactive-3')];
		}
	},
	{
		name: 'isInitialized',
		read: () => conversationsStore.isInitialized,
		mutateSubStore: () => {
			conversationsStore.core.isInitialized = !conversationsStore.core.isInitialized;
		}
	},
	{
		name: 'pendingMcpServerOverrides',
		read: () => conversationsStore.pendingMcpServerOverrides,
		mutateSubStore: () => {
			const next: McpServerOverride[] = [{ serverId: 'reactive-srv', enabled: true }];
			conversationsStore.mcpOverrides.pendingMcpServerOverrides = next;
		}
	}
];

describe('facade getters stay wired to the owning $state', () => {
	let saved: {
		conversations: DatabaseConversation[];
		activeConversation: DatabaseConversation | null;
		activeMessages: DatabaseMessage[];
		isInitialized: boolean;
		pendingMcpServerOverrides: McpServerOverride[];
	};

	beforeEach(() => {
		saved = {
			conversations: conversationsStore.core.conversations,
			activeConversation: conversationsStore.core.activeConversation,
			activeMessages: conversationsStore.core.activeMessages,
			isInitialized: conversationsStore.core.isInitialized,
			pendingMcpServerOverrides: conversationsStore.mcpOverrides.pendingMcpServerOverrides
		};
	});

	afterEach(() => {
		conversationsStore.core.conversations = saved.conversations;
		conversationsStore.core.activeConversation = saved.activeConversation;
		conversationsStore.core.activeMessages = saved.activeMessages;
		conversationsStore.core.isInitialized = saved.isInitialized;
		conversationsStore.mcpOverrides.pendingMcpServerOverrides = saved.pendingMcpServerOverrides;
	});

	it.each(FORWARDED)('$name re-runs an effect when its sub-store changes', (row) => {
		const { values, stop } = observeReads(row.read);

		expect(values, 'the effect never made its initial read').toHaveLength(1);

		row.mutateSubStore();
		flushSync();
		stop();

		expect(values, 'the value forwards but the reactivity does not').toHaveLength(2);
		expect(values[1]).not.toBe(values[0]);
	});

	// Writing through the facade setter must land in the same reactive state an
	// effect is subscribed to, not in a field shadowing it.
	it('re-runs an effect when the facade setter is used', () => {
		conversationsStore.core.isInitialized = false;

		const { values, stop } = observeReads(() => conversationsStore.isInitialized);

		conversationsStore.isInitialized = true;
		flushSync();
		stop();

		expect(values).toEqual([false, true]);
	});

	// Deep reactivity: the message operations mutate the array in place through
	// the getter. This only propagates while the getter returns the `$state`
	// proxy itself — a defensive copy would leave the effect asleep.
	it('re-runs an effect when a message is pushed through the facade', () => {
		conversationsStore.core.activeMessages = [];

		const { values, stop } = observeReads(() => conversationsStore.activeMessages.length);

		conversationsStore.addMessageToActive(message('pushed'));
		flushSync();
		stop();

		expect(values).toEqual([0, 1]);
		expect(conversationsStore.core.activeMessages).toHaveLength(1);
	});

	// The module-level convenience exports are what components actually call, so
	// they have to carry the reactivity too, not just the store property.
	it('re-runs an effect reading the module-level export', () => {
		conversationsStore.core.isInitialized = false;

		const { values, stop } = observeReads(() => isConversationsInitialized());

		conversationsStore.core.isInitialized = true;
		flushSync();
		stop();

		expect(values).toEqual([false, true]);
	});
});

describe('mcpStore stays wired to the owning $state', () => {
	afterEach(() => {
		mcpStore.clearAllHealthChecks();
	});

	// Health check state is `_healthChecks` on the facade today and moves into
	// `mcp/mcp-health.svelte.ts` in seam 5d. This assertion should keep passing
	// across that move; if it stops, the sub-store's state is not reaching the UI.
	it('re-runs an effect when a health check is recorded', () => {
		const { values, stop } = observeReads(() => mcpStore.hasHealthCheck('reactive-health'));

		mcpStore.updateHealthCheck('reactive-health', {
			status: HealthCheckStatus.ERROR,
			message: 'characterization',
			logs: []
		});
		flushSync();
		stop();

		expect(values).toEqual([false, true]);
	});

	it('re-runs an effect when health checks are cleared', () => {
		mcpStore.updateHealthCheck('reactive-health', {
			status: HealthCheckStatus.ERROR,
			message: 'characterization',
			logs: []
		});

		const { values, stop } = observeReads(() => mcpStore.hasHealthCheck('reactive-health'));

		mcpStore.clearAllHealthChecks();
		flushSync();
		stop();

		expect(values).toEqual([true, false]);
	});
});
