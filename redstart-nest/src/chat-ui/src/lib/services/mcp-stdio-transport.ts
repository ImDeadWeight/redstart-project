import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { TwigMcpApi } from '$lib/utils/twig';

/**
 * MCP SDK Transport over the Twig desktop IPC bridge.
 *
 * The Electron main process owns the child process and the newline framing:
 * every `onMessage` callback delivers exactly one complete JSON-RPC message
 * (never a partial line, never several), and `send` ships one serialized
 * message per call. This class is therefore just JSON (de)serialization plus
 * subscription lifecycle — all protocol logic stays in the SDK `Client`.
 */
export class IpcStdioTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;

	private unsubscribeMessage: (() => void) | null = null;
	private unsubscribeExit: (() => void) | null = null;
	private started = false;

	constructor(
		private readonly serverId: string,
		private readonly api: TwigMcpApi
	) {}

	async start(): Promise<void> {
		if (this.started) {
			throw new Error(`IpcStdioTransport for "${this.serverId}" already started`);
		}
		this.started = true;

		this.unsubscribeMessage = this.api.onMessage(this.serverId, (line) => {
			let message: JSONRPCMessage;
			try {
				message = JSON.parse(line) as JSONRPCMessage;
			} catch (error) {
				// A malformed line is surfaced as a transport error, never a crash —
				// the SDK client decides what to do with it.
				this.onerror?.(
					new Error(
						`Invalid JSON-RPC line from local server "${this.serverId}": ${
							error instanceof Error ? error.message : String(error)
						}`
					)
				);
				return;
			}
			this.onmessage?.(message);
		});

		this.unsubscribeExit = this.api.onExit(this.serverId, (info) => {
			if (info.error) {
				this.onerror?.(new Error(`Local server "${this.serverId}" failed: ${info.error}`));
			}
			// The manager may crash-restart the child, but a restarted server has
			// no memory of this session — treat exit as connection closed and let
			// the host reconnect through the normal path.
			this.onclose?.();
		});

		const result = await this.api.start(this.serverId);
		if (!result.ok) {
			this.detach();
			throw new Error(result.error ?? `Failed to start local server "${this.serverId}"`);
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		const result = await this.api.send(this.serverId, JSON.stringify(message));
		if (!result.ok) {
			throw new Error(result.error ?? `Local server "${this.serverId}" is not running`);
		}
	}

	async close(): Promise<void> {
		this.detach();
		await this.api.stop(this.serverId);
		this.onclose?.();
	}

	private detach(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeMessage = null;
		this.unsubscribeExit?.();
		this.unsubscribeExit = null;
	}
}
