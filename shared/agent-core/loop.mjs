/**
 * agent-core/loop — the agentic loop, hosted by whoever supplies the ports.
 *
 * One loop, three hosts (agent-runtime plan D1): chat-ui in the browser
 * (stores/agentic.svelte.ts builds the ports from its stores), the benchmark
 * under Node (scripts/agent-bench), and from Phase 3 the daemon's task
 * runtime. A new pause, nudge or exit path is written here and reaches every
 * host (D2). Moved from chat-ui's executeAgenticLoop without changing what it
 * does.
 *
 * No Svelte, no DOM, no Node built-ins: only globals every host has
 * (setTimeout, performance, AbortSignal).
 *
 * **The exit paths are the contract.** Every way out calls onFlowComplete
 * exactly once, and every way out after a turn streamed first saves that turn
 * through onAssistantTurnComplete (abort and stream error included: losing
 * that save silently drops the user's partial answer). A stream error is
 * rethrown after both, so the host can report it; an abort is not.
 */

import {
	buildFinalTimings,
	createAgenticTimings,
	createTurnStats,
	foldTurnTimings
} from './timings.mjs';
import { normalizeToolCalls, runToolCalls } from './tool-calls.mjs';
import { createApiToolCalls, parseToolCallsFromTurn } from './tool-call-parser.mjs';
import { completionNudge, endsInQuestion, openSteps, planTailNote } from './update-plan.mjs';

/** @typedef {import('./types').Timings} Timings */
/** @typedef {import('./types').TurnAccumulator} TurnAccumulator */

/**
 * @param {Timings | undefined} captured
 * @returns {TurnAccumulator}
 */
export function createTurnAccumulator(captured) {
	return { content: '', reasoning: '', toolCalls: [], timings: undefined, captured };
}

/** @returns {Promise<void>} */
function macrotask() {
	return new Promise((r) => setTimeout(r, 0));
}

/**
 * The model narrated a call instead of emitting one: recover it from the
 * answer, then the reasoning, when the host gives a fallback parser.
 *
 * @param {TurnAccumulator} acc
 * @param {any} ports
 */
function recoverNarratedCalls(acc, ports) {
	if (acc.toolCalls.length > 0) return;
	const parserConfig = ports.fallbackParser?.() ?? null;
	if (!parserConfig) return;
	const parsed = parseToolCallsFromTurn(acc.content, acc.reasoning, parserConfig);
	if (parsed.length > 0) acc.toolCalls = createApiToolCalls(parsed);
}

/**
 * The plan steps the completion check (update-plan.mjs) would nudge on, or
 * null: the model answered (no calls) with steps still open, the host has a
 * plan and has not turned the check off, it has not fired yet in this flow
 * (once, so it can never become a loop), and the reply does not end in a
 * question (then it waits for the person, who answers in the next message).
 *
 * @param {TurnAccumulator} acc
 * @param {any} ports
 * @param {boolean} nudged
 */
function planNudgeFor(acc, ports, nudged) {
	if (acc.toolCalls.length > 0 || !ports.plan || ports.plan.completionCheck === false || nudged) return null;
	if (endsInQuestion(acc.content)) return null;
	const steps = ports.plan.get();
	return steps && openSteps(steps).length > 0 ? steps : null;
}

/**
 * Run the flow to its end. Resolves when it is over (answered, stopped,
 * steered away, or refused at the turn limit); rejects only on a model stream
 * error, after saving the partial turn and completing the flow.
 *
 * @template A the host's attachment type (see AgentPorts)
 * @param {import('./types').AgentLoopParams<A>} params
 * @returns {Promise<void>}
 */
