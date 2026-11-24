/**
 * agent-core/compaction — the pure half of summary-buffer compaction (D32).
 *
 * Moved from chat-ui's ContextCompactionService so the daemon's task runner
 * compacts a long conversation exactly as a chat does. What stays with each
 * host is the I/O: counting tokens (llama-server /tokenize), the one model
 * call that writes the summary, and storing it on the conversation. The
 * algorithm, its thresholds and every text the model sees live here.
 *
 * The algorithm (the service's own description): when the history's
 * estimated prompt passes TRIGGER_RATIO of the usable context, the OLDEST
 * turns are folded into a running summary, kept on the conversation keyed to
 * the last message it covers; recent turns stay verbatim up to KEEP_RATIO.
 * Every payload also caps each message at MAX_SINGLE_MESSAGE_TOKENS_RATIO of
 * the budget, because summarizing old turns cannot shrink one huge recent
 * tool result. A failed summarizer falls back to hard truncation.
 *
 * Messages are stored records (chat-ui's DatabaseMessage shape: id, role,
 * content, reasoningContent, toolCalls as a JSON string, extra). Plain ESM.
 *
 * Use: planCompaction() decides; when it says 'summarize', the host asks the
 * model with summaryPrompt() and hands the text to finishCompaction().
 */

/** Compact when the estimated prompt passes this fraction of the usable context. */
export const TRIGGER_RATIO = 0.85;
/** After compacting, keep verbatim tail messages up to this fraction (the hysteresis). */
export const KEEP_RATIO = 0.5;
/** Headroom reserved for the reply when max_tokens is unlimited. */
export const DEFAULT_RESERVE_TOKENS = 1024;
/** Hard cap on the summary the model is asked to produce. */
export const SUMMARY_MAX_TOKENS = 400;
/** Per-message chat-template overhead /tokenize on raw text does not see. */
export const PER_MESSAGE_OVERHEAD_TOKENS = 6;
/** Per-message ceiling for the payload, as a fraction of `usable`. */
export const MAX_SINGLE_MESSAGE_TOKENS_RATIO = 0.4;
/** The summarizer's input is clipped to this many characters. */
export const SUMMARIZER_INPUT_CHARS = 24000;

export const SUMMARY_PREFIX = '[Conversation summary — earlier messages were compacted to fit the context window]\n';
/** What an earlier turn's tool result becomes when it is given up to fit (leanEarlierTurns). */
export const LEAN_RESULT_STUB = '[Earlier tool result removed to make room in the context; call the tool again if it is still needed.]';
/** A tool result in the summarizer's input: its head and tail, this many characters. */
export const SUMMARY_RESULT_CHARS = 1200;
/** A tool call's arguments in the summarizer's input, head and tail. */
export const SUMMARY_TOOL_ARGS_CHARS = 300;
export const ELISION_MARKER = '\n…[truncated — message exceeded the per-turn context budget]…\n';

/** @typedef {{ id: string, role: string, content?: any, reasoningContent?: string, toolCalls?: string, extra?: any[], [k: string]: any }} StoredMessage */
/** @typedef {{ text: string, upToMessageId: string } | null | undefined} StoredSummary */

/**
 * Progressive summarizer prompt (ported from LangChain's SUMMARY_PROMPT).
 *
 * @param {string} existingSummary
 * @param {string} newLines
 */
export function buildSummaryPrompt(existingSummary, newLines) {
	return (
		'Progressively summarize the lines of conversation provided, adding onto the previous summary and returning a new summary. ' +
		'Keep concrete facts, names, dates, numbers, decisions, and open questions. Reply with the new summary only.\n\n' +
		`Current summary:\n${existingSummary || '(none)'}\n\n` +
		`New lines of conversation:\n${newLines}\n\nNew summary:`
	);
}

