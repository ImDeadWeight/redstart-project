import { describe, expect, it, vi } from 'vitest';
import { IpcStdioTransport } from '$lib/services/mcp-stdio-transport';
import { buildServerConfig, mergeNestServers } from '$lib/stores/mcp/mcp-config';
import { MCPTransportType } from '$lib/enums';
import type { MCPServerSettingsEntry } from '$lib/types';
import type { TwigMcpApi } from '$lib/utils/twig';

/**
 * Mock of the Twig preload bridge. By contract the main process frames stdout
 * by newline, so onMessage always delivers exactly one complete JSON-RPC
 * message per callback — a message split across chunks is not possible here.
 */
function createMockBridge(overrides: Partial<TwigMcpApi> = {}) {
	const messageHandlers = new Map<string, (line: string) => void>();
	const exitHandlers = new Map<string, (info: { code?: number | null }) => void>();
	let messageSubscribers = 0;
	let exitSubscribers = 0;

	const api: TwigMcpApi = {
		list: vi.fn().mockResolvedValue([]),
		start: vi.fn().mockResolvedValue({ ok: true }),
		stop: vi.fn().mockResolvedValue({ ok: true }),
		send: vi.fn().mockResolvedValue({ ok: true }),
		add: vi.fn().mockResolvedValue({ ok: true }),
		remove: vi.fn().mockResolvedValue({ ok: true }),
		onMessage: vi.fn((id: string, cb: (line: string) => void) => {
			messageHandlers.set(id, cb);
			messageSubscribers++;
			return () => {
				messageHandlers.delete(id);
				messageSubscribers--;
			};
		}),
		onExit: vi.fn((id: string, cb: (info: { code?: number | null }) => void) => {
			exitHandlers.set(id, cb);
			exitSubscribers++;
			return () => {
				exitHandlers.delete(id);
				exitSubscribers--;
			};
		}),
		...overrides
	};

	return {
		api,
		emitLine: (id: string, line: string) => messageHandlers.get(id)?.(line),
		emitExit: (id: string, info: { code?: number | null } = { code: 1 }) =>
			exitHandlers.get(id)?.(info),
		subscriberCounts: () => ({ message: messageSubscribers, exit: exitSubscribers })
	};
}

describe('IpcStdioTransport', () => {
	it('delivers one parsed JSON-RPC message per line', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);
		const received: unknown[] = [];
		transport.onmessage = (msg) => received.push(msg);

		await transport.start();
		bridge.emitLine('srv', '{"jsonrpc":"2.0","id":1,"result":{}}');
		bridge.emitLine('srv', '{"jsonrpc":"2.0","method":"notifications/progress"}');

		expect(received).toEqual([
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', method: 'notifications/progress' }
		]);
	});

	it('surfaces a malformed JSON line as onerror without crashing', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);
		const errors: Error[] = [];
		const received: unknown[] = [];
		transport.onerror = (err) => errors.push(err);
		transport.onmessage = (msg) => received.push(msg);

		await transport.start();
		expect(() => bridge.emitLine('srv', 'this is not json')).not.toThrow();
		bridge.emitLine('srv', '{"jsonrpc":"2.0","id":2,"result":{}}');

		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain('Invalid JSON-RPC line');
		// The bad line must not break subsequent traffic
		expect(received).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
	});

	it('serializes one message per send() call', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);

		await transport.start();
		await transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

		expect(bridge.api.send).toHaveBeenCalledWith(
			'srv',
			JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
		);
	});

	it('throws from send() when the server is not running', async () => {
		const bridge = createMockBridge({
			send: vi.fn().mockResolvedValue({ ok: false, error: 'Server "srv" is not running' })
		});
		const transport = new IpcStdioTransport('srv', bridge.api);

		await transport.start();
		await expect(transport.send({ jsonrpc: '2.0', id: 4, method: 'ping' })).rejects.toThrow(
			'not running'
		);
	});

	it('close() unsubscribes both channels, stops the server, and fires onclose', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);
		const closed = vi.fn();
		transport.onclose = closed;

		await transport.start();
		expect(bridge.subscriberCounts()).toEqual({ message: 1, exit: 1 });

		await transport.close();
		expect(bridge.subscriberCounts()).toEqual({ message: 0, exit: 0 });
		expect(bridge.api.stop).toHaveBeenCalledWith('srv');
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('treats a child exit as connection closed', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);
		const closed = vi.fn();
		transport.onclose = closed;

		await transport.start();
		bridge.emitExit('srv', { code: 1 });

		expect(closed).toHaveBeenCalledTimes(1);
	});

	it('detaches listeners and throws when the main process cannot start the server', async () => {
		const bridge = createMockBridge({
			start: vi.fn().mockResolvedValue({ ok: false, error: 'No server "srv" in twig-mcp.json' })
		});
		const transport = new IpcStdioTransport('srv', bridge.api);

		await expect(transport.start()).rejects.toThrow('twig-mcp.json');
		expect(bridge.subscriberCounts()).toEqual({ message: 0, exit: 0 });
	});

	it('refuses a second start()', async () => {
		const bridge = createMockBridge();
		const transport = new IpcStdioTransport('srv', bridge.api);

		await transport.start();
		await expect(transport.start()).rejects.toThrow('already started');
	});
});

