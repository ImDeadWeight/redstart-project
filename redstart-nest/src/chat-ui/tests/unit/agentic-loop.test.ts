import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn();

vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		get sendMessage() {
			return sendMessage;
		}
	}
}));

const { agenticStore } = await import('$lib/stores/agentic.svelte');

/**
 * agentic-loop - the exit paths of executeAgenticLoop
 *
 * The characterization item 4½ never wrote. It covered `mcpStore` and
 * `conversationsStore`; `agenticStore` was left with none, and seams 7d and 7e
 * are the two that need it most.
 *
 * §4.5 states the guarantee this file exists to pin:
 *
 *   > Extracting agentic-turn must preserve `onAssistantTurnComplete` firing
 *   > *before* `onFlowComplete` on both the abort and error paths — losing that
 *   > ordering silently drops the user's partial response.
 *
 * That matters because 7d and 7e are not move-and-delegate seams. Between them
 * they lift nine `return`s out of the loop body, and a function cannot return
 * from its caller: each one becomes a sentinel the loop has to interpret. Get
 * one wrong and the flow ends early, or never ends, or ends without saving what
 * the model had already produced. None of those are type errors.
 *
 * So the assertions here are deliberately about **call order and arity**, not
 * values. They are the contract the extraction has to keep.
 *
 * `executeAgenticLoop` is private; it is reached through a cast rather than
 * through runAgenticFlow, so the test drives the loop itself and not the
 * settings, tools and MCP guards wrapped around it. Everything the loop needs
 * is a parameter — that is what makes this possible at all.
 */

type Loop = (params: Record<string, unknown>) => Promise<void>;

/** Records which callbacks fired, in order. Values are asserted separately. */
function recorder() {
	const calls: string[] = [];
	const track =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push(name);
			return args.length >= 0 ? undefined : undefined;
		};

	return {
		calls,
		callbacks: {
			onChunk: track('onChunk'),
			onReasoningChunk: track('onReasoningChunk'),
			onToolCallsStreaming: track('onToolCallsStreaming'),
			onAttachments: track('onAttachments'),
			onModel: track('onModel'),
			onCompletionId: track('onCompletionId'),
			onAssistantTurnComplete: vi.fn(async (...args: unknown[]) => {
				calls.push('onAssistantTurnComplete');
				return args.length >= 0 ? undefined : undefined;
			}),
			createToolResultMessage: vi.fn(async () => {
				calls.push('createToolResultMessage');
			}),
			createAssistantMessage: vi.fn(async () => {
				calls.push('createAssistantMessage');
			}),
			onFlowComplete: vi.fn((...args: unknown[]) => {
				calls.push('onFlowComplete');
				return args.length >= 0 ? undefined : undefined;
			}),
			onTimings: track('onTimings'),
			onTurnComplete: track('onTurnComplete'),
			onError: track('onError')
		}
	};
}

function runLoop(overrides: Record<string, unknown> = {}) {
	const rec = recorder();
	const loop = (agenticStore as unknown as Record<string, Loop>).executeAgenticLoop.bind(
		agenticStore
	);

	return {
		rec,
		done: loop({
			conversationId: 'conv-loop',
			messages: [{ role: 'user', content: 'hello' }],
			options: {},
			tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
			agenticConfig: { enabled: true, maxTurns: 4 },
			callbacks: rec.callbacks,
			...overrides
		})
	};
}

/** The model answers with prose and calls nothing. */
function respondsWithText(text = 'the answer') {
	sendMessage.mockImplementation(async (_messages: unknown, opts: Record<string, () => void>) => {
		(opts.onChunk as (c: string) => void)?.(text);
		return undefined;
	});
}

beforeEach(() => {
	sendMessage.mockReset();
	agenticStore.session.clearSession('conv-loop');
	agenticStore.session.clearSteeringMessage('conv-loop');
});

afterEach(() => {
	agenticStore.session.clearSession('conv-loop');
	agenticStore.session.clearSteeringMessage('conv-loop');
});

/** Waits for the loop to park on a permission prompt, then answers it. */
async function answerPermission(decision: string, tries = 200) {
	for (let i = 0; i < tries; i++) {
		if (agenticStore.session.pendingPermissionRequest('conv-loop')) {
			agenticStore.session.resolvePermission('conv-loop', decision as never);
			return true;
		}
		await new Promise((r) => setTimeout(r, 0));
	}
	return false;
}

