import { describe, expect, it, vi } from 'vitest';

import { handleStreamResponse } from '$lib/services/chat/chat-stream';

/**
 * chat-stream-error - a server error inside a streaming reply reaches the UI.
 *
 * llama-server reports a failure after the reply has started (for example
 * "Context size has been exceeded") as an SSE `data: {"error": ...}` event,
 * then closes the stream with no [DONE]. handleStreamResponse used to skip
 * that chunk, and since it only completes on [DONE], the reply just stopped:
 * no completion, no error, nothing on screen. Found through the agent bench,
 * 2026-11-11, whose reader (shared/agent-core/chat-stream.mjs) had the same gap.
 */

function sse(events: unknown[]): Response {
	const body = events
		.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
		.join('');
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('handleStreamResponse with a mid-stream error', () => {
	it('reports the server error through onError and rejects, after the partial text', async () => {
		const onChunk = vi.fn();
		const onComplete = vi.fn();
		const onError = vi.fn();
		const response = sse([
			{ choices: [{ delta: { content: 'Partial ' } }] },
			{ error: { code: 500, message: 'Context size has been exceeded.', type: 'server_error' } }
		]);

		await expect(handleStreamResponse(response, onChunk, onComplete, onError)).rejects.toThrow(
			'The server stopped this reply: Context size has been exceeded.'
		);
		expect(onChunk).toHaveBeenCalledWith('Partial ');
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0].message).toBe(
			'The server stopped this reply: Context size has been exceeded.'
		);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('a normal stream still completes, and a malformed chunk is still only skipped', async () => {
		const onComplete = vi.fn();
		const onError = vi.fn();
		const response = sse([{ choices: [{ delta: { content: 'Hi' } }] }, '{not json', '[DONE]']);

		await handleStreamResponse(response, undefined, onComplete, onError);
		expect(onError).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledWith('Hi', undefined, undefined, undefined);
	});
});