/**
 * n_ctx and the send budget for the conversation's own messages, or null:
 * n_ctx minus generation headroom, minus what the request carries besides
 * those messages.
 *
 * `overheadTokens` is the system prompt and the tool list the gateway adds
 * (2026-11-18). Without it the trigger was measured against the messages
 * alone: on Ornith the 15 core tools and the composed prompt are ~5,150
 * tokens, so at n_ctx 12,288 compaction waited for ~6,960 tokens of messages
 * while the request overflowed past ~3,000. Absent or not a positive number:
 * 0, the old behaviour, for a caller that cannot measure it.
 *
 * @param {number | null | undefined} nCtx
 * @param {unknown} maxTokens the client's max_tokens setting
 * @param {unknown} [overheadTokens] the system prompt and tools, in tokens
 * @returns {{ nCtx: number, usable: number } | null}
 */
export function compactionBudget(nCtx, maxTokens, overheadTokens = 0) {
	if (!nCtx || nCtx <= 0) return null;
	const m = Number(maxTokens);
	const reserve = m > 0 ? m : DEFAULT_RESERVE_TOKENS;
	const o = Number(overheadTokens);
	const usable = nCtx - reserve - (o > 0 ? Math.ceil(o) : 0);
	return usable > 0 ? { nCtx, usable } : null;
}

/**
 * The text a message is measured and summarized by.
 *
 * @param {StoredMessage} message
 */
export function messageText(message) {
	let text = typeof message.content === 'string' ? message.content : '';
	if (message.reasoningContent) text += '\n' + message.reasoningContent;
	if (message.toolCalls) text += '\n' + message.toolCalls;
	if (message.extra?.length) {
		for (const extra of message.extra) {
			if (extra && 'content' in extra && typeof extra.content === 'string') text += '\n' + extra.content;
		}
	}
	return `${message.role}: ${text}`;
}

/**
 * What a message shows: its content and its attachments' text. No reasoning
 * and no tool-call JSON, which messageText adds for measuring.
 *
 * @param {StoredMessage} message
 */
function visibleText(message) {
	let text = typeof message.content === 'string' ? message.content : '';
	if (message.extra?.length) {
		for (const extra of message.extra) {
			if (extra && 'content' in extra && typeof extra.content === 'string') text += '\n' + extra.content;
		}
	}
	return text;
}

/**
 * `text` cut to its head and tail when longer than `keep`.
 *
 * @param {string} text
 * @param {number} keep
 */
