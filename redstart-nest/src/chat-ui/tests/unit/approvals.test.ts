import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY as LS_KEY } from '$lib/constants';

/**
 * The approval handshake and server-side "Always allow" (agent-runtime
 * Phase 2): chat-ui's half. The server's half is
 * redstart-nest/scripts/test-approvals.mjs.
 *
 * - permissionsStore keeps Nest's tools' grants on the server and every other
 *   tool's in localStorage, and imports the old localStorage set once.
 * - MCPToolOps.executeTool answers Nest's "needs approval" only for a call the
 *   person approved on the card, only for Nest's own server, and repeats the
 *   call once with the approval's id.
 */

const apiFetch = vi.fn();
const apiPost = vi.fn();
vi.mock('$lib/utils/api-fetch', () => ({
	apiFetch: (...a: unknown[]) => apiFetch(...a),
	apiPost: (...a: unknown[]) => apiPost(...a)
}));

const callTool = vi.fn();
vi.mock('$lib/services/mcp.service', () => ({
	MCPService: {
		callTool: (...a: unknown[]) => callTool(...a),
		isSessionExpiredError: () => false
	}
}));

function stubStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
	return store;
}

const NEST = 'mcp-redstart-nest:create_document';
const NEST_DELETE = 'mcp-redstart-nest:delete_file';
const LOCAL = 'builtin:read_file';

