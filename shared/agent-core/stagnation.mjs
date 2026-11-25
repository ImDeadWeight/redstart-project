/**
 * agent-core/stagnation — noticing a run that has stopped getting anywhere,
 * and what to do about it.
 *
 * The exact-repeat guard (the same call, the same arguments, a fourth time
 * with no file changed in between) was the only check, and the first SvelteKit benchmark ("Crestline",
 * 2026-11-23) stalled twice without tripping it:
 *
 *   - Turn 1 THEORIZED: 115k characters of reasoning, "Actually, let me
 *     reconsider" 19 times, and `npx sv add vitest` failed four times with
 *     four different sets of flags. No two calls were identical.
 *   - Turn 2 LOOPED INSIDE ONE RESPONSE: the same five sentences about 59
 *     times, 45% of all its sentences repeats, until it was stopped by hand.
 *
 * So this module watches what a run does, round by round, and fires when one
 * of five patterns shows:
 *
 *   a  same failure      the same error (numbers, paths and line numbers
 *                        normalised away) 3 times in the recent rounds, or
 *                        the same command, whatever its flags, failing 3
 *                        times with no write in between. The exact-repeat
 *                        guard is the first rule of this one (check()).
 *   b  edit oscillation  a file written back to content it had before
 *                        (A → B → A)
 *   c  no progress       about 6 rounds with no new error, no applied write
 *                        and no newly read file
 *   d  reasoning loop    while one response streams: one sentence keeps
 *                        recurring, or most of the recent sentences repeat
 *   e  theorizing        reasoning keeps growing with no new evidence, or
 *                        keeps reversing itself ("actually, wait")
 *   f  argument loop     while a tool call's arguments stream: their tail is
 *                        one short stretch over and over. Ornith on Crestline
 *                        (2026-11-24, after the reasoning had ended) wrote
 *                        19k tokens into one call for ten minutes; nothing
 *                        reached the person, who saw "waiting on the model".
 *
 * A firing gets a recovery, more forceful each time in the same run:
 *
 *   1  a note to the model with the evidence and DEBUGGING_PROCEDURE
 *   2  the repeated action is refused until new evidence comes in (a read,
 *      diagnostics, a search, or a different command)
 *   3  the run stops, and the person gets a summary of what was tried
 *
 * When the host has a web tool (options.lookupTools), the notes also say to
 * look the failure up (lookup.mjs), a lookup is never what a level 2 refusal
 * blocks, and what one finds is new evidence.
 *
 * Pure: no I/O, no clock. The host says what each call was (its kind, what it
 * read and wrote); the monitor keeps the counts. That keeps it testable
 * against recorded transcripts, and the same in every host.
 *
 * Pinned by redstart-nest/scripts/test-agent-core.mjs.
 */

import { stuckLookupHint } from './lookup.mjs';

/** Starting thresholds: guesses checked against the Crestline transcript, to be tuned against the benchmark. */
export const STAGNATION_LIMITS = Object.freeze({
	/** a: the same exact call this many times is fine; the next is refused. */
	identicalCalls: 3,
	/** a: the same failure this many times in `failureRounds` rounds fires. */
	sameFailure: 3,
	failureRounds: 8,
	/** c: this many rounds in a row without anything new fires. */
	noProgressRounds: 6,
	/** d: the recent sentences of one response that are compared. A loop's
	 *  cycle can be long: Crestline turn 2's ran about 60 sentences. */
	sentenceWindow: 120,
	/** d: one sentence this many times in the window fires. */
	sentenceRepeats: 10,
	/** d: this share of the window repeating fires, once it holds `minSentences`.
	 *  Crestline turn 2 crosses it on the 4th of its 59 cycles; turn 1, which
	 *  did not loop, never passes 0.09. */
	repeatedShare: 0.4,
	minSentences: 72,
	/** d: shorter sentences ("Let me check this.") are too common to count. */
	minSentenceWords: 5,
	/** e: reasoning characters since the last new evidence that fire. */
	theorizingChars: 40_000,
	/** e: self-reversals since the last new evidence that fire, once there is
	 *  also `reversalChars` of reasoning: a model that says "wait" and
	 *  "actually" as a habit fit 8 into 4k characters (Ornith on Crestline,
	 *  2026-11-24) without being stuck. */
	reversals: 8,
	reversalChars: 15_000,
	/** f: the last `argumentSpan` characters of one call's arguments, all a
	 *  repeat of a stretch of at most `argumentPeriod` characters, fire. Real
	 *  file content does not repeat one stretch exactly for this long. */
	argumentSpan: 2_000,
	argumentPeriod: 400
});

