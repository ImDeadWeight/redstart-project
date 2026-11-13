/**
 * agent-core/ask-user — the ask_user tool, resolved by the host (plan §4,
 * 1.1; decision D4; several questions in one call, D43).
 *
 * The model calls ask_user when two readings of a request lead to different
 * work. Nothing on the server can answer it: the host asks the person (a
 * card in chat-ui, a scripted answer in the bench, a parked task in the
 * daemon runtime) through the `ask` port, and the loop gives the model the
 * answer as the tool result. This file is the part every host shares: the
 * argument check and the result wording, so the model reads the same
 * sentence whichever host answered.
 *
 * The schema is deliberately small. A free-text answer is always allowed
 * beside the options, and there is no `kind` field: a small model fills an
 * enum badly, and the card needs no such distinction.
 *
 * Two forms are accepted. The flat one, `{question, options, multi_select}`,
 * is the original and stays the one the description leads with: a small
 * model that never learns the list loses nothing. `questions` is a list of
 * the same objects, 1 to 4, for a request with several open points; they are
 * shown on one card and answered together. Whichever form the model used,
 * the parsed request is always `{ questions: [...] }`, so no host has two
 * shapes to handle. A one-question request reads back exactly as before.
 */

export const ASK_USER_TOOL = 'ask_user';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_QUESTIONS = 4;

export const DISMISSED_RESULT =
	'The user did not answer. Continue with your best judgement and say what you assumed.';

const QUESTION_PROPERTIES = Object.freeze({
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
});

/**
 * The definition as an MCP tools/list entry. Nest serves it
 * (daemon/interaction-tools.mjs) only to a client that declared it can answer;
 * kept here so the schema and the parser below cannot drift apart.
 *
 * Nothing is `required`: a call carries either `question` or `questions`,
 * and the parser says which is missing. (An anyOf would say it in the schema,
 * but not every grammar converter a local server uses handles one.)
 */
export const ASK_USER_DEFINITION = Object.freeze({
	name: ASK_USER_TOOL,
	description:
		'Ask the user and wait for the answer. Use it when the answer would change what you produce: the request can be read two ways that lead to different work, a choice only the user can make is open (such as level, scope or format) and a sensible default could well be wrong, or the user asked you to ask. Not for permission, and not for anything the conversation or a tool already tells you. Offer 2 to 4 short options when the answers are predictable; the user can always type their own. If you need several things, ask them together in one call with "questions" (up to 4, each with a short "header") instead of one call after another.',
	inputSchema: {
		type: 'object',
		properties: {
			...QUESTION_PROPERTIES,
			questions: {
				type: 'array',
				minItems: 1,
				maxItems: MAX_QUESTIONS,
				description:
					'Optional, instead of "question": up to 4 questions to ask together, each with its own options',
				items: {
					type: 'object',
					properties: {
						header: {
							type: 'string',
							description: 'Optional: a one to three word label for this question, such as "Level"'
						},
						...QUESTION_PROPERTIES
					},
					required: ['question']
				}
			}
		}
	}
});

/** A tab label longer than this is cut (the card's tab bar has to fit a phone). */
export const MAX_HEADER_CHARS = 24;

const USAGE =
	'ask_user takes {"question": "...", "options": ["...", "..."] (optional, 2 to 4), "multi_select": false (optional)}, or {"questions": [ ...up to 4 objects of that shape... ]}.';

/**
 * One question object, checked. `where` names it in an error ("" for the
 * flat form, "questions[2]: " for an item).
 *
 * @param {any} item
 * @param {string} where
 * @returns {{ ok: true, question: import('./types').AskQuestion } | { ok: false, error: string }}
 */
