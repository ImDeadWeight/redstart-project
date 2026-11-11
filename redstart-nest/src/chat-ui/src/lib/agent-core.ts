/**
 * agent-core - chat-ui's door to the repo's shared loop core.
 *
 * The loop lives in `<repo>/shared/agent-core/` as plain ESM so the browser,
 * the benchmark and (from Phase 3) the daemon all run the same code. chat-ui
 * imports it by relative path: vite bundles it, vitest runs it, svelte-check
 * reads its JSDoc types. `vite dev` serves it because vite.config.ts adds the
 * repo's shared/ to server.fs.allow. This file keeps that long path in one
 * place.
 *
 * chat-ui has checkJs off, so the core's bodies are type-checked on the Nest
 * side instead (redstart-nest/tsconfig.agent-core.json, run by `typecheck`).
 */

export { runAgentLoop, createTurnAccumulator } from '../../../../../shared/agent-core/loop.mjs';
export {
	buildFinalTimings,
	createAgenticTimings,
	createTurnStats,
	foldTurnTimings
} from '../../../../../shared/agent-core/timings.mjs';
export {
	normalizeToolCalls,
	isAbortError,
	DENIED_RESULT,
	INTERRUPTED_RESULT
} from '../../../../../shared/agent-core/tool-calls.mjs';
export type {
	AgentPorts,
	AgentLoopParams,
	AgentMessage,
	AgentToolCall,
	AgentContentPart,
	AgentStoreCallbacks,
	TurnAccumulator,
	ToolExecution,
	ToolCallsOutcome
} from '../../../../../shared/agent-core/types';