/** Turn 1 asks for a tool; every later turn answers with prose. */
function respondsWithToolCallThenText() {
	let turn = 0;
	sendMessage.mockImplementation(
		async (_messages: unknown, opts: Record<string, (s: string) => void>) => {
			turn += 1;
			if (turn === 1) {
				opts.onToolCallChunk?.(
					JSON.stringify([
						{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }
					])
				);
				return undefined;
			}
			opts.onChunk?.('done with tools');
			return undefined;
		}
	);
}

describe('executeAgenticLoop callback ordering', () => {
	// The terminal path: the model answered without calling a tool. This is the
	// ordinary end of almost every flow.
	it('saves the assistant turn before completing the flow', async () => {
		respondsWithText();

		const { rec, done } = runLoop();
		await done;

		expect(rec.calls).toContain('onAssistantTurnComplete');
		expect(rec.calls).toContain('onFlowComplete');
		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeLessThan(
			rec.calls.indexOf('onFlowComplete')
		);
	});

	it('completes the flow exactly once', async () => {
		respondsWithText();

		const { rec, done } = runLoop();
		await done;

		expect(rec.callbacks.onFlowComplete).toHaveBeenCalledTimes(1);
	});

	// §4.5's named hazard, and it turns out to be three guarantees, not one: on a
	// stream error the loop saves the partial turn, completes the flow, AND
	// rethrows so runAgenticFlow can raise the error dialog. A sentinel protocol
	// that swallowed the throw would leave the user with a half-answer and no
	// indication anything failed.
	it('saves partial output, completes, and rethrows when the stream errors', async () => {
		sendMessage.mockImplementation(
			async (_messages: unknown, opts: Record<string, (...a: unknown[]) => void>) => {
				opts.onTimings?.({ predicted_n: 7, predicted_ms: 70 });
				opts.onChunk?.('partial ');
				throw new Error('stream exploded');
			}
		);

		const { rec, done } = runLoop();

		await expect(done).rejects.toThrow('stream exploded');

		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeGreaterThanOrEqual(0);
		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeLessThan(
			rec.calls.indexOf('onFlowComplete')
		);

		const [content, , timings] = rec.callbacks.onAssistantTurnComplete.mock.calls[0] as [
			string,
			unknown,
			{ predicted_n?: number } | undefined
		];
		expect(content).toBe('partial ');
		// timings captured during the turn that then failed must not be lost — the
		// catch has to read the accumulator, not the pre-turn value.
		expect(timings?.predicted_n).toBe(7);
	});

	// The same catch block, the other branch: when the failure is an abort the
	// loop returns instead of rethrowing, because the user asked for it and there
	// is no error to report. Ordering is identical; the exit is not.
	it('saves and returns without rethrowing when the stream aborts', async () => {
		const controller = new AbortController();
		sendMessage.mockImplementation(
			async (_messages: unknown, opts: Record<string, (...a: unknown[]) => void>) => {
				opts.onTimings?.({ predicted_n: 5, predicted_ms: 50 });
				opts.onChunk?.('half an answer');
				controller.abort();
				throw new Error('aborted');
			}
		);

		const { rec, done } = runLoop({ signal: controller.signal });

		await expect(done).resolves.toBeUndefined();

		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeLessThan(
			rec.calls.indexOf('onFlowComplete')
		);
		const [content, , timings] = rec.callbacks.onAssistantTurnComplete.mock.calls[0] as [
			string,
			unknown,
			{ predicted_n?: number } | undefined
		];
		expect(content).toBe('half an answer');
		// same requirement as the error branch: read the accumulator, not the
		// pre-turn value, or timings measured during the aborted turn vanish
		expect(timings?.predicted_n).toBe(5);
	});

	// A user typed while the model was answering. The flow exits so chatStore can
	// re-send, but the turn in flight must not be thrown away first.
	//
	// The model must return *tool calls* here, or this proves nothing: with no
	// tool calls the loop reaches the terminal path anyway and fires the same two
	// callbacks in the same order, so disabling the steering check entirely would
	// still pass. Returning tool calls means only the steering exit can stop the
	// loop before it executes them. (Mutation-tested: the first version of this
	// test survived exactly that mutant.)
	it('exits before executing tools when a steering message arrives', async () => {
		sendMessage.mockImplementation(
			async (_messages: unknown, opts: Record<string, (s: string) => void>) => {
				opts.onChunk?.('interrupted answer');
				opts.onToolCallChunk?.(
					JSON.stringify([
						{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }
					])
				);
				agenticStore.session.injectSteeringMessage('conv-loop', 'wait, actually', undefined);
			}
		);

		const { rec, done } = runLoop();
		await done;

		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeLessThan(
			rec.calls.indexOf('onFlowComplete')
		);
		// the tool was never run, and the queued message is still there for chatStore
		expect(rec.callbacks.createToolResultMessage).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(agenticStore.session.hasPendingSteeringMessage('conv-loop')).toBe(true);
	});

	// An already-aborted signal must still end the flow rather than hang, and
	// must not invent an assistant turn that never streamed.
	it('completes the flow when the signal is already aborted', async () => {
		respondsWithText();

		const controller = new AbortController();
		controller.abort();

		const { rec, done } = runLoop({ signal: controller.signal });
		await done;

		expect(rec.callbacks.onFlowComplete).toHaveBeenCalled();
	});

	it('reports the model timings it captured to onFlowComplete', async () => {
		respondsWithText();

		const { rec, done } = runLoop();
		await done;

		// No tool ran, so buildFinalTimings passes the captured timings through
		// untouched — including `undefined` when the stub reported none.
		expect(rec.callbacks.onFlowComplete).toHaveBeenCalledWith(undefined);
	});

	// Phase 9 — seam 7d's territory, and the reason these two exist: the first
	// version of this file never reached tool execution at all (the steering
	// check exits earlier), so both sentinel mutants for 7d survived it.

	// 'done': tools ran, so the loop must start another LLM turn rather than
	// treating tool execution as the end of the flow.
	it('continues to another turn after running tool calls', async () => {
		respondsWithToolCallThenText();

		const { rec, done } = runLoop();
		await answerPermission('once');
		await done;

		expect(sendMessage).toHaveBeenCalledTimes(2);
		expect(rec.callbacks.onFlowComplete).toHaveBeenCalledTimes(1);
		expect(rec.calls.indexOf('onAssistantTurnComplete')).toBeLessThan(
			rec.calls.lastIndexOf('onFlowComplete')
		);
	});

	// 'stopped': aborting during tool execution ends the flow there. If the
	// caller ignored the sentinel it would run on and start a second turn.
	it('stops without another turn when aborted during tool execution', async () => {
		const controller = new AbortController();
		respondsWithToolCallThenText();

		const { rec, done } = runLoop({ signal: controller.signal });
		const parked = await answerPermission('once');
		controller.abort();
		await done;

		expect(parked).toBe(true);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(rec.callbacks.onFlowComplete).toHaveBeenCalledTimes(1);
	});

	// Seam 7e moved timings capture into the turn module, where it lands in the
	// caller's accumulator. The caller has to carry that back across turns, or a
	// flow whose *later* turn reports nothing loses what the earlier one measured.
	// (Mutation-tested: dropping that one line is invisible without this test.)
	it('carries timings captured in an earlier turn through to the end', async () => {
		let turn = 0;
		sendMessage.mockImplementation(
			async (_messages: unknown, opts: Record<string, (...a: unknown[]) => void>) => {
				turn += 1;
				if (turn === 1) {
					opts.onTimings?.({ predicted_n: 42, predicted_ms: 100 });
					opts.onToolCallChunk?.(
						JSON.stringify([
							{ id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } }
						])
					);
					return undefined;
				}
				// second turn reports no timings at all
				opts.onChunk?.('done');
				return undefined;
			}
		);

		const { rec, done } = runLoop();
		await answerPermission('once');
		await done;

		const [finalTimings] = rec.callbacks.onFlowComplete.mock.calls.at(-1) as [
			{ predicted_n?: number } | undefined
		];
		expect(finalTimings?.predicted_n).toBe(42);
	});
});
