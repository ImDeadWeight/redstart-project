import { describe, expect, it } from 'vitest';
import { ThinkTagRouter, routeThinkTags, type RoutedSegment } from '$lib/services/chat/think-tags';

/** Streams `chunks` through one router and joins what comes out, per channel. */
function stream(chunks: string[]): { content: string; reasoning: string; segments: RoutedSegment[] } {
	const router = new ThinkTagRouter();
	const segments = [...chunks.flatMap((c) => router.push(c)), ...router.flush()];
	return {
		segments,
		content: segments.filter((s) => s.kind === 'content').map((s) => s.text).join(''),
		reasoning: segments.filter((s) => s.kind === 'reasoning').map((s) => s.text).join('')
	};
}

/** Every way of splitting `text` into two chunks. */
function everySplit(text: string): string[][] {
	return Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]);
}

describe('ThinkTagRouter', () => {
	it('passes ordinary content through untouched', () => {
		expect(stream(['Hello ', 'world <b>bold</b> a < b'])).toMatchObject({
			content: 'Hello world <b>bold</b> a < b',
			reasoning: ''
		});
	});

	it('🔍 drops the stray closing tag from the real transcript, and the blank lines after it', () => {
		// "Sure, let's try it out!\n</think>" followed by a tool call.
		const out = stream(["Sure, let's try it out!\n", '</think>', '\n\n']);
		expect(out.content).toBe("Sure, let's try it out!\n");
		expect(out.content).not.toContain('</think>');
		expect(out.reasoning).toBe('');
	});

	it('🔍 a whole thinking block written in the answer goes to the reasoning channel', () => {
		const out = stream(['<think>\nweighing it up\n</think>\n\nThe answer is 4.']);
		expect(out.reasoning).toBe('\nweighing it up\n');
		expect(out.content).toBe('The answer is 4.');
	});

	it('🔍 a tag split at any point across chunks is still recognised', () => {
		const text = 'before</think>\n\nafter';
		for (const split of everySplit(text)) {
			const out = stream(split);
			expect(out.content, JSON.stringify(split)).toBe('beforeafter');
		}
		const block = 'x<thinking>hidden</thinking>y';
		for (const split of everySplit(block)) {
			const out = stream(split);
			expect(out.content, JSON.stringify(split)).toBe('xy');
			expect(out.reasoning, JSON.stringify(split)).toBe('hidden');
		}
	});

	it('🔍 tags inside a code fence are shown, not interpreted', () => {
		const text = 'The template ends with:\n```jinja\n{{- \'<think>\\n\' }}\n</think>\n```\nThat is all.';
		for (const split of everySplit(text)) {
			const out = stream(split);
			expect(out.content, JSON.stringify(split)).toBe(text);
			expect(out.reasoning).toBe('');
		}
	});

	it('tags in inline code are shown, not interpreted', () => {
		const text = 'Qwen closes thinking with `</think>` and opens it with `<think>`.';
		expect(stream([text]).content).toBe(text);
	});

	it('an unclosed thinking block is reasoning to the end, released by flush', () => {
		const router = new ThinkTagRouter();
		const live = router.push('ok <think>still going and the stream ends</thi');
		expect(live.filter((s) => s.kind === 'content').map((s) => s.text).join('')).toBe('ok ');
		const rest = router.flush();
		expect(rest.map((s) => s.kind)).toEqual(['reasoning']);
		expect(rest[0].text).toContain('</thi');
	});

	it('a held-back partial that turns out to be text is released intact', () => {
		expect(stream(['a </t', 'able>'])).toMatchObject({ content: 'a </table>', reasoning: '' });
		expect(stream(['ends with <'])).toMatchObject({ content: 'ends with <' });
	});

	it('segments come out in order, and adjacent ones of a kind within a push are merged', () => {
		const { segments } = stream(['one <think>a', 'b</think>two']);
		expect(segments.map((s) => s.kind)).toEqual(['content', 'reasoning', 'reasoning', 'content']);
		const router = new ThinkTagRouter();
		expect(router.push('one <think>ab</think>two</think> three')).toEqual([
			{ kind: 'content', text: 'one ' },
			{ kind: 'reasoning', text: 'ab' },
			{ kind: 'content', text: 'two three' }
		]);
	});
});

describe('routeThinkTags', () => {
	it('routes a complete string the same way', () => {
		expect(routeThinkTags('<think>plan</think>\n\nanswer</think>')).toEqual({
			content: 'answer',
			reasoning: 'plan'
		});
	});
});
