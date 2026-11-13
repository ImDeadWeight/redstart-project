import { describe, expect, it } from 'vitest';
import { createToolResultChain, filterByLeafNodeId } from '$lib/utils/branching';
import type { DatabaseMessage } from '$lib/types';

/**
 * tool-result-chain - every tool result of a reply stays on the path
 *
 * Found 2026-11-11 (agent-runtime Phase 1): chat-send stored each tool result
 * as a child of the assistant message, so a reply with several calls had
 * sibling results, and filterByLeafNodeId, which follows parents only, kept
 * the last. After a reload the earlier results were gone from the chat and
 * from the next request, which then carried calls with no result.
 *
 * Fixed twice over: new results are chained (createToolResultChain, used by
 * chat-send), and the walk restores results stored the old way.
 */

let ts = 0;
function msg(id: string, parent: string | null, role: string, extra: Partial<DatabaseMessage> = {}): DatabaseMessage {
	return {
		id,
		convId: 'c',
		parent,
		children: [],
		role,
		content: id,
		type: role === 'root' ? 'root' : 'text',
		timestamp: ++ts,
		toolCalls: '',
		...extra
	} as DatabaseMessage;
}

const calls = (...ids: string[]) =>
	JSON.stringify(ids.map((id) => ({ id, type: 'function', function: { name: 't', arguments: '{}' } })));

/** Wire up children from parents, as the stored tree has them. */
function tree(...messages: DatabaseMessage[]): DatabaseMessage[] {
	for (const m of messages) {
		const parent = messages.find((p) => p.id === m.parent);
		if (parent) parent.children.push(m.id);
	}
	return messages;
}

const ids = (path: readonly DatabaseMessage[]) => path.map((m) => m.id);

describe('filterByLeafNodeId with tool results stored as siblings (before 2026-11-11)', () => {
	it('restores every result of the reply, in order', () => {
		const all = tree(
			msg('root', null, 'root'),
			msg('u1', 'root', 'user'),
			msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2', 'c3') }),
			msg('t1', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t2', 'a1', 'tool', { toolCallId: 'c2' }),
			msg('t3', 'a1', 'tool', { toolCallId: 'c3' }),
			msg('a2', 't3', 'assistant')
		);
		expect(ids(filterByLeafNodeId(all, 'a2'))).toEqual(['u1', 'a1', 't1', 't2', 't3', 'a2']);
	});

	it('leaves a chained reply exactly as it was', () => {
		const all = tree(
			msg('root', null, 'root'),
			msg('u1', 'root', 'user'),
			msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2') }),
			msg('t1', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t2', 't1', 'tool', { toolCallId: 'c2' }),
			msg('a2', 't2', 'assistant')
		);
		expect(ids(filterByLeafNodeId(all, 'a2'))).toEqual(['u1', 'a1', 't1', 't2', 'a2']);
	});

	it('never pulls in a real branch: another reply, or results of a reply off the path', () => {
		const all = tree(
			msg('root', null, 'root'),
			msg('u1', 'root', 'user'),
			msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2') }),
			msg('t1', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t2', 'a1', 'tool', { toolCallId: 'c2' }),
			// A regenerated final answer: a sibling of a2, not a lost result.
			msg('a2', 't2', 'assistant'),
			msg('a2b', 't2', 'assistant'),
			// A regenerated first reply with its own results, not on this path.
			msg('a1b', 'u1', 'assistant', { toolCalls: calls('x1') }),
			msg('tx1', 'a1b', 'tool', { toolCallId: 'x1' }),
			// A tool message answering a call a1 never made.
			msg('stray', 'a1', 'tool', { toolCallId: 'zz' })
		);
		expect(ids(filterByLeafNodeId(all, 'a2b'))).toEqual(['u1', 'a1', 't1', 't2', 'a2b']);
	});

	it('one result per call: the one on the path, or the latest of the others', () => {
		const all = tree(
			msg('root', null, 'root'),
			msg('u1', 'root', 'user'),
			msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2') }),
			msg('t1', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t1old', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t1new', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t2', 'a1', 'tool', { toolCallId: 'c2' }),
			msg('t2dup', 'a1', 'tool', { toolCallId: 'c2' }),
			msg('a2', 't2', 'assistant')
		);
		// c2 is answered on the path by t2; c1 by the latest of its three.
		expect(ids(filterByLeafNodeId(all, 'a2'))).toEqual(['u1', 'a1', 't1new', 't2', 'a2']);
	});

	it('every call of a stored reply has a result on the repaired path', () => {
		const all = tree(
			msg('root', null, 'root'),
			msg('u1', 'root', 'user'),
			msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2', 'c3', 'c4') }),
			msg('t1', 'a1', 'tool', { toolCallId: 'c1' }),
			msg('t2', 'a1', 'tool', { toolCallId: 'c2' }),
			msg('t3', 'a1', 'tool', { toolCallId: 'c3' }),
			msg('t4', 'a1', 'tool', { toolCallId: 'c4' })
		);
		const path = filterByLeafNodeId(all, 't4');
		const answered = new Set(path.map((m) => m.toolCallId).filter(Boolean));
		expect([...answered].sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
	});
});

describe('createToolResultChain (what chat-send writes now)', () => {
	it('the first result goes under the assistant, each later one under the result before', () => {
		const chain = createToolResultChain();
		expect(chain.parentFor('a1')).toBe('a1');
		chain.advance('a1', 't1');
		expect(chain.parentFor('a1')).toBe('t1');
		chain.advance('a1', 't2');
		expect(chain.parentFor('a1')).toBe('t2');
	});

	it('a new assistant turn starts a new chain', () => {
		const chain = createToolResultChain();
		chain.advance('a1', 't1');
		expect(chain.parentFor('a2')).toBe('a2');
		chain.advance('a2', 't9');
		expect(chain.parentFor('a2')).toBe('t9');
	});

	it('a chain written this way survives the walk whole', () => {
		const chain = createToolResultChain();
		const all = [msg('root', null, 'root'), msg('u1', 'root', 'user'), msg('a1', 'u1', 'assistant', { toolCalls: calls('c1', 'c2', 'c3') })];
		for (const [id, call] of [['t1', 'c1'], ['t2', 'c2'], ['t3', 'c3']]) {
			all.push(msg(id, chain.parentFor('a1'), 'tool', { toolCallId: call }));
			chain.advance('a1', id);
		}
		all.push(msg('a2', 't3', 'assistant'));
		tree(...all);
		expect(ids(filterByLeafNodeId(all, 'a2'))).toEqual(['u1', 'a1', 't1', 't2', 't3', 'a2']);
	});
});
