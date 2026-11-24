import { describe, expect, it } from 'vitest';
import { handleNonStreamResponse, handleStreamResponse } from '$lib/services/chat/chat-stream';

/** A Response whose body is these SSE events, each delivered as its own chunk. */
function sse(deltas: Record<string, unknown>[]): Response {
	const encoder = new TextEncoder();
	const events = [
		...deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`),
		'data: [DONE]\n\n'
	];
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const e of events) controller.enqueue(encoder.encode(e));
			controller.close();
		}
	});
	return new Response(body);
}

describe('handleStreamResponse — thinking markup in the content', () => {
	it('🔍 the stray closing tag from the real transcript never reaches the answer', async () => {
		const chunks: string[] = [];
		let final = '';
		await handleStreamResponse(
			sse([
				{ reasoning_content: 'The user wants a test.' },
				{ content: "Sure, let's try it out!\n</th" },
				{ content: 'ink>\n\n' }
			]),
			(c) => chunks.push(c),
			(content) => {
				final = content;
			}
		);
		expect(chunks.join('')).not.toContain('</think>');
		expect(chunks.join('')).not.toContain('</th');
		expect(final).toBe("Sure, let's try it out!\n");
	});

	it('🔍 a thinking block written in the content streams as reasoning', async () => {
		const content: string[] = [];
		const reasoning: string[] = [];
		let finalReasoning: string | undefined;
		await handleStreamResponse(
			sse([{ content: '<think>plan' }, { content: ' it</think>\n\nAnswer.' }]),
			(c) => content.push(c),
			(_c, r) => {
				finalReasoning = r;
			},
			undefined,
			(r) => reasoning.push(r)
		);
		expect(content.join('')).toBe('Answer.');
		expect(reasoning.join('')).toBe('plan it');
		expect(finalReasoning).toBe('plan it');
	});
});

describe('handleNonStreamResponse — thinking markup in the content', () => {
	it('routes it the same way, appending to any reasoning the server sent', async () => {
		let got: { content: string; reasoning?: string } | null = null;
		const body = JSON.stringify({
			choices: [{ message: { content: '<think>more</think>\n\nTitle here', reasoning_content: 'first. ' } }]
		});
		const returned = await handleNonStreamResponse(new Response(body), (content, reasoning) => {
			got = { content, reasoning };
		});
		expect(returned).toBe('Title here');
		expect(got).toEqual({ content: 'Title here', reasoning: 'first. more' });
	});

	it('a reply that was all thinking is still a reply, not "no response"', async () => {
		const body = JSON.stringify({ choices: [{ message: { content: '<think>only this</think>' } }] });
		await expect(handleNonStreamResponse(new Response(body))).resolves.toBe('');
	});
});
