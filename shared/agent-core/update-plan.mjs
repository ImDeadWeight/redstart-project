/**
 * agent-core/update-plan — the update_plan tool, resolved by the host (plan
 * §4, 1.2; decision D4).
 *
 * The model keeps a short checklist for a task with several deliverables. The
 * host stores it (chat-ui on the conversation record, the bench in the run);
 * the loop does the two things that make it worth having on a small model:
 *
 * - **The plan rides at the tail of the request.** While steps are open, each
 *   request ends with a short note listing them (planTailNote), sent with that
 *   request only and never added to the history. Not in the system prompt:
 *   a step changing would rewrite the prompt's head and throw away the KV
 *   cache every time. At the tail, the goal survives compaction and a long
 *   tool result.
 * - **One completion check.** A turn that answers with open steps left gets
 *   one more turn with the nudge below. Once per flow, never a loop.
 *
 * The whole list is sent every time: a small model handles "send the list
 * again" better than patch operations.
 */

export const UPDATE_PLAN_TOOL = 'update_plan';
export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'done', 'skipped']);
export const MAX_PLAN_STEPS = 20;
const MAX_STEP_CHARS = 300;

export const UPDATE_PLAN_DEFINITION = Object.freeze({
	name: UPDATE_PLAN_TOOL,
	description:
		'Keep a short checklist for a task with three or more distinct steps or deliverables. Send the whole list every time: first with every step "pending", then again as you work, marking one "in_progress", finished ones "done", and ones you decide against "skipped" with a note saying why. Not for a simple question.',
	inputSchema: {
		type: 'object',
		properties: {
			steps: {
				type: 'array',
				description: 'Every step, in order',
				items: {
					type: 'object',
					properties: {
						text: { type: 'string', description: 'The step, in a few words' },
						status: { type: 'string', enum: [...PLAN_STATUSES] },
						note: { type: 'string', description: 'Optional: why it was skipped, or what came of it' }
					},
					required: ['text', 'status']
				}
			}
		},
		required: ['steps']
	}
});

const USAGE =
	'update_plan takes {"steps": [{"text": "...", "status": "pending" | "in_progress" | "done" | "skipped", "note": "..." (optional)}]}, the whole list every time.';

/**
 * Check a list of steps, from the model or from a client's PUT.
 *
 * @param {unknown} steps
 * @returns {{ ok: true, steps: import('./types').PlanStep[] } | { ok: false, error: string }}
 */
export function validatePlanSteps(steps) {
	if (!Array.isArray(steps) || steps.length === 0) {
		return { ok: false, error: `Error: "steps" must be a non-empty list. ${USAGE}` };
	}
	if (steps.length > MAX_PLAN_STEPS) {
		return { ok: false, error: `Error: a plan has at most ${MAX_PLAN_STEPS} steps. ${USAGE}` };
	}
	/** @type {import('./types').PlanStep[]} */
	const out = [];
	for (const [i, step] of steps.entries()) {
		const s = /** @type {any} */ (step);
		const text = typeof s?.text === 'string' ? s.text.trim() : '';
		if (!text) return { ok: false, error: `Error: step ${i + 1} has no "text". ${USAGE}` };
		if (text.length > MAX_STEP_CHARS) {
			return { ok: false, error: `Error: step ${i + 1} is longer than ${MAX_STEP_CHARS} characters. Say it in a few words. ${USAGE}` };
		}
		if (!PLAN_STATUSES.includes(s.status)) {
			return { ok: false, error: `Error: step ${i + 1} has status ${JSON.stringify(s.status ?? null)}. ${USAGE}` };
		}
		if (s.note !== undefined && s.note !== null && typeof s.note !== 'string') {
			return { ok: false, error: `Error: step ${i + 1}'s "note" must be text. ${USAGE}` };
		}
		const note = typeof s.note === 'string' ? s.note.trim().slice(0, MAX_STEP_CHARS) : '';
		out.push({ text, status: s.status, ...(note ? { note } : {}) });
	}
	return { ok: true, steps: out };
}

/**
 * @param {string | undefined} raw the call's arguments, as the model wrote them
 * @returns {{ ok: true, steps: import('./types').PlanStep[] } | { ok: false, error: string }}
 */
