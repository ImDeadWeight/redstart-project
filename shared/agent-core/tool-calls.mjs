/**
 * agent-core/tool-calls — running one turn's tool calls.
 *
 * For each call the model asked for: check the abort signal, honour a steering
 * interrupt, ask the gate, dispatch through the host's executor, record
 * timings, let the host lift out attachments, and append the result to the
 * history the next turn sends. Moved here from chat-ui's agentic-tool-exec.ts;
 * the executors (local FS, built-in, sandbox, MCP), the permission card and
 * the vision parts stay in the host behind `ports`.
 *
 * **The contract is the subtle part.** This body once sat inline in the loop
 * and used `return` to end the whole flow, four times. A function cannot
 * return from its caller, so those become the sentinel this returns:
 *
 *   'stopped' - the flow is over. onFlowComplete has ALREADY been called here,
 *               on the same timings the inline code used. The caller must
 *               return immediately and must not complete the flow again.
 *   'done'    - carry on. Either every call ran, or a steering message cut the
 *               remaining ones short (the inline `break`, still a `break`).
 *               Either way the caller proceeds to its turn-stats block and its
 *               own post-loop steering check.
 *
 * The accumulators (agenticTimings, turnStats, messages) are mutated in place,
 * because the caller reads them afterwards. capturedTimings is read but never
 * reassigned here, so it is passed by value.
 *
 * Pinned by chat-ui's tests/unit/agentic-loop.test.ts (through the browser
 * host) and redstart-nest/scripts/test-agent-core.mjs (under plain Node).
 */

import { buildFinalTimings } from './timings.mjs';
import { ASK_USER_TOOL, formatAskAnswer, parseAskArguments } from './ask-user.mjs';
import { UPDATE_PLAN_TOOL, formatPlanResult, parsePlanArguments, samePlan } from './update-plan.mjs';

/** @typedef {import('./types').AgentToolCall} AgentToolCall */
/** @typedef {import('./types').RawToolCall} RawToolCall */
/** @typedef {import('./types').AgentMessage} AgentMessage */
/** @typedef {import('./types').AgentContentPart} AgentContentPart */
/** @typedef {import('./types').AgenticTimings} AgenticTimings */
/** @typedef {import('./types').TurnStats} TurnStats */
/** @typedef {import('./types').Timings} Timings */
/** @typedef {import('./types').ToolCallTiming} ToolCallTiming */
/** @typedef {import('./types').ToolCallsOutcome} ToolCallsOutcome */

export const INTERRUPTED_RESULT = 'Tool execution was interrupted by a new user message.';
// Says what a denial means for the rest of the task, not only that it
// happened. Until 2026-11-12 it was "Tool execution was denied by the user."
// and in the live test Ornith, denied one of three deletes, skipped the third
// and told the user the denied file was "recoverable from the Recycle Bin".
export const DENIED_RESULT =
	'The user refused this call, so it was not run. Do not try it again. Carry on with any other steps that do not depend on it, and say in your answer what was not done.';

/**
 * The most tool calls one reply may have run. The rest are answered, not run.
 *
 * A model can fall into a loop INSIDE one reply: Qwen3-4B answered
 * multi-recover with 58 calls in a single turn (agent bench, 2026-11-11,
 * results T19-49-58): 40 create_document calls with "[INSERT_RESULT_HERE]"
 * bodies, sqlite queries on a database it invented, and a delete_file, all
 * written before it had seen one result, and all run. The turn limit counts
 * replies, so it never saw them. The most any other reply made, across every
 * saved run of both models, was 4.
 */
export const MAX_TOOL_CALLS_PER_REPLY = 10;

/** @param {number} asked @param {number} limit */
export function overLimitResult(asked, limit) {
	return `Not run. This reply asked for ${asked} tool calls and only the first ${limit} are run. Read their results, then call what is still needed, a few calls at a time.`;
}

/**
 * Same test as chat-ui's isAbortError: an Error (or DOMException) named
 * AbortError. Duplicated rather than imported because the core cannot reach
 * into chat-ui.
 *
 * @param {unknown} error
 */
export function isAbortError(error) {
	if (
		typeof DOMException !== 'undefined' &&
		error instanceof DOMException &&
		error.name === 'AbortError'
	) {
		return true;
	}
	return error instanceof Error && error.name === 'AbortError';
}

