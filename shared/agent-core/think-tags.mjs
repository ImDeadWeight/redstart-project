/**
 * agent-core/think-tags — thinking-tag markup that reached the ANSWER channel.
 *
 * llama-server separates a reasoning model's thinking from its answer by
 * parsing the one thinking block it expects at the start of the turn: our
 * qwen3.6 template ends the prompt with `<think>\n`, and the first `</think>`
 * the model writes ends the reasoning. Anything after that is content, verbatim.
 *
 * Models do not always oblige. Seen in a real chat: after tool results the
 * model wrote "Sure, let's try it out!\n</think>" and then a tool call. It
 * closed thinking a second time, or the template had handed it a pre-closed
 * empty block (its no-thinking and repeated-failure paths do) and it closed
 * that one again. The stray tag was shown in the answer, saved with it, and
 * sent back as history, where the template's own split on "\n</think>"
 * reinterprets that turn on the next request.
 *
 * ThinkTagRouter sits between the stream and everything that consumes it, in
 * chat-ui's reader and in readChatStream (the daemon's task runtime, where a
 * plain Send runs):
 *  - `<think>…</think>` (or `<thinking>…</thinking>`) written in the content
 *    goes to the reasoning channel, as the server would have sent it;
 *  - a closing tag with no opening, the stray above, is dropped, with the
 *    blank lines that follow it;
 *  - tags inside a ``` fence, or wrapped in inline backticks, are text the
 *    model is SHOWING, such as an answer about chat templates, and pass
 *    through untouched;
 *  - a tag split across stream chunks ("</th" + "ink>") is held back until it
 *    can be told apart from text, and released by flush() at the end.
 *
 * Text written before a stray closing tag stays in the answer. Moving it to
 * reasoning would mean retracting what was already streamed, and it is
 * usually a sentence meant for the user anyway.
 *
 * Ported from chat-ui (bd496bf, feat/context-budget, never merged) into the
 * core so both readers share it. Pure: no I/O.
 */

/** @typedef {{ kind: 'content' | 'reasoning', text: string }} RoutedSegment */

const OPEN_TAGS = ['<think>', '<thinking>'];
const CLOSE_TAGS = ['</think>', '</thinking>'];
const FENCE = '```';
const TOKENS = [FENCE, ...OPEN_TAGS, ...CLOSE_TAGS];

/**
 * Length of the longest suffix of `text` that is a proper prefix of a token.
 *
 * @param {string} text
 * @param {readonly string[]} tokens
 */
function partialTokenSuffix(text, tokens) {
	let best = 0;
	for (const token of tokens) {
		for (let len = Math.min(token.length - 1, text.length); len > best; len--) {
			if (text.endsWith(token.slice(0, len))) {
				best = len;
				break;
			}
		}
	}
	return best;
}

/**
 * The earliest of `tokens` in `text` at or after `from`.
 *
 * @param {string} text
 * @param {readonly string[]} tokens
 * @param {number} [from]
 * @returns {{ index: number, token: string } | null}
 */
function nextToken(text, tokens, from = 0) {
	/** @type {{ index: number, token: string } | null} */
	let found = null;
	for (const token of tokens) {
		const index = text.indexOf(token, from);
		if (index !== -1 && (found === null || index < found.index)) found = { index, token };
	}
	return found;
}

export class ThinkTagRouter {
	constructor() {
		this.buffer = '';
		this.inReasoning = false;
		this.inFence = false;
		// After a tag is dropped, the newlines that followed it are layout, not
		// answer: "\n</think>\n\nNext" should read "Next", not "\n\nNext".
		this.trimLeading = false;
		/** @type {RoutedSegment[]} */
		this.out = [];
	}

	/**
	 * Feeds one content chunk; returns what can be released now, in order.
	 *
	 * @param {string} text
	 * @returns {RoutedSegment[]}
	 */
	push(text) {
		this.buffer += text;
		this.drain(false);
		return this.take();
	}

	/**
	 * Releases whatever was held back. Call once, when the stream ends.
	 *
	 * @returns {RoutedSegment[]}
	 */
	flush() {
		this.drain(true);
		return this.take();
	}

	/** @returns {RoutedSegment[]} */
	take() {
		const out = this.out;
		this.out = [];
		return out;
	}

	/**
	 * @param {RoutedSegment['kind']} kind
	 * @param {string} text
	 */
	emit(kind, text) {
		if (kind === 'content' && this.trimLeading) {
			// Line breaks only: a space after the tag can be the one between two
			// words ("two</think> three"), and dropping it would join them.
			const trimmed = text.replace(/^[\r\n]+/, '');
			if (trimmed === '') return;
			this.trimLeading = false;
			text = trimmed;
		}
		if (!text) return;
		const last = this.out[this.out.length - 1];
		if (last && last.kind === kind) last.text += text;
		else this.out.push({ kind, text });
	}

	/**
	 * Emits all but a held-back tail that might begin a token.
	 *
	 * @param {RoutedSegment['kind']} kind
	 * @param {readonly string[]} tokens
	 * @param {boolean} final
	 */
	emitSafe(kind, tokens, final) {
		const hold = final ? 0 : partialTokenSuffix(this.buffer, tokens);
		this.emit(kind, this.buffer.slice(0, this.buffer.length - hold));
		this.buffer = this.buffer.slice(this.buffer.length - hold);
	}

	/** @param {boolean} final */
	drain(final) {
		while (this.buffer) {
			if (this.inReasoning) {
				const close = nextToken(this.buffer, CLOSE_TAGS);
				if (!close) {
					this.emitSafe('reasoning', CLOSE_TAGS, final);
					return;
				}
				this.emit('reasoning', this.buffer.slice(0, close.index));
				this.buffer = this.buffer.slice(close.index + close.token.length);
				this.inReasoning = false;
				this.trimLeading = true;
				continue;
			}

			if (this.inFence) {
				const end = this.buffer.indexOf(FENCE);
				if (end === -1) {
					this.emitSafe('content', [FENCE], final);
					return;
				}
				this.emit('content', this.buffer.slice(0, end + FENCE.length));
				this.buffer = this.buffer.slice(end + FENCE.length);
				this.inFence = false;
				continue;
			}

			const hit = nextToken(this.buffer, TOKENS);
			if (!hit) {
				this.emitSafe('content', TOKENS, final);
				return;
			}
			const before = this.buffer.slice(0, hit.index);
			const after = this.buffer.slice(hit.index + hit.token.length);

			if (hit.token === FENCE) {
				this.emit('content', before + FENCE);
				this.buffer = after;
				this.inFence = true;
				continue;
			}

			// `<think>` in inline code is the model quoting the tag.
			if (before.endsWith('`')) {
				this.emit('content', before + hit.token);
				this.buffer = after;
				continue;
			}

			this.emit('content', before);
			this.buffer = after;
			if (OPEN_TAGS.includes(hit.token)) {
				this.inReasoning = true;
			} else {
				this.trimLeading = true;
			}
		}
	}
}

/**
 * One-shot routing of a complete (non-streamed) content string.
 *
 * @param {string} content
 * @returns {{ content: string, reasoning: string }}
 */
export function routeThinkTags(content) {
	const router = new ThinkTagRouter();
	const segments = [...router.push(content), ...router.flush()];
	return {
		content: segments.filter((s) => s.kind === 'content').map((s) => s.text).join(''),
		reasoning: segments.filter((s) => s.kind === 'reasoning').map((s) => s.text).join('')
	};
}