describe('buildServerConfig (stdio entries)', () => {
	const stdioEntry: MCPServerSettingsEntry = {
		id: 'filesystem',
		enabled: true,
		url: '',
		requestTimeoutSeconds: 30,
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-filesystem']
	};

	it('builds a stdio config without requiring a URL', () => {
		const config = buildServerConfig(stdioEntry);

		expect(config).toBeDefined();
		expect(config?.transport).toBe(MCPTransportType.STDIO);
		expect(config?.stdioId).toBe('filesystem');
		expect(config?.url).toBeUndefined();
		expect(config?.requestTimeoutMs).toBe(30_000);
	});

	it('still returns undefined for a network entry without a URL', () => {
		const config = buildServerConfig({
			id: 'broken',
			enabled: true,
			url: '',
			requestTimeoutSeconds: 30
		});

		expect(config).toBeUndefined();
	});
});

describe('mergeNestServers (sync clobber fix)', () => {
	const nestEntry = (url: string): MCPServerSettingsEntry => ({
		id: `redstart-${url.replace(/[^a-zA-Z0-9]+/g, '-')}`,
		enabled: true,
		url,
		requestTimeoutSeconds: 30
	});

	it('replaces Nest-sourced entries but keeps local ones', () => {
		const localStdio: MCPServerSettingsEntry = {
			id: 'filesystem',
			enabled: true,
			url: '',
			requestTimeoutSeconds: 30,
			transport: 'stdio',
			command: 'npx'
		};
		const userNetwork: MCPServerSettingsEntry = {
			id: 'my-server',
			enabled: false,
			url: 'https://example.com/mcp',
			requestTimeoutSeconds: 30
		};
		const staleNest = nestEntry('http://old-host:8080/mcp');
		const freshNest = nestEntry('http://new-host:8080/mcp');

		const merged = mergeNestServers([staleNest, localStdio, userNetwork], [freshNest]);

		expect(merged.map((s) => s.id)).toEqual([freshNest.id, localStdio.id, userNetwork.id]);
	});

	it('an empty Nest fetch clears Nest entries but never local ones', () => {
		const localStdio: MCPServerSettingsEntry = {
			id: 'filesystem',
			enabled: true,
			url: '',
			requestTimeoutSeconds: 30,
			transport: 'stdio',
			command: 'npx'
		};

		const merged = mergeNestServers([nestEntry('http://host:8080/mcp'), localStdio], []);

		expect(merged).toEqual([localStdio]);
	});
});