export function parsePlanArguments(raw) {
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
	return validatePlanSteps(args.steps);
}

/**
 * @param {readonly import('./types').PlanStep[] | null | undefined} steps
 * @returns {import('./types').PlanStep[]}
 */
export function openSteps(steps) {
	return (steps ?? []).filter((s) => s.status === 'pending' || s.status === 'in_progress');
}

/**
 * Are two plans the same steps, in the same order, with the same states and notes?
 *
 * @param {readonly import('./types').PlanStep[] | null | undefined} a
 * @param {readonly import('./types').PlanStep[] | null | undefined} b
 */
export function samePlan(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	return a.every(
		(s, i) => s.text === b[i].text && s.status === b[i].status && (s.note ?? '') === (b[i].note ?? '')
	);
}

/**
 * The tool result the model reads after saving.
 *
 * `unchanged`: the call repeated the plan it already had. Said plainly, with
 * the step to do instead: in the live test (2026-11-12) Ornith, read
 * "Plan saved. Next open step: Delete test-a.txt." after each identical
 * update_plan and called it again, two per turn, for three minutes, never
 * deleting anything.
 *
 * @param {readonly import('./types').PlanStep[]} steps
 * @param {{ unchanged?: boolean }} [opts]
 */
export function formatPlanResult(steps, { unchanged = false } = {}) {
	const next = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status === 'pending');
	if (unchanged) {
		return next
			? `Nothing changed: the plan already says this. Do the next open step now ("${next.text}") with the tool it needs, and call update_plan again only when a step's status changes.`
			: 'Nothing changed: every step was already done or skipped. Give your answer.';
	}
	return next ? `Plan saved. Next open step: ${next.text}.` : 'All steps are done or skipped.';
}

const MARK = { pending: '[ ]', in_progress: '[>]', done: '[x]', skipped: '[-]' };

/** @param {readonly import('./types').PlanStep[]} steps */
function planLines(steps) {
	return steps
		.map((s, i) => `${i + 1}. ${MARK[s.status]} ${s.text}${s.note ? ` (${s.note})` : ''}`)
		.join('\n');
}

/**
 * The note at the tail of a request while steps are open, or null when there
 * is none. Marked as automatic so the model does not read it as the user
 * speaking again.
 *
 * @param {readonly import('./types').PlanStep[] | null | undefined} steps
 * @returns {string | null}
 */
export function planTailNote(steps) {
	if (!steps || openSteps(steps).length === 0) return null;
	// "when a step's status changes", not "keep it current": the bare
	// instruction, sent with every request, read to Ornith as "call
	// update_plan now", after every update (live test, 2026-11-12).
	return `[Automatic note, not from the user] Current plan ([x] done, [>] in progress, [ ] pending, [-] skipped):\n${planLines(steps)}\nCall update_plan only when a step's status changes.`;
}

/** How the completion nudge starts, so a host can tell it from the plan note. */
export const NUDGE_PREFIX = '[Automatic note, not from the user] These steps are still open:';

/**
 * Does the reply end by asking the person something? Its last non-empty line
 * ends in a question mark (markdown emphasis or a closing bracket after it
 * allowed). The completion check skips such a reply: it is waiting for the
 * person, and nudging it to "finish the steps" pushes it to answer its own
 * question (live test D, 2026-11-12: Ornith asked for the rule in text, was
 * nudged, and recovered only by asking again with ask_user). The bench uses
 * the same test for --text-asks.
 *
 * @param {string | null | undefined} text
 */
export function endsInQuestion(text) {
	const lines = String(text ?? '')
		.trim()
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.length > 0 && /\?[*_)"'\s]*$/.test(lines.at(-1) ?? '');
}

/**
 * The one completion check: the turn answered, but steps are still open.
 *
 * @param {readonly import('./types').PlanStep[]} steps
 */
export function completionNudge(steps) {
	const open = openSteps(steps);
	return `${NUDGE_PREFIX}\n${open
		.map((s) => `- ${s.text}`)
		.join('\n')}\nDo them, or mark each skipped with a reason using update_plan, then answer.`;
}
