import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/api-headers', () => ({
	getAuthHeaders: () => ({ Authorization: 'Bearer session-token' })
}));

import {
	buildMcpClientConfig,
	buildServerConfig,
	checkServerEnabled
} from '$lib/stores/mcp/mcp-config';
import type { MCPServerSettingsEntry } from '$lib/types';
import type { McpServerOverride } from '$lib/types/database';

/**
 * Guards the silent no-tools failure.
 *
 * A host-provisioned MCP server that is never enabled for the chat produces no
 * client config, so nothing connects, `toolsStore` stays empty, and the agentic
 * loop sends no `tools` field at all — the model then improvises instead of
 * calling a tool, with no error anywhere to explain it. These tests pin the
 * enablement contract that decides whether a server connects.
 */

const NEST_SERVER: MCPServerSettingsEntry = {
	id: 'redstart-http-127-0-0-1-19082-sse',
	enabled: true,
	url: 'http://127.0.0.1:19082/sse',
	name: 'Redstart Built-in',
	requestTimeoutSeconds: 30
};

function overrides(...entries: McpServerOverride[]): McpServerOverride[] {
	return entries;
}

describe('checkServerEnabled', () => {
	it('is off when the chat has no override', () => {
		expect(checkServerEnabled(NEST_SERVER, [])).toBe(false);
	});

	it('is on when the chat enables it', () => {
		const on = overrides({ serverId: NEST_SERVER.id, enabled: true });
		expect(checkServerEnabled(NEST_SERVER, on)).toBe(true);
	});

	it('is off when the chat explicitly disables it', () => {
		const off = overrides({ serverId: NEST_SERVER.id, enabled: false });
		expect(checkServerEnabled(NEST_SERVER, off)).toBe(false);
	});

	it('ignores an override belonging to a different server', () => {
		const other = overrides({ serverId: 'some-other-server', enabled: true });
		expect(checkServerEnabled(NEST_SERVER, other)).toBe(false);
	});
});

describe('buildMcpClientConfig', () => {
	const settings = { mcpServers: JSON.stringify([NEST_SERVER]) } as Parameters<
		typeof buildMcpClientConfig
	>[0];

	// This is the exact shape of the observed failure: a provisioned server, no
	// per-chat override, therefore no client and no tools reach the model.
	it('produces no client config when no server is enabled for the chat', () => {
		expect(buildMcpClientConfig(settings, [])).toBeUndefined();
	});

	it('produces a client config once the server is enabled for the chat', () => {
		const on = overrides({ serverId: NEST_SERVER.id, enabled: true });
		const built = buildMcpClientConfig(settings, on);
		expect(built).toBeDefined();
		expect(Object.keys(built!.servers)).toHaveLength(1);
	});

	it('produces no client config when there are no servers at all', () => {
		const empty = { mcpServers: JSON.stringify([]) } as Parameters<typeof buildMcpClientConfig>[0];
		const on = overrides({ serverId: NEST_SERVER.id, enabled: true });
		expect(buildMcpClientConfig(empty, on)).toBeUndefined();
	});
});

describe('auth headers on the MCP connection', () => {
	// The Nest MCP endpoint 401s without a token, so a provisioned server that
	// carries no Authorization header fails its handshake and shows as ERROR —
	// with no tools reaching the model.
	it('attaches the session token to a host-provisioned server', () => {
		const built = buildServerConfig(NEST_SERVER);
		expect(built?.headers?.Authorization).toBe('Bearer session-token');
	});

	// Security boundary: a third-party server the user added must never receive
	// this deployment's bearer token.
	it('never attaches the session token to a user-added server', () => {
		const thirdParty: MCPServerSettingsEntry = {
			id: 'user-added-1',
			enabled: true,
			url: 'https://example.com/mcp',
			name: 'Someone Else',
			requestTimeoutSeconds: 30
		};
		expect(buildServerConfig(thirdParty)?.headers).toBeUndefined();
	});

	it('lets an explicit custom header win over the session token', () => {
		const withHeader: MCPServerSettingsEntry = {
			...NEST_SERVER,
			headers: JSON.stringify({ Authorization: 'Bearer explicit-override' })
		};
		expect(buildServerConfig(withHeader)?.headers?.Authorization).toBe('Bearer explicit-override');
	});
});

/**
 * Resolution order for a conversation's effective override, mirroring
 * ConversationsStore.getMcpServerOverride: an explicit per-conversation choice
 * wins; otherwise the saved default applies. Kept as a pure re-implementation
 * because the store itself needs IndexedDB and navigation to instantiate.
 */
function resolveOverride(
	conversationOverrides: McpServerOverride[] | undefined,
	defaults: McpServerOverride[],
	serverId: string
): McpServerOverride | undefined {
	const own = conversationOverrides?.find((o) => o.serverId === serverId);
	if (own) return own;
	return defaults.find((o) => o.serverId === serverId);
}

describe('conversation override resolution', () => {
	const defaults = overrides({ serverId: NEST_SERVER.id, enabled: true });

	it('applies the seeded default to a conversation that never chose', () => {
		const resolved = resolveOverride(undefined, defaults, NEST_SERVER.id);
		expect(checkServerEnabled(NEST_SERVER, resolved ? [resolved] : [])).toBe(true);
	});

	it('applies the default to a conversation holding only unrelated choices', () => {
		const unrelated = overrides({ serverId: 'other', enabled: false });
		const resolved = resolveOverride(unrelated, defaults, NEST_SERVER.id);
		expect(checkServerEnabled(NEST_SERVER, resolved ? [resolved] : [])).toBe(true);
	});

	// The important guarantee: seeding a default must never silently re-enable a
	// server the user deliberately turned off in this conversation.
	it('never overrides an explicit per-conversation off', () => {
		const explicitOff = overrides({ serverId: NEST_SERVER.id, enabled: false });
		const resolved = resolveOverride(explicitOff, defaults, NEST_SERVER.id);
		expect(checkServerEnabled(NEST_SERVER, resolved ? [resolved] : [])).toBe(false);
	});

	it('stays off when no default has been seeded', () => {
		const resolved = resolveOverride(undefined, [], NEST_SERVER.id);
		expect(checkServerEnabled(NEST_SERVER, resolved ? [resolved] : [])).toBe(false);
	});
});
