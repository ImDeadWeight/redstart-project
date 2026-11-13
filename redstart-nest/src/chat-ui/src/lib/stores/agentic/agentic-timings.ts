/**
 * agentic-timings - the timings a finished agentic flow reports
 *
 * Moved to the shared loop core (shared/agent-core/timings.mjs) with the loop
 * itself. Re-exported here, typed with chat-ui's own timing types, so existing
 * imports keep working.
 */

// ChatMessageTimings is ambient (globalised in app.d.ts); ChatMessageAgenticTimings
// is not, despite sitting beside it in types/chat.d.ts. Importing the first would
// be the Appendix B defect-4 mistake; not importing the second is a type error.
import type { ChatMessageAgenticTimings } from '$lib/types';
import { buildFinalTimings as coreBuildFinalTimings } from '$lib/agent-core';

export const buildFinalTimings = coreBuildFinalTimings as (
	capturedTimings: ChatMessageTimings | undefined,
	agenticTimings: ChatMessageAgenticTimings
) => ChatMessageTimings | undefined;
