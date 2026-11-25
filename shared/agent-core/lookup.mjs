/**
 * agent-core/lookup — when a model should look something up rather than
 * reason from what it remembers.
 *
 * What a model knows about a library stops at its training data; the project
 * in front of it does not. The Crestline benchmark (2026-11-24) scaffolded
 * SvelteKit 3, where `$lib` became a package.json `#lib` import and
 * `.svelte-kit/tsconfig.json` is no longer generated. The model knew SvelteKit
 * 2, so it wrote `$lib/quote` and spent its turn hunting for the "missing"
 * tsconfig as if the sync were broken, with web_search in its tool list the
 * whole time. Nothing had told it that "this does not behave the way I know"
 * can mean "this is newer than I know", and that the web has the answer.
 *
 * So the core says it in three places, each only when the host has a web tool:
 *
 *   lookupGuidance()       a line for the system prompt
 *   newerVersionsNote()    a note on a result that shows dependency versions
 *                          past what a model is likely to know (package.json)
 *   stuckLookupHint()      the stagnation monitor's notes (stagnation.mjs),
 *                          which also never block a lookup and count what one
 *                          finds as new evidence
 *
 * Pure: no I/O. Pinned by redstart-nest/scripts/test-agent-core.mjs.
 */

/** The tools that look things up on the web, in the order a note names them. */
export const LOOKUP_TOOLS = Object.freeze(['web_search', 'web_fetch']);

/**
 * The newest major version of each package a model is likely to know well.
 * A version past it is probably newer than the model's training data. These
 * are what was current in early 2025, which is about where the local models
 * the benchmark runs stop. Raise an entry when the models move past it; an
 * entry that is too low only costs a note that says "check the docs".
 */
export const KNOWN_MAJORS = Object.freeze({
	'@sveltejs/kit': 2,
	'@sveltejs/vite-plugin-svelte': 5,
	'@sveltejs/adapter-auto': 4,
	svelte: 5,
	'svelte-check': 4,
	vite: 6,
	vitest: 3,
	typescript: 5,
	react: 19,
	'react-dom': 19,
	'react-router': 7,
	next: 15,
	vue: 3,
	nuxt: 3,
	'@angular/core': 19,
	astro: 5,
	tailwindcss: 4,
	eslint: 9,
	express: 5,
	jest: 29,
	'@playwright/test': 1,
	prisma: 6,
	'@prisma/client': 6,
	webpack: 5,
	zod: 3,
});

/**
 * The line for a system prompt, or '' when the host has no web tool.
 *
 * @param {readonly string[]} tools the tools the model has
 */
export function lookupGuidance(tools) {
	const search = lookupTool(tools);
	if (!search) return '';
	const fetch = tools.includes('web_fetch') ? ' and read the page with web_fetch' : '';
	return (
		'What you know about tools, frameworks and packages stops at your training, and the project may use newer ' +
		'versions. When one behaves differently from what you know (a missing file or option, an import or setting ' +
		'that does not resolve, a flag that is not recognised), check the version the project uses, then look up its ' +
		`current documentation or changelog with ${search}${fetch} before working around it. Do this early rather than ` +
		'after several guesses.'
	);
}

/**
 * The first lookup tool the model has, or null.
 *
 * @param {readonly string[]} tools
 */
export function lookupTool(tools) {
	return LOOKUP_TOOLS.find((t) => tools.includes(t)) ?? null;
}

/**
 * The major version a dependency range asks for: "^3.2.0" → 3, "~1.2" → 1,
 * ">=2 <4" → 2. Null for what is not a version (a tag, a path, git, *).
 *
 * @param {string} range
 */
export function majorOf(range) {
	if (typeof range !== 'string') return null;
	const r = range.trim();
	if (/^(workspace|file|link|git|github|http|https|npm):/i.test(r) || r.includes('/')) return null;
	const m = /^[\^~>=v\s]*(\d+)/.exec(r);
	return m ? Number(m[1]) : null;
}

/**
 * The dependencies whose major version is past what a model is likely to know.
 *
 * @param {Record<string, string>} deps name → range, as in package.json
 * @param {Readonly<Record<string, number>>} [known]
 * @returns {{ name: string, range: string, major: number, known: number }[]}
 */
export function newerThanKnown(deps, known = KNOWN_MAJORS) {
	/** @type {{ name: string, range: string, major: number, known: number }[]} */
	const found = [];
	for (const [name, range] of Object.entries(deps ?? {})) {
		if (!Object.hasOwn(known, name)) continue;
		const major = majorOf(range);
		const k = known[name];
		if (major !== null && k !== undefined && major > k) found.push({ name, range, major, known: k });
	}
	return found;
}

/**
 * The note for a result that lists these versions, or '' when there is
 * nothing newer or no web tool.
 *
 * @param {{ name: string, range: string, major: number, known: number }[]} found
 * @param {readonly string[]} tools
 */
export function newerVersionsNote(found, tools) {
	const search = lookupTool(tools);
	if (!search || found.length === 0) return '';
	const list = found.map((f) => `${f.name} ${f.range}`).join(', ');
	return (
		`[Note: this project uses ${list}, newer than the versions you are likely to know well. Their APIs, ` +
		'config and file layout may have changed. Before relying on what you remember, or when something does not ' +
		`behave as you expect, look up the current docs or migration guide with ${search}.]`
	);
}

/**
 * newerVersionsNote() for a package.json's text: its dependencies and
 * devDependencies. '' when it does not parse, or there is nothing to say.
 *
 * @param {string} text
 * @param {readonly string[]} tools
 */
export function manifestNote(text, tools) {
	if (!lookupTool(tools)) return '';
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch {
		return '';
	}
	if (!pkg || typeof pkg !== 'object') return '';
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	return newerVersionsNote(newerThanKnown(deps), tools);
}

/**
 * What the stagnation monitor adds to its notes when the host has a web tool.
 *
 * @param {string} tool
 */
export function stuckLookupHint(tool) {
	return (
		'If the failure is about a name, option, file or setting you expected to exist, the tool or library may be ' +
		`newer than you know: look up its current documentation with ${tool} instead of guessing again.`
	);
}