export async function runAgentLoop(params) {
	const { messages, maxTurns, ports, callbacks, signal } = params;
	const {
		onAssistantTurnComplete,
		createAssistantMessage,
		onFlowComplete,
		onTurnComplete
	} = callbacks;
	const yieldToHost = ports.yield ?? macrotask;

	/**
	 * Every way out but the tool path's (runToolCalls completes the flow
	 * itself when it stops): save the turn when there is one, then complete
	 * the flow, once. `answer` is the ordinary end, which also reports the
	 * turn, with the one timings object all three callbacks are given; the
	 * other exits build them for each callback, as they always did.
	 *
	 * @param {Timings | undefined} captured
	 * @param {{ acc?: TurnAccumulator, toolCalls?: any[], answer?: boolean }} [turn]
	 */
	const finishFlow = async (captured, { acc, toolCalls, answer = false } = {}) => {
		if (answer && acc) {
			const finalTimings = buildFinalTimings(captured, agenticTimings);
			await onAssistantTurnComplete?.(acc.content, acc.reasoning || undefined, finalTimings, undefined);
			if (finalTimings) onTurnComplete?.(finalTimings);
			onFlowComplete?.(finalTimings);
			return;
		}
		if (acc) {
			await onAssistantTurnComplete?.(
				acc.content,
				acc.reasoning || undefined,
				buildFinalTimings(captured, agenticTimings),
				toolCalls
			);
		}
		onFlowComplete?.(buildFinalTimings(captured, agenticTimings));
	};

	/** @type {Timings | undefined} */
	let capturedTimings;
	let totalToolCallCount = 0;
	const agenticTimings = createAgenticTimings();

	/** The completion check has fired in this flow (it fires at most once). */
	let nudged = false;
	/** @type {string | null} the nudge owed to the next request */
	let pendingNudge = null;

	let turn = 0;
	while (true) {
		if (turn >= maxTurns) {
			const shouldContinue = await ports.limit.askContinue(signal);

			// Let the host repaint (the browser hides the continue prompt here).
			await yieldToHost();

			if (!shouldContinue || signal?.aborted) return finishFlow(capturedTimings);

			// The user chose to go on: a fresh allowance of turns.
			turn = 0;
		}

		ports.progress?.({ currentTurn: turn + 1 });
		agenticTimings.turns = turn + 1;

		if (signal?.aborted) return finishFlow(capturedTimings);

		// The first turn's assistant message already exists (the host made it
		// before starting the flow); every later turn needs a new one.
		if (turn > 0 && createAssistantMessage) {
			await createAssistantMessage();
		}

		// One mutable object the model port fills as chunks arrive, so the catch
		// below still sees the partial answer if the stream throws. Copies read
		// out afterwards would be stale on exactly that path.
		const acc = createTurnAccumulator(capturedTimings);
		const turnStats = createTurnStats(turn + 1);

		// The plan's note rides at the tail of THIS request only (update-plan.mjs):
		// never pushed into `messages`, so the history, and the prompt prefix the
		// server has cached, stay as they were. A pending completion nudge takes
		// its place for the one turn it is owed.
		const tailNote = pendingNudge ?? (ports.plan ? planTailNote(ports.plan.get()) : null);
		pendingNudge = null;
		const sent = tailNote ? [...messages, { role: 'user', content: tailNote }] : messages;

		try {
			await ports.model.streamTurn({ acc, messages: sent, signal });
			// Inside the try because it ran inside the browser's turn before it
			// moved here.
			recoverNarratedCalls(acc, ports);
		} catch (error) {
			// Keep the partial output either way; on an error the host reports
			// it separately.
			const aborted = signal?.aborted;
			await finishFlow(acc.captured, { acc });
			if (aborted) return;
			throw error instanceof Error ? error : new Error('LLM stream error');
		}

		foldTurnTimings(acc.timings, agenticTimings, turnStats);

		// Carry this turn's captured timings to the next, which seeds a fresh
		// accumulator from this variable.
		capturedTimings = acc.captured;

		// A user message was queued during this turn: save the turn and exit, and
		// the host sends that message as an ordinary one.
		if (ports.steering.pending()) {
			ports.log?.('Steering message detected after turn, exiting agentic flow');
			return finishFlow(capturedTimings, {
				acc,
				toolCalls: acc.toolCalls.length > 0 ? normalizeToolCalls(acc.toolCalls) : undefined
			});
		}

		// The one completion check (planNudgeFor): save this turn, then give it
		// one more with the nudge at the tail.
		const planSteps = planNudgeFor(acc, ports, nudged);
		if (planSteps) {
			nudged = true;
			ports.log?.('Plan steps still open after an answer: one more turn');
			agenticTimings.perTurn?.push(turnStats);
			await onAssistantTurnComplete?.(
				acc.content,
				acc.reasoning || undefined,
				buildFinalTimings(capturedTimings, agenticTimings),
				undefined
			);
			const intermediateTimings = buildFinalTimings(capturedTimings, agenticTimings);
			if (intermediateTimings) onTurnComplete?.(intermediateTimings);
			messages.push({
				role: 'assistant',
				content: acc.content || undefined,
				reasoning_content: acc.reasoning || undefined
			});
			pendingNudge = completionNudge(planSteps);
			turn++;
			continue;
		}

		// No tool calls: this is the answer.
		if (acc.toolCalls.length === 0) {
			agenticTimings.perTurn?.push(turnStats);
			return finishFlow(capturedTimings, { acc, answer: true });
		}

		const calls = normalizeToolCalls(acc.toolCalls);
		if (calls.length === 0) return finishFlow(capturedTimings, { acc });

		totalToolCallCount += calls.length;
		ports.progress?.({ totalToolCalls: totalToolCallCount });

		await onAssistantTurnComplete?.(acc.content, acc.reasoning || undefined, acc.timings, calls);

		messages.push({
			role: 'assistant',
			content: acc.content || undefined,
			reasoning_content: acc.reasoning || undefined,
			tool_calls: calls
		});

		const toolOutcome = await runToolCalls({
			calls,
			messages,
			agenticTimings,
			turnStats,
			capturedTimings,
			ports,
			callbacks,
			signal
		});

		// 'stopped' means runToolCalls already called onFlowComplete; completing
		// again would fire it twice.
		if (toolOutcome === 'stopped') return;

		if (turnStats.toolCalls.length > 0) {
			agenticTimings.perTurn?.push(turnStats);

			const intermediateTimings = buildFinalTimings(capturedTimings, agenticTimings);
			if (intermediateTimings) onTurnComplete?.(intermediateTimings);
		}

		// Steering interrupted the tools: exit instead of starting another turn.
		if (ports.steering.pending()) {
			ports.log?.('Steering message detected after tool execution, exiting agentic flow');
			return finishFlow(capturedTimings);
		}

		turn++;
	}
}
