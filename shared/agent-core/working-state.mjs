/**
 * agent-core/working-state — what a run has learned, kept for when the
 * context window can no longer hold the results it learned it from.
 *
 * A long run fills the window with tool results, and the host trims the
 * oldest: chat-ui and the task runner summarise them (compaction.mjs, one
 * model call), Yellowscript replaces each with a one-line stub. Either way
 * what those results showed is gone, and a small model that has lost them
 * starts over: reads the same files, reruns the same failing command.
 *
 * This record is built as the run goes, with no model call, from what the
 * host already knows about each call:
 *
 *   files changed   path → created / changed / deleted
 *   open errors     each distinct failure (stagnation.mjs's signature), the
 *                   line that says it, where it came from and how often;
 *                   closed when the same action later succeeds
 *   discoveries     what each read and search found, with where it came from
 *   notes           decisions the model wrote down (Yellowscript's ys_note)
 *   the plan        the open steps of update_plan
 *
 * render() is the text that stands in for what was trimmed, sent at the tail
 * of each request once trimming has started (so the history the server has
 * cached is not changed). Kept short: it rides on every request.
 *
 * Pure: no I/O. Pinned by redstart-nest/scripts/test-agent-core.mjs.
 */

import { actionFamily, errorSignature, failureLine } from './stagnation.mjs';

export const WORKING_STATE_HEADER = '[Working state of this run: what earlier results showed, kept after they were removed to fit the context window]';

/** The record's size on the wire, at most. */
export const WORKING_STATE_MAX_CHARS = 1_600;

/** How many of each list are kept, newest last. */
const KEEP = { discoveries: 8, errors: 5, fixed: 3, notes: 4, files: 12 };

/**
 * @typedef {import('./stagnation.mjs').CallInfo} CallInfo
 * @typedef {import('./stagnation.mjs').CallOutcome & { note?: string }} StateOutcome
 * @typedef {import('./types').PlanStep} PlanStep
 */

/** The first lines of a result that carry something, joined, for a discovery. */
/** @param {string} text */
function gist(text, lines = 2, chars = 140) {
	const kept = String(text ?? '')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => /[\p{L}\d]{2}/u.test(l) && !/^[[(]/.test(l));
	const joined = kept.slice(0, lines).join(' / ');
	return joined.length > chars ? `${joined.slice(0, chars - 1)}…` : joined;
}

/** `ys_grep:runes` → "ys_grep runes"; a command's family → the command. */
/** @param {string} family */
function where(family) {
	const at = family.indexOf(':');
	return at === -1 ? family : `${family.slice(0, at)} ${family.slice(at + 1)}`.trim();
}

/**
 * @param {{ maxChars?: number }} [options]
 */
export function createWorkingState(options = {}) {
	const maxChars = options.maxChars ?? WORKING_STATE_MAX_CHARS;
	/** @type {Map<string, 'created' | 'changed' | 'deleted'>} */
	const files = new Map();
	/** @type {Map<string, { line: string, from: string, family: string, count: number }>} */
	const errors = new Map();
	/** @type {string[]} */
	const fixed = [];
	/** @type {Map<string, string>} keyed by where it came from, so a reread replaces */
	const discoveries = new Map();
	/** @type {string[]} */
	const notes = [];
	/** @type {PlanStep[]} */
	let plan = [];

	/** @param {string[]} list @param {string} item @param {number} keep */
	const push = (list, item, keep) => {
		list.push(item);
		if (list.length > keep) list.splice(0, list.length - keep);
	};

	return {
		/**
		 * One call and what came of it.
		 *
		 * @param {CallInfo} call
		 * @param {StateOutcome & { writes?: { path: string, isNew?: boolean, isDeleted?: boolean }[] }} outcome
		 */
		observe(call, outcome) {
			const family = call.family ?? actionFamily(call.name, call.args, call.kind);
			const text = outcome.text ?? '';
			if (outcome.note) push(notes, outcome.note.replace(/\s+/g, ' ').slice(0, 200), KEEP.notes);
			if (outcome.rejected) return;
			if (!outcome.ok) {
				const signature = errorSignature(text) || family;
				const known = errors.get(signature);
				if (known) known.count++;
				else errors.set(signature, { line: failureLine(text) || 'failed', from: where(family), family, count: 1 });
				return;
			}
			// The same action now works: what it failed with is fixed.
			for (const [signature, e] of errors) {
				if (e.family === family) {
					errors.delete(signature);
					push(fixed, `${e.line} (${e.from})`, KEEP.fixed);
				}
			}
			for (const w of outcome.writes ?? []) {
				const before = files.get(w.path);
				if (w.isDeleted) {
					if (before === 'created') files.delete(w.path);
					else files.set(w.path, 'deleted');
				} else if (w.isNew && before !== 'deleted') files.set(w.path, 'created');
				else if (before !== 'created') files.set(w.path, 'changed');
			}
			if (call.kind === 'read' || call.kind === 'search' || call.kind === 'diagnostics') {
				const found = gist(text);
				if (found) {
					discoveries.delete(family);
					discoveries.set(family, found);
					while (discoveries.size > KEEP.discoveries) discoveries.delete(/** @type {string} */ (discoveries.keys().next().value));
				}
			}
		},

		/** @param {readonly PlanStep[] | null | undefined} steps update_plan's steps */
		setPlan(steps) {
			plan = Array.isArray(steps) ? steps.map((s) => ({ ...s })) : [];
		},

		/** Nothing recorded yet. */
		get empty() {
			return files.size === 0 && errors.size === 0 && discoveries.size === 0 && notes.length === 0 && fixed.length === 0;
		},

		/**
		 * The record as the model reads it, at most `maxChars`. The least
		 * useful lines go first when it is too long: old discoveries, then
		 * fixed errors.
		 *
		 * @returns {string}
		 */
		render() {
			/** @param {string} title @param {string[]} lines */
			const section = (title, lines) => (lines.length ? [`${title}:`, ...lines.map((l) => `- ${l}`)] : []);
			/** @param {string} state */
			const fileLines = (state) => [...files].filter(([, s]) => s === state).map(([p]) => p);
			const changed = ['created', 'changed', 'deleted']
				.map((state) => /** @type {[string, string[]]} */ ([state, fileLines(state).slice(-KEEP.files)]))
				.filter(([, names]) => names.length)
				.map(([state, names]) => `${state} ${names.join(', ')}`);
			const open = [...errors.values()].slice(-KEEP.errors).map((e) => `${e.line} (${e.from}${e.count > 1 ? `, ${e.count} times` : ''})`);
			let found = [...discoveries].map(([from, gistText]) => `${where(from)}: ${gistText}`);
			let fixedLines = [...fixed];
			const open_steps = plan
				.filter((s) => s.status === 'pending' || s.status === 'in_progress')
				.map((s) => `${s.text}${s.status === 'in_progress' ? ' (in progress)' : ''}`);

			const build = () =>
				[
					WORKING_STATE_HEADER,
					...section('Files changed', changed),
					...section('Open errors', open),
					...section('Fixed', fixedLines),
					...section('Found', found),
					...section('Notes', notes),
					...section('Plan, still open', open_steps)
				].join('\n');
			let text = build();
			while (text.length > maxChars && found.length > 0) {
				found = found.slice(1);
				text = build();
			}
			while (text.length > maxChars && fixedLines.length > 0) {
				fixedLines = fixedLines.slice(1);
				text = build();
			}
			return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
		}
	};
}
