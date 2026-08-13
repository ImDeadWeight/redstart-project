/**
 * agentic-timings - the timings a finished agentic flow reports
 *
 * Folds the per-turn agentic counters into the timings captured from the last
 * completion so the UI can show both. Returns the captured timings untouched
 * when no tool was called, which is what makes a zero-tool run report exactly
 * as a non-agentic one.
 *
 * Pure: no store state, no reactivity, no I/O.
 */

// ChatMessageTimings is ambient (globalised in app.d.ts); ChatMessageAgenticTimings
// is not, despite sitting beside it in types/chat.d.ts. Importing the first would
// be the Appendix B defect-4 mistake; not importing the second is a type error.
import type { ChatMessageAgenticTimings } from '$lib/types';

export function buildFinalTimings(
	capturedTimings: ChatMessageTimings | undefined,
	agenticTimings: ChatMessageAgenticTimings
): ChatMessageTimings | undefined {
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
