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
export const DENIED_RESULT = 'Tool execution was denied by the user.';

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
 *   signal?: AbortSignal
 * }} params
 * @returns {Promise<ToolCallsOutcome>}
 */
export async function runToolCalls(params) {
	const { calls, messages, agenticTimings, turnStats, capturedTimings, ports, callbacks, signal } =
		params;
	const { onFlowComplete, createToolResultMessage, onAttachments } = callbacks;
	const now = ports.now ?? (() => performance.now());
	const yieldToHost = ports.yield ?? macrotask;

	for (let i = 0; i < calls.length; i++) {
		const toolCall = calls[i];

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
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

		const allowed = await ports.gate.approve(toolCall, signal);

		// Let the host repaint (the browser hides the permission card here).
		await yieldToHost();

		if (signal?.aborted) {
			onFlowComplete?.(buildFinalTimings(capturedTimings, agenticTimings));
			return 'stopped';
		}

		const toolStartTime = now();

		/** @type {string} */
		let result;
		let toolSuccess = true;

		if (!allowed) {
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
