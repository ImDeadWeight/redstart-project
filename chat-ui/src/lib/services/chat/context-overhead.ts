/**
 * context-overhead - what a request carries besides the conversation's own messages.
 *
 * The context budget (context-compaction.service.ts) counts the messages
 * chat-ui wrote. A request through Nest also carries:
 *  - the gateway's composed system prompt (identity, policy, capabilities,
 *    memories), which chat-ui never sees: the gateway states its size in
 *    SYSTEM_PROMPT_CHARS_HEADER on every reply;
 *  - the tool definitions chat-ui itself sends.
 * On a 4,096-token profile the two can be 2,000+ tokens, so a request
 * overflowed ("exceeds the available context size") while compaction still
 * saw room. agent-core's compactionBudget subtracts this overhead.
 *
 * Kept apart by whether the request carried tools: the gateway's prompt is
 * longer with tools (it describes them), and a title or summarizer call,
 * which sends none, must not shrink the figure the next chat send is
 * budgeted on. Before the first reply of a session a typical size is
 * assumed. Characters become tokens at 3 per token, the conservative
 * estimate agent-core's compaction uses without a tokenizer.
 *
 * Ported from 5e33099 (feat/context-budget, never merged), onto main's
 * agent-core compaction.
 */

/** The header the gateway answers every completion with. */
export const SYSTEM_PROMPT_CHARS_HEADER = 'x-redstart-system-prompt-chars';

/** Assumed before the gateway has said: a typical composed prompt with tools. */
export const DEFAULT_SYSTEM_PROMPT_CHARS = 6_000;

const CHARS_PER_TOKEN = 3;

const systemPromptChars: { tools: number | null; none: number | null } = { tools: null, none: null };
let toolsChars = 0;

/**
 * After a completion request: remember what it carried besides the messages.
 *
 * @param tools the tool definitions sent, or none
 * @param response the gateway's response (its headers are read)
 */
export function recordRequestOverhead(tools: unknown[] | undefined, response: Pick<Response, 'headers'>): void {
	const withTools = Array.isArray(tools) && tools.length > 0;
	if (withTools) toolsChars = JSON.stringify(tools).length;
	const stated = Number(response.headers.get(SYSTEM_PROMPT_CHARS_HEADER));
	if (Number.isFinite(stated) && stated >= 0 && response.headers.has(SYSTEM_PROMPT_CHARS_HEADER)) {
		systemPromptChars[withTools ? 'tools' : 'none'] = stated;
	}
}

/** The overhead of a chat send (one that carries tools), in tokens. */
export function chatOverheadTokens(): number {
	const prompt = systemPromptChars.tools ?? DEFAULT_SYSTEM_PROMPT_CHARS;
	return Math.ceil((prompt + toolsChars) / CHARS_PER_TOKEN);
}

/** Back to nothing known (a new session, a test). */
export function resetContextOverhead(): void {
	systemPromptChars.tools = null;
	systemPromptChars.none = null;
	toolsChars = 0;
}
