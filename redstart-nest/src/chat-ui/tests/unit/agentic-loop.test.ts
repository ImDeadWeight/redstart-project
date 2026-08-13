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
			async (_messages: unknown, opts: Record<string, (c: string) => void>) => {
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

		const [content] = rec.callbacks.onAssistantTurnComplete.mock.calls[0] as string[];
		expect(content).toBe('partial ');
	});

	// The same catch block, the other branch: when the failure is an abort the
	// loop returns instead of rethrowing, because the user asked for it and there
	// is no error to report. Ordering is identical; the exit is not.
	it('saves and returns without rethrowing when the stream aborts', async () => {
		const controller = new AbortController();
		sendMessage.mockImplementation(
			async (_messages: unknown, opts: Record<string, (c: string) => void>) => {
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
		const [content] = rec.callbacks.onAssistantTurnComplete.mock.calls[0] as string[];
		expect(content).toBe('half an answer');
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
});