function parseQuestion(item, where) {
	// A list of bare strings is a list of free-text questions: a small model
	// writes it that way, and nothing is lost by taking it.
	if (typeof item === 'string') item = { question: item };
	if (typeof item !== 'object' || item === null || Array.isArray(item)) {
		return { ok: false, error: `Error: ${where}each question must be an object. ${USAGE}` };
	}
	const question = typeof item.question === 'string' ? item.question.trim() : '';
	if (!question) return { ok: false, error: `Error: ${where}"question" is required. ${USAGE}` };

	/** @type {string[] | undefined} */
	let options;
	if (item.options !== undefined && item.options !== null) {
		if (!Array.isArray(item.options) || !item.options.every((/** @type {unknown} */ o) => typeof o === 'string')) {
			return { ok: false, error: `Error: ${where}"options" must be a list of strings. ${USAGE}` };
		}
		/** @type {string[]} */
		const given = item.options;
		options = [...new Set(given.map((o) => o.trim()).filter(Boolean))];
		if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: `Error: ${where}give ${MIN_OPTIONS} to ${MAX_OPTIONS} different options, or none for a free-text question. ${USAGE}`
			};
		}
	}
	if (item.multi_select !== undefined && typeof item.multi_select !== 'boolean') {
		return { ok: false, error: `Error: ${where}"multi_select" must be true or false. ${USAGE}` };
	}
	// A label is a nicety: a wrong type or an empty one is dropped, not an
	// error the model has to spend a turn on. Only the list form shows it.
	const header =
		typeof item.header === 'string' ? item.header.trim().replace(/\s+/g, ' ').slice(0, MAX_HEADER_CHARS).trim() : '';
	return {
		ok: true,
		question: {
			...(header && where ? { header } : {}),
			question,
			...(options ? { options } : {}),
			multiSelect: item.multi_select === true
		}
	};
}

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

	const listGiven = args.questions !== undefined && args.questions !== null;
	if (!listGiven) {
		const one = parseQuestion(args, '');
		return one.ok ? { ok: true, request: { questions: [one.question] } } : one;
	}

	if (!Array.isArray(args.questions)) {
		return { ok: false, error: `Error: "questions" must be a list. ${USAGE}` };
	}
	/** @type {any[]} */
	const items = [...args.questions];
	// Both forms at once: the flat question comes first, unless the list
	// already has it.
	const flat = typeof args.question === 'string' ? args.question.trim() : '';
	if (flat && !items.some((i) => (typeof i === 'string' ? i : i?.question)?.trim?.() === flat)) {
		items.unshift({ question: flat, options: args.options, multi_select: args.multi_select });
	}
	if (items.length === 0) return { ok: false, error: `Error: "questions" is empty. ${USAGE}` };

	/** @type {import('./types').AskQuestion[]} */
	const questions = [];
	for (let i = 0; i < items.length; i++) {
		const one = parseQuestion(items[i], `questions[${i + 1}]: `);
		if (!one.ok) return one;
		// The same question twice is asked once.
		if (!questions.some((q) => q.question === one.question.question)) questions.push(one.question);
	}
	if (questions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			error: `Error: ask at most ${MAX_QUESTIONS} questions in one call; keep the ones that change the work most. ${USAGE}`
		};
	}
	return { ok: true, request: { questions } };
}

/**
 * The sentence for one answered question, or null when it was not answered.
 *
 * @param {import('./types').AskReply | null | undefined} reply
 * @returns {string | null}
 */
function replySentence(reply) {
	const chosen = (reply?.chosen ?? []).map((c) => c.trim()).filter(Boolean);
	const text = (reply?.text ?? '').trim();
	if (chosen.length > 0 && text) return `The user chose: ${chosen.join(', ')}. They added: ${text}`;
	if (chosen.length > 0) return `The user chose: ${chosen.join(', ')}`;
	if (text) return `The user answered: ${text}`;
	return null;
}

/**
 * The tool result the model reads.
 *
 * For one question (or no request given), exactly the wording ask_user has
 * always had. For several: one numbered line per question. An answer with no
 * `answers` list to a several-question request came as one message (a
 * steering message typed instead of using the card): it is passed on as
 * that, not guessed into pieces.
 *
 * @param {import('./types').AskAnswer | null | undefined} answer null: dismissed
 * @param {import('./types').AskRequest} [request] the questions it answers
 * @returns {string}
 */
export function formatAskAnswer(answer, request) {
	const questions = request?.questions ?? [];
	if (questions.length <= 1) {
		const reply = answer?.answers ? answer.answers[0] : answer;
		return replySentence(reply) ?? DISMISSED_RESULT;
	}
	if (!answer) return DISMISSED_RESULT;
	if (!answer.answers) {
		const whole = replySentence(answer);
		return whole
			? `${whole.replace(/^The user (answered|chose)/, 'The user answered all your questions in one message. They $1')}`
			: DISMISSED_RESULT;
	}
	const sentences = questions.map((_, i) => replySentence(answer.answers?.[i]));
	if (sentences.every((s) => s === null)) return DISMISSED_RESULT;
	const lines = questions.map(
		(q, i) => `${i + 1}. ${q.question}\n   ${sentences[i] ?? 'The user did not answer this one.'}`
	);
	const skipped = sentences.some((s) => s === null)
		? '\nWhere they did not answer, continue with your best judgement and say what you assumed.'
		: '';
	return `The user answered your questions:\n${lines.join('\n')}${skipped}`;
}