/**
 * Fill in what a stream may leave out, so every call has an id, a type, a
 * name and an argument string.
 *
 * @param {RawToolCall[] | undefined} toolCalls
 * @returns {AgentToolCall[]}
 */
export function normalizeToolCalls(toolCalls) {
	if (!toolCalls) return [];
	return toolCalls.map((call, index) => ({
		id: call?.id ?? `tool_${index}`,
		type: /** @type {'function'} */ (call?.type ?? 'function'),
		function: {
			name: call?.function?.name ?? '',
			arguments: call?.function?.arguments ?? ''
		}
	}));
}

/**
 * Earlier tool calls as they may be SENT back to the model: any whose
 * arguments are not a JSON object go as "{}".
 *
 * llama-server parses the `arguments` string of every tool call in the
 * request history (common/chat.cpp, func_args_not_string) to render the chat
 * template, and fails the WHOLE request with HTTP 500 when one does not
 * parse. So one malformed call (a small model writing
 * `<parameter=code>...</parameter>` or a bare string) used to kill the
 * conversation: that turn's call errored, as it should, and then every later
 * request carried it and was refused. Found by the agent bench, 2026-11-11
 * (Qwen3-4B: 15 of 24 runs died on turn 2). The call's own error result
 * already tells the model what was wrong, so nothing it needs is lost.
 *
 * Applied where a host builds the request, not to stored messages: the UI
 * still shows what the model actually wrote.
 *
 * @template {{ function?: { name?: string, arguments?: string } }} T
 * @param {T[] | undefined} toolCalls
 * @returns {T[] | undefined}
 */
export function wireSafeToolCalls(toolCalls) {
	if (!Array.isArray(toolCalls)) return toolCalls;
	return toolCalls.map((call) => {
		const args = call?.function?.arguments;
		if (typeof args !== 'string') return call;
		let ok = false;
		try {
			const parsed = JSON.parse(args.trim() === '' ? '{}' : args);
			ok = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
		} catch {
			ok = false;
		}
		if (ok && args.trim() !== '') return call;
		return { ...call, function: { ...call.function, arguments: '{}' } };
	});
}

/** @returns {Promise<void>} */
function macrotask() {
	return new Promise((r) => setTimeout(r, 0));
}

/**
 * @template A the host's attachment type (see AgentPorts)
 * @param {{
 *   calls: AgentToolCall[],
 *   messages: AgentMessage[],
 *   agenticTimings: AgenticTimings,
 *   turnStats: TurnStats,
 *   capturedTimings: Timings | undefined,
 *   ports: import('./types').AgentPorts<A>,
 *   callbacks: import('./types').AgentStoreCallbacks<A>,
 *   signal?: AbortSignal,
 *   maxToolCalls?: number
 * }} params `maxToolCalls`: default MAX_TOOL_CALLS_PER_REPLY
 * @returns {Promise<ToolCallsOutcome>}
 */
