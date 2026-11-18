import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * database-delete-url - deleting a chat must reach the real server
 *
 * Found by hand on 2026-11-13: deleting a chat from the sidebar in the web
 * chat-ui did nothing. deleteConversation parsed the relative API path against
 * a dummy origin ('http://x') and fetched the result, so in the web build
 * (no absolute server base) the DELETE went to http://x/conversations/<id>,
 * failed, and the store kept the row. It also skipped the auth header.
 */

const { DatabaseService } = await import('$lib/services/database.service');

beforeEach(() => {
	const ls = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => ls.get(k) ?? null,
		setItem: (k: string, v: string) => void ls.set(k, v),
		removeItem: (k: string) => void ls.delete(k)
	});
});

afterEach(() => vi.unstubAllGlobals());

function captureFetch() {
	const calls: { url: string; init?: RequestInit }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(null, { status: 204 });
		})
	);
	return calls;
}

describe('DatabaseService.deleteConversation', () => {
	it('sends a relative DELETE, not one to a dummy host', async () => {
		const calls = captureFetch();
		await DatabaseService.deleteConversation('abc');
		expect(calls).toHaveLength(1);
		expect(calls[0].init?.method).toBe('DELETE');
		expect(calls[0].url).not.toContain('http://x');
		expect(calls[0].url).toMatch(/\/conversations\/abc$/);
		const headers = calls[0].init?.headers as Record<string, string>;
		expect(headers['X-Redstart-Device-Id']).toBeTruthy();
	});

	it('carries deleteWithForks as a query parameter', async () => {
		const calls = captureFetch();
		await DatabaseService.deleteConversation('abc', { deleteWithForks: true });
		expect(calls[0].url).toMatch(/\/conversations\/abc\?deleteWithForks=true$/);
	});

	it('throws when the server refuses, so the row is not silently kept', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		await expect(DatabaseService.deleteConversation('abc')).rejects.toThrow(/500/);
	});
});
