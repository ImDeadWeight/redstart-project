import { afterEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_SYSTEM_PROMPT_CHARS,
	SYSTEM_PROMPT_CHARS_HEADER,
	chatOverheadTokens,
	recordRequestOverhead,
	resetContextOverhead
} from '$lib/services/chat/context-overhead';
import { compactionBudget } from '$lib/agent-core';

const reply = (chars?: number) =>
	({ headers: new Headers(chars === undefined ? {} : { [SYSTEM_PROMPT_CHARS_HEADER]: String(chars) }) }) as Pick<Response, 'headers'>;
const tool = (name: string) => ({ type: 'function', function: { name, description: 'x'.repeat(300), parameters: {} } });

describe('context overhead', () => {
	afterEach(() => resetContextOverhead());

	it('assumes a typical gateway prompt until the gateway says', () => {
		expect(chatOverheadTokens()).toBe(Math.ceil(DEFAULT_SYSTEM_PROMPT_CHARS / 3));
	});

	it("counts the gateway's stated prompt and the tools the client sent", () => {
		const tools = [tool('a'), tool('b')];
		recordRequestOverhead(tools, reply(4_500));
		expect(chatOverheadTokens()).toBe(Math.ceil((4_500 + JSON.stringify(tools).length) / 3));
	});

	it('a call without tools (a title, a summary) does not change what a chat send is budgeted on', () => {
		const tools = [tool('a')];
		recordRequestOverhead(tools, reply(4_500));
		const before = chatOverheadTokens();
		recordRequestOverhead(undefined, reply(1_200));
		expect(chatOverheadTokens()).toBe(before);
	});

	it('a reply without the header (another server) keeps the last known figure', () => {
		recordRequestOverhead([tool('a')], reply(4_500));
		const before = chatOverheadTokens();
		recordRequestOverhead([tool('a')], reply());
		expect(chatOverheadTokens()).toBe(before);
	});

	it('takes the overhead off the budget for the messages: the 4,096 profile that overflowed', () => {
		const tools = Array.from({ length: 12 }, (_, i) => tool(`t${i}`));
		recordRequestOverhead(tools, reply(4_500));
		const plain = compactionBudget(4_096, 512)!;
		const real = compactionBudget(4_096, 512, chatOverheadTokens())!;
		// Over 2,000 tokens the messages could not use, which the old budget counted as room.
		expect(plain.usable - real.usable).toBeGreaterThan(2_000);
	});
});