beforeEach(() => {
	vi.resetModules();
	apiFetch.mockReset();
	apiPost.mockReset();
	callTool.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('nestToolOfKey', () => {
	it('names the Nest tool behind a Nest key, and nothing else', async () => {
		stubStorage();
		const { nestToolOfKey } = await import('$lib/stores/permissions.svelte');
		expect(nestToolOfKey(NEST)).toBe('create_document');
		expect(nestToolOfKey('mcp-github:create_issue')).toBeNull();
		expect(nestToolOfKey(LOCAL)).toBeNull();
		expect(nestToolOfKey('mcp:delete_file')).toBeNull();
	});
});

describe('permissionsStore: Nest tools on the server, the rest in localStorage', () => {
	it('reads Nest grants from the server cache and client keys from localStorage', async () => {
		const storage = stubStorage({ [LS_KEY]: JSON.stringify([LOCAL]), [`${LS_KEY}.importedToNest`]: '1' });
		apiFetch.mockResolvedValueOnce({ grants: [{ id: 'g1', tool: 'create_document' }] });
		const { permissionsStore } = await import('$lib/stores/permissions.svelte');
		expect(permissionsStore.hasTool(NEST)).toBe(false);
		await permissionsStore.refresh();
		expect(permissionsStore.hasTool(NEST)).toBe(true);
		expect(permissionsStore.hasTool(LOCAL)).toBe(true);
		expect(apiPost).not.toHaveBeenCalled();
		expect(JSON.parse(storage.get(LS_KEY)!)).toEqual([LOCAL]);
	});

	it('"Always allow" on a Nest tool posts a grant; on a client tool it stays in localStorage', async () => {
		const storage = stubStorage({ [`${LS_KEY}.importedToNest`]: '1' });
		apiPost.mockResolvedValueOnce({ id: 'g2', tool: 'create_document' });
		const { permissionsStore } = await import('$lib/stores/permissions.svelte');
		permissionsStore.allowTool(NEST);
		await vi.waitFor(() => expect(permissionsStore.hasTool(NEST)).toBe(true));
		expect(apiPost).toHaveBeenCalledWith('/approvals/grants', { tool: 'create_document' });
		permissionsStore.allowTool(LOCAL);
		expect(JSON.parse(storage.get(LS_KEY)!)).toEqual([LOCAL]);
	});

	it('revoking a Nest tool deletes its grant on the server', async () => {
		stubStorage({ [`${LS_KEY}.importedToNest`]: '1' });
		apiFetch.mockResolvedValueOnce({ grants: [{ id: 'g1', tool: 'create_document' }] });
		const { permissionsStore } = await import('$lib/stores/permissions.svelte');
		await permissionsStore.refresh();
		apiFetch.mockResolvedValueOnce(null);
		permissionsStore.revokeTool(NEST);
		await vi.waitFor(() => expect(permissionsStore.hasTool(NEST)).toBe(false));
		expect(apiFetch).toHaveBeenLastCalledWith('/approvals/grants/g1', { method: 'DELETE' });
	});

	it('imports the old Nest keys once, then removes them from localStorage', async () => {
		const storage = stubStorage({ [LS_KEY]: JSON.stringify([NEST, NEST_DELETE, LOCAL]) });
		apiFetch
			.mockResolvedValueOnce({ grants: [] })
			.mockResolvedValueOnce({ grants: [{ id: 'g3', tool: 'create_document' }] });
		apiPost.mockResolvedValueOnce({ imported: ['create_document'], dropped: ['delete_file'] });
		const { permissionsStore } = await import('$lib/stores/permissions.svelte');
		await permissionsStore.refresh();
		expect(apiPost).toHaveBeenCalledWith('/approvals/grants/import', {
			tools: ['create_document', 'delete_file']
		});
		expect(JSON.parse(storage.get(LS_KEY)!)).toEqual([LOCAL]);
		expect(storage.get(`${LS_KEY}.importedToNest`)).toBe('1');
		expect(permissionsStore.hasTool(NEST)).toBe(true);
		expect(permissionsStore.hasTool(NEST_DELETE)).toBe(false);

		apiFetch.mockResolvedValueOnce({ grants: [{ id: 'g3', tool: 'create_document' }] });
		await permissionsStore.refresh();
		expect(apiPost).toHaveBeenCalledTimes(1);
	});

	it('a failed import keeps the keys and tries again next time', async () => {
		const storage = stubStorage({ [LS_KEY]: JSON.stringify([NEST]) });
		apiFetch.mockResolvedValue({ grants: [] });
		apiPost.mockRejectedValueOnce(new Error('offline'));
		const { permissionsStore } = await import('$lib/stores/permissions.svelte');
		await permissionsStore.refresh();
		expect(JSON.parse(storage.get(LS_KEY)!)).toEqual([NEST]);
		expect(storage.get(`${LS_KEY}.importedToNest`)).toBeUndefined();
	});
});

describe('MCPToolOps.executeTool: the approval handshake', () => {
	const PENDING = { id: 'ap-1', tool: 'delete_file', summary: 's', argsDigest: 'd', expiresAt: 9 };
	const needsApproval = { content: 'needs approval', isError: true, approval: PENDING };
	const done = { content: 'Deleted notes/a.md', isError: false, approval: null };

	async function ops(serverId = 'redstart-nest') {
		stubStorage();
		const { MCPToolOps } = await import('$lib/stores/mcp/mcp-tool-ops');
		const tools = { toolsIndex: new Map([['delete_file', serverId]]) };
		const conn = { connections: new Map([[serverId, { tools: [] }]]), reconnectServer: vi.fn() };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new MCPToolOps(tools as any, conn as any);
	}
	const call = { id: 'c1', function: { name: 'delete_file', arguments: '{"path":"notes/a.md"}' } };

	it('approved on the card: posts "once" and repeats the call once with the approval id', async () => {
		callTool.mockResolvedValueOnce(needsApproval).mockResolvedValueOnce(done);
		apiPost.mockResolvedValueOnce({ ok: true });
		const o = await ops();
		const r = await o.executeTool(call, undefined, { conversationId: 'conv-1', approvedByPerson: true });
		expect(r).toEqual(done);
		expect(apiPost).toHaveBeenCalledWith('/approvals/ap-1', { decision: 'once' });
		expect(callTool).toHaveBeenCalledTimes(2);
		expect(callTool.mock.calls[1][1]._meta).toEqual({
			'redstart/conversationId': 'conv-1',
			'redstart/approvalId': 'ap-1'
		});
		expect(callTool.mock.calls[1][1].arguments).toEqual({ path: 'notes/a.md' });
	});

	it('not approved on a card: never approves on anyone\'s behalf; the model reads the refusal', async () => {
		callTool.mockResolvedValueOnce(needsApproval);
		const o = await ops();
		const r = await o.executeTool(call, undefined, { conversationId: 'conv-1', approvedByPerson: false });
		expect(r).toEqual(needsApproval);
		expect(apiPost).not.toHaveBeenCalled();
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it('another MCP server\'s "approval" is not Nest\'s: nothing is posted', async () => {
		callTool.mockResolvedValueOnce(needsApproval);
		const o = await ops('third-party');
		await o.executeTool(call, undefined, { approvedByPerson: true });
		expect(apiPost).not.toHaveBeenCalled();
	});

	it('a decision Nest would not take returns the refusal, without a second call', async () => {
		callTool.mockResolvedValueOnce(needsApproval);
		apiPost.mockRejectedValueOnce(new Error('404'));
		const o = await ops();
		const r = await o.executeTool(call, undefined, { approvedByPerson: true });
		expect(r).toEqual(needsApproval);
		expect(callTool).toHaveBeenCalledTimes(1);
	});

	it('a call that needs no approval runs once, as before', async () => {
		callTool.mockResolvedValueOnce(done);
		const o = await ops();
		expect(await o.executeTool(call, undefined, { approvedByPerson: true })).toEqual(done);
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(apiPost).not.toHaveBeenCalled();
	});
});