function headTail(text, keep) {
	if (text.length <= keep) return text;
	const half = Math.floor(keep / 2);
	return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

/**
 * One message as the summarizer reads it: no reasoning (it is not what was
 * said), a tool call as its name and the head and tail of its arguments,
 * and a tool result as its head and tail. The conclusion a result led to is
 * in the assistant's next message.
 *
 * @param {StoredMessage} message
 */
export function summaryLine(message) {
	if (message.role === 'tool') return `tool result: ${headTail(visibleText(message), SUMMARY_RESULT_CHARS)}`;
	let line = `${message.role}: ${visibleText(message)}`;
	if (message.toolCalls) {
		try {
			const calls = JSON.parse(message.toolCalls);
			for (const call of Array.isArray(calls) ? calls : []) {
				const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
				line += `\n[called ${call?.function?.name ?? 'a tool'}(${headTail(args, SUMMARY_TOOL_ARGS_CHARS)})]`;
			}
		} catch {
			// Tool calls that do not parse say nothing worth summarizing.
		}
	}
	return line;
}

/**
 * Per-message counts from one total for the joined texts (one /tokenize
 * call), apportioned by length, plus template overhead. With no total, the
 * chars/3 estimate (conservative: compacts slightly early over a hard 400).
 *
 * @param {string[]} texts messageText() of each message
 * @param {number | undefined} totalTokens tokens in texts.join('\n'), or undefined
 * @returns {number[]}
 */
export function countsFromTotal(texts, totalTokens) {
	if (totalTokens !== undefined) {
		const totalChars = Math.max(1, texts.reduce((a, t) => a + t.length, 0));
		return texts.map((t) => Math.ceil((t.length / totalChars) * totalTokens) + PER_MESSAGE_OVERHEAD_TOKENS);
	}
	return texts.map((t) => Math.ceil(t.length / 3) + PER_MESSAGE_OVERHEAD_TOKENS);
}

/**
 * @param {StoredMessage} template
 * @param {string} summaryText
 * @returns {StoredMessage}
 */
export function makeSummaryMessage(template, summaryText) {
	return {
		...template,
		id: `compaction-${template.id}`,
		role: 'system',
		content: SUMMARY_PREFIX + summaryText,
		reasoningContent: undefined,
		toolCalls: '',
		extra: undefined
	};
}

/**
 * Trims each tool call's `arguments` while keeping the call list intact (a
 * following result's tool_call_id has to resolve against it).
 *
 * @param {string | undefined} toolCalls
 * @param {number} keepChars
 */
export function capToolCallArguments(toolCalls, keepChars) {
	if (!toolCalls || toolCalls.length <= keepChars) return toolCalls;
	try {
		const parsed = JSON.parse(toolCalls);
		if (!Array.isArray(parsed) || parsed.length === 0) return toolCalls;
		const perCall = Math.max(120, Math.floor(keepChars / parsed.length));
		return JSON.stringify(
			parsed.map((call) => {
				const args = call?.function?.arguments;
				if (typeof args !== 'string' || args.length <= perCall) return call;
				return { ...call, function: { ...call.function, arguments: args.slice(0, perCall) + ELISION_MARKER } };
			})
		);
	} catch {
		return toolCalls;
	}
}

/**
 * Payload-only elision of one oversized message (head + tail kept). The
 * stored message is never mutated.
 *
 * @param {StoredMessage} message
 * @param {number} tokenCount
 * @param {number} limitTokens
 * @returns {StoredMessage}
 */
export function capOversizedMessage(message, tokenCount, limitTokens) {
	if (limitTokens <= 0 || tokenCount <= limitTokens) return message;
	const measured = messageText(message);
	// The content and attachments only. Until 2026-11-24 this was messageText,
	// which carries the reasoning and the tool-call JSON: a capped message
	// sent its thinking inline in the answer, and every tool call twice.
	const text = visibleText(message);
	const approxCharsPerToken = Math.max(1, measured.length / Math.max(1, tokenCount));
	const keepChars = Math.max(200, Math.floor(limitTokens * approxCharsPerToken * 0.45));
	return {
		...message,
		id: `elided-${message.id}`,
		content: text.length <= keepChars * 2 ? text : text.slice(0, keepChars) + ELISION_MARKER + text.slice(-keepChars),
		reasoningContent: undefined,
		toolCalls: capToolCallArguments(message.toolCalls, keepChars),
		extra: undefined
	};
}

/**
 * The per-message cap across a payload. Returns the SAME array when nothing
 * needed eliding (callers use identity).
 *
 * @param {StoredMessage[]} messages
 * @param {Map<string, number>} countById
 * @param {number} limitTokens
 */
export function capPayload(messages, countById, limitTokens) {
	let capped = false;
	const out = messages.map((message) => {
		const count = countById.get(message.id);
		if (count === undefined) return message;
		const next = capOversizedMessage(message, count, limitTokens);
		if (next !== message) capped = true;
		return next;
	});
	return capped ? out : messages;
}

/** @param {StoredMessage[]} messages */
export function leadingSystemCount(messages) {
	let n = 0;
	while (n < messages.length && messages[n].role === 'system') n++;
	return n;
}

/**
 * The payload with a stored summary's span replaced, when its boundary is on
 * this branch; otherwise the input (same reference).
 *
 * @param {StoredMessage[]} messages
 * @param {StoredSummary} stored
 * @returns {{ messages: StoredMessage[], applied: boolean }}
 */
export function applyStoredSummary(messages, stored) {
	if (!stored?.text || !stored.upToMessageId) return { messages, applied: false };
	const boundary = messages.findIndex((m) => m.id === stored.upToMessageId);
	const firstChat = leadingSystemCount(messages);
	if (boundary < firstChat) return { messages, applied: false };
	const summaryMessage = makeSummaryMessage(messages[boundary], stored.text);
	return { messages: [...messages.slice(0, firstChat), summaryMessage, ...messages.slice(boundary + 1)], applied: true };
}

/**
 * Where the verbatim tail starts: the newest messages within keepBudget, and
 * never fewer than the last two.
 *
 * @param {number[]} counts
 * @param {number} firstChat
 * @param {number} keepBudget
 */
export function tailStartFor(counts, firstChat, keepBudget) {
	let tailStart = counts.length;
	let tailTokens = 0;
	while (tailStart > firstChat) {
		const next = tailTokens + counts[tailStart - 1];
		if (next > keepBudget && counts.length - tailStart >= 2) break;
		tailTokens = next;
		tailStart--;
	}
	return tailStart;
}

/**
 * The part of `pruned` a summary still has to cover, and the summary to
 * extend: a stored summary is reused when its boundary is inside `pruned`.
 *
 * @param {StoredMessage[]} pruned
 * @param {StoredSummary} stored
 */
export function summarySpan(pruned, stored) {
	if (stored?.text && stored.upToMessageId) {
		const boundary = pruned.findIndex((m) => m.id === stored.upToMessageId);
		if (boundary !== -1) return { existingSummary: stored.text, toSummarize: pruned.slice(boundary + 1) };
	}
	return { existingSummary: '', toSummarize: pruned };
}

/**
 * The summarizer's prompt for these messages.
 *
 * @param {string} existingSummary
 * @param {StoredMessage[]} messages
 */
export function summaryPrompt(existingSummary, messages) {
	const all = messages.map((m) => summaryLine(m)).join('\n');
	// Too long for one call: the NEWEST lines are kept. Until 2026-11-24 the
	// clip kept the oldest, so the turns closest to the present, the ones the
	// conversation is about now, were the ones lost.
	const newLines = all.length <= SUMMARIZER_INPUT_CHARS ? all : `…[earlier lines omitted]…\n${all.slice(-SUMMARIZER_INPUT_CHARS)}`;
	return buildSummaryPrompt(existingSummary, newLines);
}

/**
 * Earlier turns give up their space before any summary is paid for. The
 * turns before the last user message drop their reasoning, then their tool
 * results become LEAN_RESULT_STUB, oldest first, until the payload is under
 * `target`. Deterministic, so consecutive sends produce the same prefix and
 * the server's prompt cache holds. The current turn is never touched. The
 * stored messages are not changed: the copies are the payload.
 *
 * Counts are re-estimated by length: a message's tokens scale with the text
 * it keeps (messageText, as the counts were measured).
 *
 * @param {StoredMessage[]} messages
 * @param {number[]} counts
 * @param {number} target
 * @returns {{ messages: StoredMessage[], counts: number[], total: number, changed: boolean }}
 */
export function leanEarlierTurns(messages, counts, target) {
	let lastUser = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			lastUser = i;
			break;
		}
	}
	const out = [...messages];
	const outCounts = [...counts];
	let total = counts.reduce((a, b) => a + b, 0);
	let changed = false;
	/** @param {number} i @param {StoredMessage} next */
	const replace = (i, next) => {
		const before = messageText(out[i]).length;
		const after = messageText(next).length;
		const count = Math.max(PER_MESSAGE_OVERHEAD_TOKENS, Math.ceil(outCounts[i] * (after / Math.max(1, before))));
		total += count - outCounts[i];
		outCounts[i] = count;
		out[i] = next;
		changed = true;
	};
	for (let i = 0; i < lastUser && total > target; i++) {
		if (out[i].reasoningContent) replace(i, { ...out[i], reasoningContent: undefined });
	}
	for (let i = 0; i < lastUser && total > target; i++) {
		const m = out[i];
		if (m.role !== 'tool' || visibleText(m).length <= LEAN_RESULT_STUB.length) continue;
		replace(i, { ...m, content: LEAN_RESULT_STUB, extra: undefined });
	}
	return { messages: changed ? out : messages, counts: outCounts, total, changed };
}

