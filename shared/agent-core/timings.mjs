/**
 * agent-core/timings — the timings a finished agentic flow reports.
 *
 * Pure: no state, no I/O. Moved here from chat-ui's agentic-timings.ts, which
 * now re-exports it.
 */

/** @typedef {import('./types').Timings} Timings */
/** @typedef {import('./types').AgenticTimings} AgenticTimings */
/** @typedef {import('./types').TurnStats} TurnStats */

/**
 * Folds the per-turn agentic counters into the timings captured from the last
 * completion so the UI can show both. Returns the captured timings untouched
 * when no tool was called, which is what makes a zero-tool run report exactly
 * as a non-agentic one.
 *
 * @param {Timings | undefined} capturedTimings
 * @param {AgenticTimings} agenticTimings
 * @returns {Timings | undefined}
 */
export function buildFinalTimings(capturedTimings, agenticTimings) {
	if (agenticTimings.toolCallsCount === 0) return capturedTimings;
	return {
		predicted_n: capturedTimings?.predicted_n,
		predicted_ms: capturedTimings?.predicted_ms,
		prompt_n: capturedTimings?.prompt_n,
		prompt_ms: capturedTimings?.prompt_ms,
		cache_n: capturedTimings?.cache_n,
		agentic: agenticTimings
	};
}

/** @returns {AgenticTimings} */
export function createAgenticTimings() {
	return {
		turns: 0,
		toolCallsCount: 0,
		toolsMs: 0,
		toolCalls: [],
		perTurn: [],
		llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 }
	};
}

/**
 * @param {number} turn 1-based
 * @returns {TurnStats}
 */
export function createTurnStats(turn) {
	return {
		turn,
		llm: { predicted_n: 0, predicted_ms: 0, prompt_n: 0, prompt_ms: 0 },
		toolCalls: [],
		toolsMs: 0
	};
}

/**
 * Adds one turn's model timings to the flow totals and sets them as the
 * turn's own. No-op when the turn reported none.
 *
 * @param {Timings | undefined} timings
 * @param {AgenticTimings} agenticTimings
 * @param {TurnStats} turnStats
 */
export function foldTurnTimings(timings, agenticTimings, turnStats) {
	if (!timings) return;
	agenticTimings.llm.predicted_n += timings.predicted_n || 0;
	agenticTimings.llm.predicted_ms += timings.predicted_ms || 0;
	agenticTimings.llm.prompt_n += timings.prompt_n || 0;
	agenticTimings.llm.prompt_ms += timings.prompt_ms || 0;
	turnStats.llm.predicted_n = timings.predicted_n || 0;
	turnStats.llm.predicted_ms = timings.predicted_ms || 0;
	turnStats.llm.prompt_n = timings.prompt_n || 0;
	turnStats.llm.prompt_ms = timings.prompt_ms || 0;
}
