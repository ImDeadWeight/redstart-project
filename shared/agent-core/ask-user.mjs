/**
 * agent-core/ask-user — the ask_user tool, resolved by the host (plan §4,
 * 1.1; decision D4).
 *
 * The model calls ask_user when two readings of a request lead to different
 * work. Nothing on the server can answer it: the host asks the person (a
 * card in chat-ui, a scripted answer in the bench, a parked task in the
 * daemon runtime later) through the `ask` port, and the loop gives the model
 * the answer as the tool result. This file is the part every host shares:
 * the argument check and the result wording, so the model reads the same
 * sentence whichever host answered.
 *
 * The schema is deliberately small. A free-text answer is always allowed
 * beside the options, and there is no `kind` field: a small model fills an
 * enum badly, and the card needs no such distinction.
 */

export const ASK_USER_TOOL = 'ask_user';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

export const DISMISSED_RESULT =
	'The user did not answer. Continue with your best judgement and say what you assumed.';

/**
 * The definition as an MCP tools/list entry. Nest serves it
 * (daemon/interaction-tools.mjs) only to a client that declared it can answer;
 * kept here so the schema and the parser below cannot drift apart.
 */
export const ASK_USER_DEFINITION = Object.freeze({
	name: ASK_USER_TOOL,
	description:
		'Ask the user a question and wait for the answer. Use it only when the request can be read two ways that lead to different work, and you cannot tell which from the conversation or from a tool. Not for permission, and not for anything a tool can find out. Offer 2 to 4 short options when the answers are predictable; the user can always type their own.',
	inputSchema: {
		type: 'object',
		properties: {
			question: { type: 'string', description: 'The question, in one or two sentences' },
			options: {
				type: 'array',
				items: { type: 'string' },
				minItems: MIN_OPTIONS,
				maxItems: MAX_OPTIONS,
				description: 'Optional: 2 to 4 short answers the user can pick from'
			},
			multi_select: {
				type: 'boolean',
				description: 'Optional: true if the user may pick more than one option'
			}
		},
		required: ['question']
	}
});

const USAGE =
	'ask_user takes {"question": "...", "options": ["...", "..."] (optional, 2 to 4), "multi_select": false (optional)}.';

/**
 * @param {string | undefined} raw the call's arguments, as the model wrote them
 * @returns {{ ok: true, request: import('./types').AskRequest } | { ok: false, error: string }}
 */
export function parseAskArguments(raw) {
	/** @type {any} */
	let args;
	try {
		args = JSON.parse((raw ?? '').trim() === '' ? '{}' : raw ?? '');
	} catch {
		return { ok: false, error: `Error: the arguments are not valid JSON. ${USAGE}` };
	}
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return { ok: false, error: `Error: the arguments must be an object. ${USAGE}` };
	}
	const question = typeof args.question === 'string' ? args.question.trim() : '';
	if (!question) return { ok: false, error: `Error: "question" is required. ${USAGE}` };

	/** @type {string[] | undefined} */
	let options;
	if (args.options !== undefined && args.options !== null) {
		if (!Array.isArray(args.options) || !args.options.every((/** @type {unknown} */ o) => typeof o === 'string')) {
			return { ok: false, error: `Error: "options" must be a list of strings. ${USAGE}` };
		}
		/** @type {string[]} */
		const given = args.options;
		options = [...new Set(given.map((o) => o.trim()).filter(Boolean))];
		if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: `Error: give ${MIN_OPTIONS} to ${MAX_OPTIONS} different options, or none for a free-text question. ${USAGE}`
			};
		}
	}
	if (args.multi_select !== undefined && typeof args.multi_select !== 'boolean') {
		return { ok: false, error: `Error: "multi_select" must be true or false. ${USAGE}` };
	}
	return {
		ok: true,
		request: { question, ...(options ? { options } : {}), multiSelect: args.multi_select === true }
	};
}

/**
 * The tool result the model reads.
 *
 * @param {import('./types').AskAnswer | null | undefined} answer null: dismissed
 * @returns {string}
 */
export function formatAskAnswer(answer) {
	const chosen = (answer?.chosen ?? []).map((c) => c.trim()).filter(Boolean);
	const text = (answer?.text ?? '').trim();
	if (chosen.length > 0 && text) return `The user chose: ${chosen.join(', ')}. They added: ${text}`;
	if (chosen.length > 0) return `The user chose: ${chosen.join(', ')}`;
	if (text) return `The user answered: ${text}`;
	return DISMISSED_RESULT;
}