/**
 * What the model is asked to do when it is stuck (agent-runtime plan item 4).
 * Modelled on what the person wrote mid-run in the Crestline transcript, and
 * short enough for a small model to follow.
 */
export const DEBUGGING_PROCEDURE =
	'Work from evidence: 1. Quote the failing observation exactly. 2. Name two hypotheses for it. ' +
	'3. Run the cheapest check that tells them apart. 4. Only then edit.';

/**
 * @typedef {'read' | 'search' | 'write' | 'command' | 'diagnostics' | 'other'} CallKind
 *
 * @typedef {object} CallInfo
 * @property {string} name the tool's name
 * @property {string} args its arguments, as sent
 * @property {CallKind} kind
 * @property {string} [signature] what makes two calls "the same call" (default name + args)
 * @property {string} [family] what makes two calls "the same action" (default actionFamily())
 *
 * @typedef {object} CallOutcome
 * @property {boolean} ok it succeeded (a rejected write or command is not a failure, and not ok)
 * @property {boolean} [rejected] the person declined it
 * @property {'repeated' | 'blocked'} [refused] check() refused it, so it did not run: an
 *   attempt of the same action, but no error of its own to compare
 * @property {string} [text] the result the model read
 * @property {string[]} [reads] paths it read
 * @property {{ path: string, before?: string, after: string }[]} [writes] files it wrote, when applied
 *
 * @typedef {'same-failure' | 'oscillation' | 'no-progress' | 'reasoning-loop' | 'theorizing' | 'argument-loop'} Detector
 *
 * @typedef {object} Recovery
 * @property {Detector} detector
 * @property {1 | 2 | 3} level 1 note, 2 refuse the repeated action, 3 stop
 * @property {string} evidence what was seen, in one or two sentences, in no
 *   one's voice: the model's note wraps it in "you", the person's summary in
 *   "I", and a host's timeline line shows it bare
 * @property {string} note what the model reads (levels 1 and 2), or the person (level 3)
 * @property {boolean} stop the run should end here
 * @property {string} [action] what is refused until new evidence (level 2): an
 *   action family, or `kind:<kind>` for a kind of call
 */

// --- normalisation ----------------------------------------------------------

/** Terminal colours, cursor codes, and their remains when the ESC was lost. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\[(?:\d{1,3};)*\d{1,3}m/g;
/** Box drawing and the decorations CLIs frame their output with. */
const DECORATION = /[─-▟⎯•◆◇●○✔✖✘✓·]+/g;
const FAILURE_WORDS =
	/\b(error|errors|failed|failure|fail|cannot|can't|could not|couldn't|not found|no such|exception|denied|invalid|unexpected|missing|refused|err!|does not|is not|undefined)\b/i;

/**
 * Lines that say a tool failed without saying why: Vite's "✗ Build failed in
 * 65ms" / "error during build:" / "Build failed with 1 error:", npm's
 * lifecycle trailer, "Command failed with exit code 1", a test runner's
 * "Test Files 1 failed". Three different Svelte errors each ended in "Build
 * failed in #ms" and read as one error three times (Crestline, 2026-11-24).
 */
