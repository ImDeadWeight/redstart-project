/**
 * agent-core/approval — the approval handshake's wire names (plan §5, D12).
 *
 * Nest enforces an approval on some tools (daemon/tools-definitions.mjs,
 * isApprovalEnforced): a tools/call without one does nothing and comes back
 * as an error carrying a pending approval. The client decides it with the
 * person (chat-ui's card, the bench's task policy, the daemon runtime's
 * parked task later), posts the decision to the gateway, and repeats the call
 * with the approval's id. The loop itself does not change (D2): the gate port
 * still decides, and the host's executor turns that decision into a server
 * approval. This file is what every party must agree on, so a key cannot be
 * spelled two ways.
 *
 * On a tool (tools/list `_meta`):
 *   APPROVAL_RULE_META_KEY      'none' | 'prompt' | 'always'
 *   APPROVAL_ENFORCED_META_KEY  true when the server refuses an unapproved call
 * On a result (tools/call `result._meta`):
 *   APPROVAL_META_KEY           the pending approval (PendingApproval below)
 * On the repeated call (tools/call `params._meta`):
 *   APPROVAL_ID_META_KEY        the approval's id
 */

export const APPROVAL_RULE_META_KEY = 'redstart/approvalRule';
export const APPROVAL_ENFORCED_META_KEY = 'redstart/approvalEnforced';
export const APPROVAL_META_KEY = 'redstart/approval';
export const APPROVAL_ID_META_KEY = 'redstart/approvalId';

/** The decisions a client posts (POST /approvals/:id { decision }). */
export const APPROVAL_DECISIONS = Object.freeze(['once', 'always', 'deny']);

/**
 * What the model reads when the handshake did not happen. Says what not to
 * do as well: on 2026-11-12 the 35B, told only "this client did not ask",
 * asked the user in chat with ask_user, got "yes", and tried again, three
 * times. An answer in the chat is not an approval.
 */
export const APPROVAL_NEEDED_TEXT =
	"Not done: this call needs the user's approval on the app's approval card, and it was not given. " +
	'Asking in the chat cannot approve it, so do not ask; tell the user it was not done.';

/**
 * @typedef {{ id: string, tool: string, summary: string, argsDigest: string, expiresAt: number }} PendingApproval
 */

/**
 * The pending approval a tools/call result carries, or null when it is not
 * an approval refusal. Checks the shape, since a result is a server's word
 * and a malformed one must read as "not an approval", never throw.
 *
 * @param {unknown} result an MCP tools/call result
 * @returns {PendingApproval | null}
 */
export function approvalRequired(result) {
	if (!result || typeof result !== 'object') return null;
	const r = /** @type {{ isError?: unknown, _meta?: Record<string, unknown> }} */ (result);
	if (r.isError !== true) return null;
	const p = r._meta?.[APPROVAL_META_KEY];
	if (!p || typeof p !== 'object') return null;
	const a = /** @type {Record<string, unknown>} */ (p);
	if (typeof a.id !== 'string' || !a.id || typeof a.tool !== 'string') return null;
	return {
		id: a.id,
		tool: a.tool,
		summary: typeof a.summary === 'string' ? a.summary : '',
		argsDigest: typeof a.argsDigest === 'string' ? a.argsDigest : '',
		expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : 0
	};
}

/**
 * Grant scope (plan D13, D19; Phase 4 P4-e). Shared, so Nest (which makes
 * and checks grants) and chat-ui (which decides whether to show the card,
 * and what "Always allow" says) compute it the same way.
 *
 * A standing grant for most tools covers every call (scope null). A scoped
 * tool's grant covers only calls whose scope matches, and an unscoped grant
 * for it is refused, so nothing can always-allow every command.
 *
 * run_command's scope is the program and its first argument: "git status"
 * covers `git status -s` and not `git push`. A call with no first argument
 * has no scope, so it can never be always allowed: `git` alone, or `node`
 * alone, is not a decision to make once for all time.
 *
 * Nest computes it from the approved call's own arguments when it opens the
 * approval, never from anything a client sends.
 *
 * @typedef {{ executable: string, firstArg: string }} GrantScope
 */

export const SCOPED_GRANT_TOOLS = Object.freeze(['run_command']);
export const MAX_SCOPE_PART_CHARS = 256;

/** @param {string} name */
export function isScopedTool(name) {
	return SCOPED_GRANT_TOOLS.includes(name);
}

/**
 * The scope a grant made from this call would have, or null (an unscoped
 * tool, or a scoped tool's call that cannot be always allowed).
 *
 * @param {string} tool
 * @param {any} args the call's arguments, parsed
 * @returns {GrantScope | null}
 */
export function grantScopeFor(tool, args) {
	if (tool !== 'run_command') return null;
	const executable = typeof args?.command === 'string' ? args.command.trim() : '';
	const firstArg =
		Array.isArray(args?.args) && typeof args.args[0] === 'string' ? args.args[0] : '';
	if (!executable || !firstArg) return null;
	if (executable.length > MAX_SCOPE_PART_CHARS || firstArg.length > MAX_SCOPE_PART_CHARS)
		return null;
	return { executable, firstArg };
}

/**
 * Do two scopes name the same thing? null matches only null.
 *
 * @param {GrantScope | null | undefined} a
 * @param {GrantScope | null | undefined} b
 */
export function sameScope(a, b) {
	if (!a || !b) return (a ?? null) === (b ?? null);
	return a.executable === b.executable && a.firstArg === b.firstArg;
}

/**
 * How a card names a scope: "git status".
 *
 * @param {GrantScope | null | undefined} scope
 */
export function scopeLabel(scope) {
	return scope ? `${scope.executable} ${scope.firstArg}` : '';
}

/**
 * A run_command call as one line a person can read before approving it:
 * each argument that a shell would split or interpret is shown quoted, so
 * `"a b"` reads as one argument. Display only: nothing runs this string.
 *
 * @param {any} args the call's arguments, parsed
 * @returns {string}
 */
export function commandLine(args) {
	const command = typeof args?.command === 'string' ? args.command : '?';
	const rest = Array.isArray(args?.args) ? args.args.map((/** @type {unknown} */ a) => String(a)) : [];
	return [command, ...rest]
		.map((a) => (/^[\w./:=@%+,-]+$/.test(a) ? a : JSON.stringify(a)))
		.join(' ');
}