/**
 * @typedef {{ action: 'send', messages: StoredMessage[], compacted: boolean }
 *   | { action: 'summarize', head: StoredMessage[], cappedTail: StoredMessage[], pruned: StoredMessage[],
 *       existingSummary: string, toSummarize: StoredMessage[] }} CompactionPlan
 */

/**
 * maybeCompact's decision, without its I/O.
 *
 * @param {{ messages: StoredMessage[], counts: number[], usable: number, stored: StoredSummary }} input
 * @returns {CompactionPlan}
 */
export function planCompaction({ messages, counts, usable, stored }) {
	const total = counts.reduce((a, b) => a + b, 0);
	const countById = new Map(messages.map((m, i) => [m.id, counts[i]]));
	const perMessageLimit = usable * MAX_SINGLE_MESSAGE_TOKENS_RATIO;

	if (total <= usable * TRIGGER_RATIO) {
		// Under threshold, but a stored summary still shrinks the payload, and
		// the per-message cap still applies.
		const effective = applyStoredSummary(messages, stored);
		const capped = capPayload(effective.messages, countById, perMessageLimit);
		return { action: 'send', messages: capped, compacted: effective.applied || capped !== effective.messages };
	}

	// Before a summary is paid for, earlier turns give up their reasoning and
	// their old tool results. When that fits, no model call is made.
	const lean = leanEarlierTurns(messages, counts, usable * KEEP_RATIO);
	if (lean.changed && lean.total <= usable * TRIGGER_RATIO) {
		const leanCounts = new Map(lean.messages.map((m, i) => [m.id, lean.counts[i]]));
		const effective = applyStoredSummary(lean.messages, stored);
		return { action: 'send', messages: capPayload(effective.messages, leanCounts, perMessageLimit), compacted: true };
	}

	const firstChat = leadingSystemCount(messages);
	const tailStart = tailStartFor(counts, firstChat, usable * KEEP_RATIO);
	const pruned = messages.slice(firstChat, tailStart);
	if (pruned.length === 0) {
		// Nothing old enough to summarize: capping is the only lever left.
		const capped = capPayload(messages, countById, perMessageLimit);
		return { action: 'send', messages: capped, compacted: capped !== messages };
	}

	const { existingSummary, toSummarize } = summarySpan(pruned, stored);
	const cappedTail = capPayload(messages.slice(tailStart), countById, perMessageLimit);
	return { action: 'summarize', head: messages.slice(0, firstChat), cappedTail, pruned, existingSummary, toSummarize };
}

