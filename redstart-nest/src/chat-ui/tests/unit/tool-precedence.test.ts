import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	LOCAL_OVERRIDDEN_CAPABILITY,
	suppressedServerToolNames
} from '$lib/stores/tools/precedence';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Guards a safety property that already broke once, silently.
 *
 * Inside Redstart Twig the model can hold two complete filesystem APIs at the
 * same time: Twig's `fs_*` tools, which act on the user's OWN PC in a folder
 * they granted, and Nest's File System capability, which acts on the SERVER in
 * the caller's own folder under an admin-configured root. Neither set's
 * description said which machine it operated on, so "delete the old draft"
 * could hit either one.
 *
 * The original protection was a coincidence: Nest's file tools used to be named
 * `fs_*` too, and the client deduped by name with the local ones first. The FS
 * MCP migration renamed Nest's side to the upstream names, the collision
 * disappeared, and the protection went with it — with nothing failing to say
 * so. These tests exist so that cannot recur quietly: the rule is now keyed on
 * capability identity, and it is asserted.
 */

// What Nest's file_system capability advertises today (upstream server names).
const NEST_FS_TOOLS = [
	'read_file',
	'read_text_file',
	'write_file',
	'edit_file',
	'list_directory',
	'move_file'
];

describe('filesystem precedence', () => {
	it('suppresses the server-side file tools when the device has local ones', () => {
		const suppressed = suppressedServerToolNames(8, NEST_FS_TOOLS);
		for (const name of NEST_FS_TOOLS) {
			expect(suppressed.has(name)).toBe(true);
		}
	});

	it('suppresses nothing when there are no local file tools', () => {
		// The fallback half of the rule: with no granted folder, the server-side
		// capability is the only filesystem and must keep working untouched.
		expect(suppressedServerToolNames(0, NEST_FS_TOOLS).size).toBe(0);
	});

	it('does not depend on the server-side tools being named anything in particular', () => {
		// The whole point. If Nest renames its file tools again — or swaps the
		// upstream server for another one — precedence must follow the capability,
		// not the spelling.
		const renamed = ['fs_read_file', 'totally_different_name'];
		const suppressed = suppressedServerToolNames(8, renamed);
		expect(suppressed.has('fs_read_file')).toBe(true);
		expect(suppressed.has('totally_different_name')).toBe(true);
	});

	it('suppresses nothing when the capability advertises nothing', () => {
		// Nest's File System capability off, or not yet connected. Twig's local
		// tools stand alone; there is no second filesystem to disambiguate from.
		expect(suppressedServerToolNames(8, []).size).toBe(0);
	});

	it('targets only the filesystem capability', () => {
		// Documents, Vault, Git, SQLite, Postgres and Scholar have no Twig
		// equivalent and must stay server-side. In particular create_document
		// still writes on the server and returns its [FILE:] download marker.
		expect(LOCAL_OVERRIDDEN_CAPABILITY).toBe('file_system');
	});

	it('never suppresses a tool the caller did not attribute to the capability', () => {
		// The caller resolves names from _meta on tools/list, and only trusts that
		// field from Nest-provisioned servers. Anything not in that set — a
		// third-party MCP server's tools, the web tools, Twig's own — must survive.
		const suppressed = suppressedServerToolNames(8, NEST_FS_TOOLS);
		for (const name of ['create_document', 'vault_search', 'web_fetch', 'fs_write_file']) {
			expect(suppressed.has(name)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// The rule has to be CALLED, not merely defined.
// ---------------------------------------------------------------------------
// Everything above tests a pure function, and all of it passed for the entire
// period in which the rule did nothing at all: `suppressedServerToolNames` and
// `getNestToolNamesForCapability` were written, exported, and imported by this
// file only. No production code called either one, so the model kept being
// handed both filesystems and quietly wrote to the server — which is precisely
// the bug the module was created to prevent.
//
// Unit tests over a pure function cannot catch that. This one reads the source
// and fails if the rule is orphaned again.
describe('filesystem precedence is wired into the tool list', () => {
	const SRC = path.join(__dirname, '..', '..', 'src');

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...sourceFiles(full));
			else if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
		}
		return out;
	}

	// Files that define the rule rather than apply it.
	const DEFINITIONS = ['stores/tools/precedence.ts', 'stores/mcp.svelte.ts'];

	function callersOf(symbol: string): string[] {
		return sourceFiles(SRC)
			.filter((file) => {
				const rel = path.relative(SRC, file).split(path.sep).join('/');
				if (DEFINITIONS.some((d) => rel.endsWith(d))) return false;
				return fs.readFileSync(file, 'utf8').includes(symbol);
			})
			.map((file) => path.relative(SRC, file));
	}

	it('🔍 suppressedServerToolNames is applied by production code', () => {
		const callers = callersOf('suppressedServerToolNames');
		expect(
			callers.length,
			'suppressedServerToolNames is defined and tested but never called — ' +
				'the model will be offered BOTH filesystems and may write to the server ' +
				'while the user is looking at a local folder'
		).toBeGreaterThan(0);
	});

	it('🔍 the capability-identity lookup that feeds it is applied too', () => {
		const callers = callersOf('getNestToolNamesForCapability');
		expect(
			callers.length,
			'getNestToolNamesForCapability has no production caller, so the suppression ' +
				'set is always empty and the rule is inert'
		).toBeGreaterThan(0);
	});
});