const GENERIC_FAILURE =
	/^(?:\W*\s*)?(?:build failed(?: in \d+(?:\.\d+)?m?s| with \d+ errors?:?)|error during build:?|npm err(?:or|!) (?:code|path|command|errno|syscall|signal|a complete log|lifecycle)\b|(?:command|process) (?:failed|exited) with (?:exit )?code\b|test files? .*\bfailed\b|tests? .*\bfailed\b.*\bpassed\b|elifecycle\b|found \d+ errors?\b)/i;

/**
 * `text` without terminal codes and frame characters, trimmed per line.
 *
 * @param {string} text
 * @returns {string}
 */
export function plainText(text) {
	return String(text ?? '')
		.replace(ANSI, '')
		.replace(DECORATION, ' ')
		.split('\n')
		.map((l) => l.replace(/[ \t]+/g, ' ').trim())
		.join('\n');
}

/**
 * The line of a failure worth quoting: the first that says what went wrong,
 * else the last with words in it. Empty when nothing in it reads as text
 * (only a frame, a colour code). Used for the run log as well as below.
 *
 * @param {string} text
 * @returns {string}
 */
export function failureLine(text) {
	const lines = plainText(text)
		.split('\n')
		.filter((l) => /[a-z]{2}/i.test(l) && !/^(---|exit code\b)/i.test(l));
	// A tool's summary of its own failure ("✗ Build failed in 65ms") is the
	// same whatever went wrong: the line after it says what. Quoted only when
	// nothing more specific is there.
	const telling = lines.filter((l) => !GENERIC_FAILURE.test(l));
	const line =
		telling.find((l) => FAILURE_WORDS.test(l)) ?? lines.find((l) => FAILURE_WORDS.test(l)) ?? lines.at(-1) ?? '';
	return line.slice(0, 200);
}

/**
 * A failure as it compares with others: its failure line, lowercased, with
 * paths, file names, positions, numbers and quoted names replaced. The same
 * error at another line, in another file, is the same failure.
 *
 * @param {string} text
 * @returns {string} empty when there is nothing to compare
 */