export async function runToolCalls(params) {
	const { calls, messages, agenticTimings, turnStats, capturedTimings, ports, callbacks, signal } =
		params;
	const { onFlowComplete, createToolResultMessage, onAttachments } = callbacks;
	const now = ports.now ?? (() => performance.now());
	const yieldToHost = ports.yield ?? macrotask;

	const limit = params.maxToolCalls ?? MAX_TOOL_CALLS_PER_REPLY;

	for (let i = 0; i < calls.length; i++) {
		const toolCall = calls[i];

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		// Past the limit: answer every remaining call (a call with no result is
		// a malformed transcript) and go on to the next turn, where the model
		// sees what the first ones returned.
		if (i >= limit) {
			ports.log?.(`Reply asked for ${calls.length} tool calls; ${calls.length - i} not run`);
			const text = overLimitResult(calls.length, limit);
			for (let j = i; j < calls.length; j++) {
				if (createToolResultMessage) await createToolResultMessage(calls[j].id, text);
				messages.push({ role: 'tool', tool_call_id: calls[j].id, content: text });
			}
			break;
		}

		// A user message is waiting: skip the remaining calls, but answer each
		// one, because a tool call with no result is a malformed transcript.
		if (ports.steering.pending()) {
			ports.log?.(
				`Steering message detected, skipping ${calls.length - i} remaining tool call(s)`
			);
			for (let j = i; j < calls.length; j++) {
				const remainingCall = calls[j];
				if (createToolResultMessage) {
					await createToolResultMessage(remainingCall.id, INTERRUPTED_RESULT);
				}
				messages.push({ role: 'tool', tool_call_id: remainingCall.id, content: INTERRUPTED_RESULT });
			}
			break;
		}

		// ask_user, when the host can ask: answered by the person through the
		// ask port, not the gate or the executor. Asking needs no approval, and
		// nothing on a server could answer it.
		const asking = !!ports.ask && toolCall.function.name === ASK_USER_TOOL;
		// update_plan, when the host keeps a plan: stored by the host, no
		// approval (it changes nothing outside the conversation).
		const planning = !!ports.plan && toolCall.function.name === UPDATE_PLAN_TOOL;
		const hostResolved = asking || planning;

		const allowed = hostResolved ? true : await ports.gate.approve(toolCall, signal);

		// Let the host repaint (the browser hides the permission card here).
		if (!hostResolved) await yieldToHost();

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		let toolStartTime = now();

		/** @type {string} */
		let result;
		let toolSuccess = true;

		if (asking) {
			const parsed = parseAskArguments(toolCall.function.arguments);
			const ask = /** @type {NonNullable<typeof ports.ask>} */ (ports.ask);
			if (!parsed.ok) {
				result = parsed.error;
				toolSuccess = false;
				// Nobody was asked, but the host may still record the attempt.
				ask.invalid?.(toolCall, parsed.error);
			} else {
				const answer = await ask.user(parsed.request, signal, toolCall);
				// Let the host repaint (the browser hides the question card here).
				await yieldToHost();
				if (signal?.aborted) {
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return 'stopped';
				}
				result = formatAskAnswer(answer);
				// The time the person took to answer is not tool time.
				toolStartTime = now();
			}
		} else if (planning) {
			const plan = /** @type {NonNullable<typeof ports.plan>} */ (ports.plan);
			const parsed = parsePlanArguments(toolCall.function.arguments);
			if (!parsed.ok) {
				result = parsed.error;
				toolSuccess = false;
				plan.invalid?.(toolCall, parsed.error);
			} else {
				try {
					const unchanged = samePlan(plan.get(), parsed.steps);
					if (!unchanged) await plan.save(parsed.steps, toolCall);
					result = formatPlanResult(parsed.steps, { unchanged });
				} catch (error) {
					result = `Error: the plan could not be saved: ${error instanceof Error ? error.message : String(error)}`;
					toolSuccess = false;
				}
			}
		} else if (!allowed) {
			result = DENIED_RESULT;
			toolSuccess = false;
		} else {
			try {
				const execution = await ports.tools.execute(toolCall, signal);
				result = execution.text;
				if (execution.isError) toolSuccess = false;
			} catch (error) {
				if (isAbortError(error)) {
					onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
					return 'stopped';
				}
				result = `Error: ${error instanceof Error ? error.message : String(error)}`;
				toolSuccess = false;
			}
		}

		const toolDurationMs = now() - toolStartTime;
		/** @type {ToolCallTiming} */
		const toolTiming = {
			name: toolCall.function.name,
			duration_ms: Math.round(toolDurationMs),
			success: toolSuccess
		};

		agenticTimings.toolCalls?.push(toolTiming);
		agenticTimings.toolCallsCount++;
		agenticTimings.toolsMs += Math.round(toolDurationMs);
		turnStats.toolCalls.push(toolTiming);
		turnStats.toolsMs += Math.round(toolDurationMs);

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		const { text: cleanedResult, attachments } = ports.tools.extractAttachments
			? ports.tools.extractAttachments(result)
			: { text: result, attachments: [] };

		const toolResultMessage = createToolResultMessage
			? await createToolResultMessage(
					toolCall.id,
					cleanedResult,
					attachments.length > 0 ? attachments : undefined
				)
			: undefined;

		if (attachments.length > 0 && toolResultMessage) {
			onAttachments?.(toolResultMessage.id, attachments);
		}

		const extra = ports.tools.extraParts
			? await ports.tools.extraParts(cleanedResult, attachments)
			: [];
		/** @type {AgentContentPart[]} */
		const contentParts = [{ type: 'text', text: cleanedResult }, ...extra];

		messages.push({
			role: 'tool',
			tool_call_id: toolCall.id,
			content: contentParts.length === 1 ? cleanedResult : contentParts
		});
	}

	return 'done';
}
