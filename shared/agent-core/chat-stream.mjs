/**
 * agent-core/chat-stream — reading an OpenAI-style SSE completion stream.
 *
 * For hosts that talk to the gateway (or llama-server) with fetch: the
 * benchmark now, the daemon's task runtime in Phase 3. Fills the loop's
 * TurnAccumulator as chunks arrive, so a stream that dies mid-turn leaves the
 * partial answer where the loop's catch block reads it.
 *
 * Follows chat-ui's services/chat/chat-stream.ts (handleStreamResponse) rule
 * for rule, including the one that is easy to miss: tool-call deltas are
 * grouped into BATCHES, and content or reasoning arriving between two batches
 * closes the first, so the second's index 0 is a new call rather than more
 * arguments for the old one. chat-ui's own reader still has its own copy of
 * the loop (it reports far more: model name, completion id, prompt progress);
 * mergeToolCallDeltas is the shared part.
 */

/** @typedef {import('./types').RawToolCall} RawToolCall */
/** @typedef {import('./types').TurnAccumulator} TurnAccumulator */
/** @typedef {import('./types').Timings} Timings */

/**
 * @typedef {{
 *   index?: number,
 *   id?: string,
 *   type?: string,
 *   function?: { name?: string, arguments?: string }
 * }} ToolCallDelta
 */

/**
 * Fold one chunk's tool-call deltas into the calls so far. Returns a new
 * array; `existing` is not modified.
 *
 * @param {RawToolCall[]} existing
 * @param {ToolCallDelta[]} deltas
 * @param {number} [indexOffset] where the current batch starts
 * @returns {RawToolCall[]}
 */
export function mergeToolCallDeltas(existing, deltas, indexOffset = 0) {
	const result = existing.map((call) => ({
		...call,
		function: call.function ? { ...call.function } : undefined
	}));

	for (const delta of deltas) {
		const index =
			typeof delta.index === 'number' && delta.index >= 0 ? delta.index + indexOffset : result.length;

		while (result.length <= index) result.push({ function: undefined });

		const target = result[index];
		if (delta.id) target.id = delta.id;
		if (delta.type) target.type = delta.type;
		if (delta.function) {
			/** @type {{ name?: string, arguments?: string }} */
			const fn = target.function ? { ...target.function } : {};
			if (delta.function.name) fn.name = delta.function.name;
			if (delta.function.arguments) fn.arguments = (fn.arguments ?? '') + delta.function.arguments;
			target.function = fn;
		}
	}

	return result;
}

/**
 * The message of an error event inside a completion stream, or null.
 *
 * llama-server reports a failure that happens after the reply has started as
 * an SSE event `data: {"error": {"code": 500, "message": "...", "type":
 * "server_error"}}` and then closes the stream with no [DONE]. Both readers
 * used to skip it, so the reply simply ended: the agent bench scored an empty
 * answer with no error (docs-two-sources, 2026-11-11: "Context size has been
 * exceeded"), and chat-ui showed nothing at all. Shared so chat-ui's reader
 * and readChatStream recognise the same shapes.
 *
 * @param {any} parsed one parsed `data:` payload
 * @returns {string | null}
 */
export function streamErrorMessage(parsed) {
	const err = parsed?.error;
	if (!err) return null;
	const text = typeof err === 'string' ? err : typeof err.message === 'string' ? err.message : JSON.stringify(err);
	return `The server stopped this reply: ${text}`;
}

/**
 * Read a streaming chat completion into `acc`. Resolves at end of stream
 * (or when `signal` aborts, as chat-ui's reader does: the loop checks the
 * signal itself). Throws if the response is not OK, has no body, or carries an
 * error event mid-stream.
 *
 * @param {Response} response
 * @param {TurnAccumulator} acc
 * @param {{
 *   signal?: AbortSignal,
 *   onContent?: (chunk: string) => void,
 *   onReasoning?: (chunk: string) => void,
 *   onToolCalls?: (calls: RawToolCall[]) => void,
 *   onTimings?: (timings: Timings) => void
 * }} [hooks]
 * @returns {Promise<{ finished: boolean, model?: string }>} finished: a [DONE] arrived
 */
export async function readChatStream(response, acc, hooks = {}) {
	const { signal } = hooks;
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Completion request failed: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error('No response body');

	const decoder = new TextDecoder();
	let buffer = '';
	let finished = false;
	/** @type {string | undefined} */
	let model;
	let indexOffset = 0;
	let openBatch = false;
	const closeBatch = () => {
		if (!openBatch) return;
		indexOffset = acc.toolCalls.length;
		openBatch = false;
	};

	try {
		while (true) {
			if (signal?.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;
			if (signal?.aborted) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const raw of lines) {
				const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
				if (!line.startsWith('data: ')) continue;
				const data = line.slice(6);
				if (data === '[DONE]') {
					finished = true;
					continue;
				}
				/** @type {any} */
				let parsed;
				try {
					parsed = JSON.parse(data);
				} catch {
					continue;
				}
				// Thrown, not skipped: the loop keeps the partial answer and the
				// host reports the error (see streamErrorMessage).
				const streamError = streamErrorMessage(parsed);
				if (streamError) throw new Error(streamError);
				if (!model && typeof parsed?.model === 'string') model = parsed.model;
				const delta = parsed?.choices?.[0]?.delta;
				if (parsed?.timings) {
					acc.timings = parsed.timings;
					acc.captured = parsed.timings;
					hooks.onTimings?.(parsed.timings);
				}
				if (typeof delta?.content === 'string' && delta.content) {
					closeBatch();
					acc.content += delta.content;
					hooks.onContent?.(delta.content);
				}
				if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
					closeBatch();
					acc.reasoning += delta.reasoning_content;
					hooks.onReasoning?.(delta.reasoning_content);
				}
				if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
					acc.toolCalls = mergeToolCallDeltas(acc.toolCalls, delta.tool_calls, indexOffset);
					if (acc.toolCalls.length > 0) {
						openBatch = true;
						hooks.onToolCalls?.(acc.toolCalls);
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { finished, model };
}