/**
 * The payload once the summarizer has answered (or failed: null), and the
 * summary to store. A failed summarizer drops the old turns outright: that
 * loses context, but it sends, where the original would be a certain 400.
 *
 * @param {Extract<CompactionPlan, { action: 'summarize' }>} plan
 * @param {string | null} summary
 * @returns {{ messages: StoredMessage[], compacted: true, contextSummary: { text: string, upToMessageId: string } | null }}
 */
export function finishCompaction(plan, summary) {
	if (!summary) return { messages: [...plan.head, ...plan.cappedTail], compacted: true, contextSummary: null };
	const last = plan.pruned[plan.pruned.length - 1];
	return {
		messages: [...plan.head, makeSummaryMessage(last, summary), ...plan.cappedTail],
		compacted: true,
		contextSummary: { text: summary, upToMessageId: last.id }
	};
}

/**
 * compactNow's span: everything older than the keep-tail, regardless of the
 * automatic threshold. Null when there is nothing to fold in.
 *
 * @param {{ messages: StoredMessage[], counts: number[], usable: number, stored: StoredSummary }} input
 * @returns {{ pruned: StoredMessage[], existingSummary: string, toSummarize: StoredMessage[] } | { nothing: 'fits' | 'already' }}
 */
export function planManualCompaction({ messages, counts, usable, stored }) {
	const firstChat = leadingSystemCount(messages);
	const tailStart = tailStartFor(counts, firstChat, usable * KEEP_RATIO);
	const pruned = messages.slice(firstChat, tailStart);
	if (pruned.length === 0) return { nothing: 'fits' };
	const { existingSummary, toSummarize } = summarySpan(pruned, stored);
	if (toSummarize.length === 0 && existingSummary) return { nothing: 'already' };
	return { pruned, existingSummary, toSummarize };
}