export function errorSignature(text) {
	return failureLine(text)
		.toLowerCase()
		.replace(/[a-z]:[\\/][^\s'"`)\]]+/g, ' ')
		.replace(/(?:\.{0,2}\/)?[\w@.$+-]+(?:[\\/][\w@.$+()[\]-]+)+/g, ' ')
		.replace(/\b[\w.-]+\.(?:[cm]?[jt]sx?|svelte|vue|json|py|rs|go|java|cs|css|scss|html|md|toml|ya?ml)\b/g, ' ')
		.replace(/[:(]\d+(?:[:,]\d+)?\)?/g, '')
		.replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/g, '#')
		.replace(/\d+/g, '#')
		.replace(/(['"`])[^'"`]{1,80}\1/g, '<name>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160);
}

/** A signature that says something (two words), rather than "failed" alone. */
/** @param {string} signature */
function informative(signature) {
	return (signature.match(/[a-z]{2,}/g) ?? []).length >= 2;
}

/**
 * What makes two calls "the same action": for a command, its first three
 * words that are not flags or settings (`npx sv add vitest --no-install` and
 * `npx sv add vitest=usages:unit --yes` are both `npx sv add`); otherwise the
 * tool and the path it works on.
 *
 * @param {string} name
 * @param {string} args
 * @param {CallKind} kind
 */
export function actionFamily(name, args, kind) {
	const parsed = parseArgs(args);
	if (kind === 'command') {
		const full = typeof parsed.command === 'string' ? parsed.command : typeof parsed.cmd === 'string' ? parsed.cmd : String(args ?? '');
		// `cd app && npm run check` is npm run check: a leading cd says where,
		// not what. Without this every chained line was "cd app", and three
		// different commands read as one failing three times (Crestline,
		// 2026-11-24).
		const parts = full.split('&&').map((p) => p.trim());
		while (parts.length > 1 && /^(cd|chdir)(\s|$)/i.test(parts[0])) parts.shift();
		const line = parts.join(' && ');
		const words = [];
		for (const raw of line.split(/\s+/)) {
			if (/^(\||\|\||&&|;|>|>>|2>|2>&1|<)$/.test(raw) || /^\d?>/.test(raw)) break;
			const word = raw.replace(/^['"]|['"]$/g, '');
			if (!word || word.startsWith('-') || word.includes('=')) continue;
			words.push(word.toLowerCase());
			if (words.length === 3) break;
		}
		return `${name}:${words.join(' ')}`;
	}
	const target = ['path', 'file', 'file_path', 'filePath', 'target', 'url', 'pattern', 'query']
		.map((k) => parsed[k])
		.find((v) => typeof v === 'string');
	return target ? `${name}:${target}` : name;
}

/** @param {string} args @returns {Record<string, unknown>} */
function parseArgs(args) {
	try {
		const value = JSON.parse(args);
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/** @param {CallInfo} call @param {string} blocked */
function isBlocked(call, blocked) {
	if (blocked.startsWith('kind:')) return call.kind === blocked.slice(5);
	return (call.family ?? actionFamily(call.name, call.args, call.kind)) === blocked;
}

/** FNV-1a, 32 bits: enough to tell one version of a file from another. */
/** @param {string} text */
function hash(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/** A sentence as it compares with others: lowercased, punctuation gone.
 *  Digits stay: a list of errors at different lines is not a loop. */
/** @param {string} sentence */
function sentenceKey(sentence) {
	return sentence
		.toLowerCase()
		.replace(/[^\p{L}\d\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const REVERSAL = /^(actually|wait|hmm+|hold on|on second thought|no,? wait|let me reconsider|let me rethink|scratch that)\b/i;

/**
 * f: the stretch the end of `text` repeats, when its last `span` characters
 * are that stretch (at most `maxPeriod` long) over and over; else null.
 * A stretch of only whitespace counts: a run of spaces is a loop too.
 *
 * @param {string} text
 * @param {number} span
 * @param {number} maxPeriod
 * @returns {string | null}
 */
export function repeatingTail(text, span, maxPeriod) {
	if (text.length < span + 1) return null;
	const tail = text.slice(-span);
	for (let p = 1; p <= maxPeriod && p < span; p++) {
		// Periodic with period p: the tail equals itself shifted by p.
		if (text.slice(-span - p, -p) === tail) return tail.slice(-p);
	}
	return null;
}

// --- the texts ---------------------------------------------------------------

/** What the model reads instead of a repeated call's result (rule 1 of detector a). */
/** @param {string} name @param {number} times */
export function repeatedCallResult(name, times) {
	return (
		`Not run: you have called ${name} with these exact arguments ${times} times in this task, ` +
		'and the result will not change. Use what the earlier results said, try a different approach, ' +
		'or tell the user what is blocking you.'
	);
}

/** What the model reads instead of an action refused at recovery level 2. */
/** @param {string} action */
export function refusedActionResult(action) {
	return (
		(action.startsWith('kind:')
			? `Not run: ${describeAction(action)} are paused because they were not getting anywhere. ` +
				'Gather new evidence first: read the file involved, check diagnostics, or run a command. '
			: `Not run: this repeats what has already failed (${describeAction(action)}). ` +
				'Gather new evidence first: read the file involved, check diagnostics, search, or run a different command. ') +
		DEBUGGING_PROCEDURE
	);
}

/** `ys_run_command:npx sv add` reads as "npx sv add"; `kind:search` as "searches"; anything else as tool and target. */
/** @param {string} action */
function describeAction(action) {
	if (action.startsWith('kind:')) return KIND_PLURAL[action.slice(5)] ?? action.slice(5);
	const at = action.indexOf(':');
	if (at === -1) return action;
	const tool = action.slice(0, at);
	const target = action.slice(at + 1);
	if (!target) return tool;
	// A command's family is its words; anything else reads as tool and target.
	return /\s/.test(target) ? target : `${tool} ${target}`;
}

/** @type {Record<string, string>} */
const KIND_PLURAL = { read: 'reads', search: 'searches', write: 'writes', command: 'commands', diagnostics: 'diagnostics', other: 'those calls' };

/** What a level 2 refusal blocks for each detector without an action of its own. */
/** @type {Partial<Record<Detector, string>>} */
const BLOCKED_KIND = { 'no-progress': 'kind:search', theorizing: 'kind:write', 'reasoning-loop': 'kind:write' };

/**
 * @param {Recovery['level']} level @param {string} evidence @param {string} action
 * @param {string | null} lookup the web tool to name, if the host has one
 */
function modelNote(level, evidence, action, lookup) {
	const hint = lookup ? `${stuckLookupHint(lookup)} ` : '';
	if (level === 1) {
		return `[You seem to be stuck. ${evidence} Change approach. ${hint}${DEBUGGING_PROCEDURE}]`;
	}
	const search = lookup ? `, look it up with ${lookup}` : '';
	const ways = action === 'kind:search'
		? `read the file involved, check diagnostics${search}, or run a command`
		: `read the file involved, check diagnostics, search${search}, or run a different command`;
	return `[You are still stuck. ${evidence} Until you have new evidence, ${describeAction(action)} will not run: ${ways}. ${hint}${DEBUGGING_PROCEDURE}]`;
}

/**
 * The tool a call really runs: Nest's catalog dispatcher (call_tool) names it
 * in its arguments.
 *
 * @param {CallInfo} call
 */
function targetName(call) {
	if (call.name !== 'call_tool') return call.name;
	const name = parseArgs(call.args).name;
	return typeof name === 'string' ? name : call.name;
}

// --- the monitor ---------------------------------------------------------------

/**
 * One monitor per run (one user message and everything the agent does for it).
 *
 * Host order, per round: startResponse() → reasoning(chunk)… and
 * toolArguments(index, chunk)… as the response streams → for each call,
 * check() before it runs and record() after → and endRound() before the next
 * request. Any of reasoning(), toolArguments() and endRound() can return a
 * Recovery for the host to act on (for the two that watch a stream: drop the
 * response, and ask again with the note).
 *
 * @param {Partial<typeof STAGNATION_LIMITS>} [overrides]
 * @param {{ lookupTools?: readonly string[] }} [options] lookupTools: the web
 *   tools the model has (web_search, web_fetch), first named in the notes
 */
export function createStagnationMonitor(overrides = {}, options = {}) {
	const limits = { ...STAGNATION_LIMITS, ...overrides };
	const lookupTools = options.lookupTools ?? [];
	const lookup = lookupTools[0] ?? null;
	/** @param {CallInfo} call */
	const isLookup = (call) => lookupTools.includes(targetName(call));
	/** Lookups already made: a new one is new evidence.
	 *  @type {Set<string>} */
	const lookedUp = new Set();

	let round = 1;
	/** How often each exact call has been asked for, since the files last
	 *  changed (writes themselves: over the whole run). */
	const callCounts = new Map();
	/** @type {{ round: number, family: string, signature: string, wroteBefore: number }[]} */
	let failures = [];
	/** Writes applied so far: a failure records how many came before it. */
	let writesApplied = 0;
	const seenErrors = new Set();
	const readPaths = new Set();
	/** Commands (by family) that have succeeded. */
	const succeeded = new Set();
	/** Every version of each file this run has seen, oldest first. */
	const versions = new Map();
	/** @type {string | null} the evidence of an oscillation seen in this round */
	let oscillation = null;
	let oscillationPath = '';
	let progressThisRound = false;
	let roundsWithoutProgress = 0;
	/** What has been tried, newest last, for the level 3 summary. */
	/** @type {string[]} */
	const tried = [];

	// d: the current response's recent sentences.
	/** @type {string[]} */
	let sentences = [];
	let partial = '';
	// e: since the last new evidence.
	let charsSinceEvidence = 0;
	let reversals = 0;
	// f: the current response's tool call arguments, by call index, and how
	// long each was when it was last checked.
	/** @type {Map<number, { text: string, checked: number }>} */
	let callArgs = new Map();

	let level = 0;
	/** Since the last firing: a write applied, and a command that newly worked.
	 *  Both, and the run made real headway: the next firing starts over at 1. */
	let wroteSinceFiring = false;
	let newSuccessSinceFiring = false;
	/** @type {string | null} the action refused until new evidence */
	let blocked = null;
	/** @type {Recovery[]} */
	const firings = [];

	const progress = () => {
		progressThisRound = true;
		charsSinceEvidence = 0;
		reversals = 0;
	};

	/**
	 * @param {Detector} detector
	 * @param {string} evidence
	 * @param {string} [action]
	 * @returns {Recovery}
	 */
	const fire = (detector, evidence, action) => {
		// Real headway since the last firing (it wrote something, and a command
		// that had not worked now does): this is a new problem, not the old
		// one again. Also what keeps a firing that was wrong from making the
		// next one harsher.
		if (wroteSinceFiring && newSuccessSinceFiring) level = 0;
		wroteSinceFiring = false;
		newSuccessSinceFiring = false;
		level = Math.min(3, level + 1);
		const lvl = /** @type {Recovery['level']} */ (level);
		const refuse = action ?? BLOCKED_KIND[detector] ?? 'kind:write';
		// Each detector starts counting again: the next firing must be earned.
		failures = [];
		roundsWithoutProgress = 0;
		charsSinceEvidence = 0;
		reversals = 0;
		sentences = [];
		oscillation = null;
		/** @type {Recovery} */
		const recovery =
			lvl === 3
				? { detector, level: lvl, evidence, note: stopSummary(evidence), stop: true }
				: { detector, level: lvl, evidence, note: modelNote(lvl, evidence, refuse, lookup), stop: false };
		if (lvl === 2) {
			blocked = refuse;
			recovery.action = refuse;
		}
		firings.push(recovery);
		return recovery;
	};

	/** @param {string} evidence */
	const stopSummary = (evidence) => {
		const recent = tried.slice(-6);
		const lines = recent.length ? `\n\nWhat was tried most recently:\n${recent.map((t) => `- ${t}`).join('\n')}` : '';
		const earlier = firings.map((f) => f.evidence);
		const notes = earlier.length ? `\n\nEarlier in this run: ${earlier.join(' ')}` : '';
		return (
			`I stopped because I was not making progress. ${evidence}${notes}${lines}\n\n` +
			// Ends in a question: the person answers in the next message, and a
			// host's plan check (update-plan.mjs endsInQuestion) waits for it.
			'A hint about the cause, or a different approach, would help. How would you like me to continue?'
		);
	};

	/** a: the same failure, by error text or by action. */
	const sameFailure = () => {
		const recent = failures.filter((f) => f.round > round - limits.failureRounds);
		const last = recent.at(-1);
		if (!last) return null;
		if (informative(last.signature)) {
			const same = recent.filter((f) => f.signature === last.signature);
			if (same.length >= limits.sameFailure) {
				return {
					evidence: `The same error came back ${same.length} times: "${last.signature}".`,
					action: last.family
				};
			}
		}
		// The same action failing with nothing written in between: retries
		// with other flags, which change nothing the error is about.
		const sameAction = recent.filter((f) => f.family === last.family && f.wroteBefore === last.wroteBefore);
		if (sameAction.length >= limits.sameFailure) {
			return {
				evidence: `${describeAction(last.family)} failed ${sameAction.length} times in a row, with different arguments and no change in between.`,
				action: last.family
			};
		}
		return null;
	};

	return {
		limits,

		/** A new response begins (each request, a retry included). */
		startResponse() {
			sentences = [];
			partial = '';
			callArgs = new Map();
		},

		/**
		 * As a tool call's arguments stream (f). `index` is the call's place
		 * in the response, as the stream numbers it; `kind`, when the host
		 * knows it, is what a level 2 refusal pauses.
		 *
		 * @param {number} index
		 * @param {string} chunk
		 * @param {CallKind} [kind]
		 * @returns {Recovery | null}
		 */
		toolArguments(index, chunk, kind) {
			const entry = callArgs.get(index) ?? { text: '', checked: 0 };
			entry.text += chunk;
			callArgs.set(index, entry);
			// Checked every few hundred characters, not on every delta.
			if (entry.text.length - entry.checked < 256) return null;
			entry.checked = entry.text.length;
			const unit = repeatingTail(entry.text, limits.argumentSpan, limits.argumentPeriod);
			if (unit === null) return null;
			const shown = unit.trim() ? `"${unit.trim().slice(0, 60)}"` : 'whitespace';
			return fire(
				'argument-loop',
				`The last reply was dropped: its tool call's arguments had reached ${entry.text.length} characters, ` +
					`the last ${limits.argumentSpan} of them ${shown} over and over. Send a short, complete call; ` +
					'write a long file in parts.',
				kind ? `kind:${kind}` : undefined
			);
		},

		/**
		 * Before a call runs: refuse it, or let it run (null). Counts it.
		 *
		 * @param {CallInfo} call
		 * @returns {{ refuse: string, reason: 'repeated' | 'blocked' } | null}
		 */
		check(call) {
			const exact = call.signature ?? `${call.name}\u0000${String(call.args ?? '').trim()}`;
			// A check run again after an edit is a new question with a new
			// answer, not a repeat: `npm run check` after a fix was refused
			// as one, and the run went on without it (Crestline, 2026-11-24).
			// The same write over and over is still a repeat, edits or not.
			const signature = call.kind === 'write' ? exact : `${exact}\u0000${writesApplied}`;
			const times = (callCounts.get(signature) ?? 0) + 1;
			callCounts.set(signature, times);
			if (times > limits.identicalCalls) {
				return { refuse: repeatedCallResult(call.name, times - 1), reason: 'repeated' };
			}
			// Looking it up is what the notes ask for: never refused as blocked.
			if (blocked && !isLookup(call) && isBlocked(call, blocked)) {
				return { refuse: refusedActionResult(blocked), reason: 'blocked' };
			}
			return null;
		},

		/**
		 * After a call ran (or was refused).
		 *
		 * @param {CallInfo} call
		 * @param {CallOutcome} outcome
		 */
		record(call, outcome) {
			const family = call.family ?? actionFamily(call.name, call.args, call.kind);
			const text = outcome.text ?? '';
			if (outcome.ok) {
				tried.push(`${describeAction(family)}: ok`);
				// A command that works and had not been run before is news too.
				if (call.kind === 'command' && !succeeded.has(family)) {
					succeeded.add(family);
					newSuccessSinceFiring = true;
					progress();
				}
				// New evidence lifts a refusal: a read, diagnostics, a search
				// (unless searching is what is refused), or another command.
				// A web lookup is new evidence whatever is refused; a new one is progress.
				if (isLookup(call)) {
					const key = `${targetName(call)}\u0000${String(call.args ?? '').trim()}`;
					if (!lookedUp.has(key)) {
						lookedUp.add(key);
						progress();
					}
				}
				const gathers = isLookup(call) || call.kind === 'read' || call.kind === 'diagnostics' ||
					(call.kind === 'search' && blocked !== 'kind:search') ||
					(call.kind === 'command' && (blocked === null || !isBlocked(call, blocked)));
				if (gathers) blocked = null;
			} else if (outcome.refused) {
				// Asked for again although refused: the same action, with no new
				// error (the refusal's own text is not one).
				failures.push({ round, family, signature: '', wroteBefore: writesApplied });
				tried.push(`${describeAction(family)}: not run (${outcome.refused === 'repeated' ? 'a repeat' : 'paused'})`);
			} else if (!outcome.rejected) {
				const signature = errorSignature(text);
				failures.push({ round, family, signature, wroteBefore: writesApplied });
				tried.push(`${describeAction(family)}: failed${signature ? ` (${failureLine(text).slice(0, 100)})` : ''}`);
				if (signature && informative(signature) && !seenErrors.has(signature)) {
					seenErrors.add(signature);
					progress();
				}
			}
			for (const path of outcome.reads ?? []) {
				if (!readPaths.has(path)) {
					readPaths.add(path);
					progress();
				}
			}
			for (const write of outcome.writes ?? []) {
				writesApplied++;
				wroteSinceFiring = true;
				progress();
				const list = versions.get(write.path) ?? (write.before !== undefined ? [hash(write.before)] : []);
				const next = hash(write.after);
				// Back to a version before the current one: A → B → A.
				if (list.slice(0, -1).includes(next) && list.at(-1) !== next) {
					oscillation = `${write.path} was written back to a version it had before, undoing the change in between.`;
					oscillationPath = `${call.name}:${write.path}`;
				}
				list.push(next);
				versions.set(write.path, list);
			}
		},

		/**
		 * A chunk of the streaming reasoning (detector d, and e's count).
		 *
		 * @param {string} chunk
		 * @returns {Recovery | null}
		 */
		reasoning(chunk) {
			charsSinceEvidence += chunk.length;
			partial += chunk;
			const pieces = partial.split(/(?<=[.!?])\s+|\n+/);
			partial = pieces.pop() ?? '';
			for (const piece of pieces) {
				const sentence = piece.trim();
				if (REVERSAL.test(sentence)) reversals++;
				const key = sentenceKey(sentence);
				if (key.split(' ').length < limits.minSentenceWords) continue;
				sentences.push(key);
				if (sentences.length > limits.sentenceWindow) sentences.shift();
				const counts = new Map();
				let top = 0;
				for (const s of sentences) {
					const n = (counts.get(s) ?? 0) + 1;
					counts.set(s, n);
					if (n > top) top = n;
				}
				const repeats = sentences.length - counts.size;
				const share = repeats / sentences.length;
				if (top >= limits.sentenceRepeats || (sentences.length >= limits.minSentences && share >= limits.repeatedShare)) {
					const example = [...counts].sort((x, y) => y[1] - x[1])[0][0];
					return fire(
						'reasoning-loop',
						`The reasoning is going in a circle: of the last ${sentences.length} sentences, ${repeats} repeat earlier ones (for example "${example.slice(0, 80)}", ${top} times).`
					);
				}
			}
			return null;
		},

		/**
		 * The round's calls are done: does a pattern show? Call before the next
		 * request, not after an answer with no calls.
		 *
		 * @returns {Recovery | null}
		 */
		endRound() {
			if (!progressThisRound) roundsWithoutProgress++;
			else roundsWithoutProgress = 0;
			progressThisRound = false;
			/** @type {Recovery | null} */
			let recovery = null;
			const failure = sameFailure();
			if (failure) recovery = fire('same-failure', failure.evidence, failure.action);
			else if (oscillation) recovery = fire('oscillation', oscillation, oscillationPath);
			else if (charsSinceEvidence >= limits.theorizingChars || (reversals >= limits.reversals && charsSinceEvidence >= limits.reversalChars)) {
				recovery = fire(
					'theorizing',
					`${Math.round(charsSinceEvidence / 1000)}k characters of reasoning${reversals ? `, with ${reversals} changes of mind,` : ''} since anything new came back from a tool.`
				);
			} else if (roundsWithoutProgress >= limits.noProgressRounds) {
				recovery = fire('no-progress', `The last ${roundsWithoutProgress} rounds found no new error, read no new file and wrote nothing.`);
			}
			round++;
			return recovery;
		},

		/** Every recovery so far, oldest first (the run log, the benchmark record). */
		get firings() {
			return [...firings];
		},

		/** The current recovery level: 0 until something fired. */
		get level() {
			return level;
		}
	};
}
