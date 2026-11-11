/**
 * Built-in slash commands, the pure half (projects-plan D1–D4). Pinned here:
 *   - `/name rest` keeps the picker only for an exact built-in; any other
 *     text that starts with `/` is an ordinary message (`/etc/hosts …`)
 *   - a no-arg command never claims trailing text (`/help me write…`, a
 *     paste starting `/new`), because running it would drop that text
 *   - submit runs a full command even with the picker closed, and never
 *     claims a message that is not one
 *   - ranking: exact name/alias, then prefix, then summary
 *   - a required arg picked from the list fills `/name `, never runs empty
 *   - a typed command with options lists the matches, and falls back to the
 *     command row when none match
 */
import { describe, expect, it } from 'vitest';
import {
	commandForSubmit,
	filterCommands,
	filterOptions,
	findCommand,
	pickAction,
	pickerItems,
	slashState,
	usage,
	type SlashCommandSpec,
	type SlashOption
} from '$lib/slash-commands/parse';

const SPECS: SlashCommandSpec[] = [
	{ name: 'help', summary: 'List commands and workflows', arg: 'none' },
	{ name: 'new', aliases: ['clear'], summary: 'Start a new chat', arg: 'none' },
	{ name: 'remember', summary: 'Save something to memory', arg: 'required', argHint: '<text>' },
	{ name: 'model', summary: 'Switch model', arg: 'optional', argHint: '[name]' },
	{ name: 'memory', summary: 'See what is remembered', arg: 'none' }
];

const MODELS: SlashOption[] = [
	{ value: 'qwen3-8b', label: 'Qwen3 8B' },
	{ value: 'gemma-3-12b', label: 'Gemma 3 12B' },
	{ value: 'qwen3-32b', label: 'Qwen3 32B' }
];
const optionsOf = (c: SlashCommandSpec) => (c.name === 'model' ? MODELS : undefined);

describe('slashState', () => {
	it('is closed for text that does not start with /', () => {
		expect(slashState('hello /new', SPECS)).toEqual({ kind: 'closed' });
		expect(slashState('', SPECS)).toEqual({ kind: 'closed' });
	});

	it('browses while a name is being typed', () => {
		expect(slashState('/', SPECS)).toEqual({ kind: 'browse', query: '' });
		expect(slashState('/rem', SPECS)).toEqual({ kind: 'browse', query: 'rem' });
	});

	it('narrows to an exact command once a space follows, with the arg trimmed', () => {
		const s = slashState('/remember   I use Postgres 16  ', SPECS);
		expect(s.kind).toBe('command');
		if (s.kind === 'command') {
			expect(s.command.name).toBe('remember');
			expect(s.arg).toBe('I use Postgres 16');
		}
	});

	it('matches aliases and ignores case', () => {
		const s = slashState('/CLEAR ', SPECS);
		expect(s.kind === 'command' && s.command.name).toBe('new');
	});

	it('closes for a path or any non-command followed by a space, so it sends', () => {
		expect(slashState('/etc/hosts is broken', SPECS)).toEqual({ kind: 'closed' });
		expect(slashState('/rem is a sleep stage', SPECS)).toEqual({ kind: 'closed' });
	});

	it('a no-arg command never claims text after it, so nothing is dropped', () => {
		expect(slashState('/help me write a poem', SPECS)).toEqual({ kind: 'closed' });
		expect(slashState('/new\nsome pasted text', SPECS)).toEqual({ kind: 'closed' });
		expect(slashState('/new ', SPECS).kind).toBe('command');
	});

	it('treats a newline after the name as the start of the arg', () => {
		const s = slashState('/remember\nline two', SPECS);
		expect(s.kind === 'command' && s.arg).toBe('line two');
	});
});

describe('commandForSubmit', () => {
	it('runs a full command with no space, as typed and sent', () => {
		expect(commandForSubmit('/new', SPECS)?.command.name).toBe('new');
		expect(commandForSubmit('/new  ', SPECS)?.command.name).toBe('new');
	});

	it('carries the arg', () => {
		expect(commandForSubmit('/remember prefers tabs', SPECS)?.arg).toBe('prefers tabs');
	});

	it('does not run a no-arg command that has text after it', () => {
		expect(commandForSubmit('/help me write a poem', SPECS)).toBeNull();
		expect(commandForSubmit('/new\nand the rest of a paste', SPECS)).toBeNull();
	});

	it('never claims an ordinary message', () => {
		expect(commandForSubmit('/etc/hosts is broken', SPECS)).toBeNull();
		expect(commandForSubmit('/rem', SPECS)).toBeNull();
		expect(commandForSubmit('please /new', SPECS)).toBeNull();
		expect(commandForSubmit('/', SPECS)).toBeNull();
	});
});

describe('filterCommands', () => {
	it('lists everything in registry order for an empty query', () => {
		expect(filterCommands(SPECS, '').map((c) => c.name)).toEqual(SPECS.map((c) => c.name));
	});

	it('ranks exact, then prefix, then summary', () => {
		expect(filterCommands(SPECS, 'mem').map((c) => c.name)).toEqual(['memory', 'remember']);
		expect(filterCommands(SPECS, 'memory').map((c) => c.name)[0]).toBe('memory');
		expect(filterCommands(SPECS, 'cle').map((c) => c.name)).toEqual(['new']);
	});

	it('returns nothing for no match', () => {
		expect(filterCommands(SPECS, 'zzz')).toEqual([]);
	});
});

describe('pickerItems and pickAction', () => {
	it('is empty when closed', () => {
		expect(pickerItems({ kind: 'closed' }, SPECS, optionsOf)).toEqual([]);
	});

	it('lists matching options for a typed command', () => {
		const items = pickerItems(slashState('/model qwen', SPECS), SPECS, optionsOf);
		expect(items.map((i) => (i.kind === 'option' ? i.option.value : ''))).toEqual([
			'qwen3-8b',
			'qwen3-32b'
		]);
		const action = pickAction(items[1]);
		expect(action).toMatchObject({ run: true, arg: 'qwen3-32b' });
	});

	it('falls back to the command row when no option matches, keeping the typed arg', () => {
		const items = pickerItems(slashState('/model llama', SPECS), SPECS, optionsOf);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: 'command', arg: 'llama' });
	});

	it('fills /name for a required arg picked from the list, and runs it once typed', () => {
		const [remember] = pickerItems(slashState('/remem', SPECS), SPECS, optionsOf);
		expect(pickAction(remember)).toEqual({ run: false, composer: '/remember ' });
		const [typed] = pickerItems(slashState('/remember uses vim', SPECS), SPECS, optionsOf);
		expect(pickAction(typed)).toMatchObject({ run: true, arg: 'uses vim' });
	});

	it('runs a no-arg or optional-arg command straight from the list', () => {
		const [model] = pickerItems(slashState('/mod', SPECS), SPECS, optionsOf);
		expect(pickAction(model)).toMatchObject({ run: true, arg: '' });
	});
});

describe('filterOptions and usage', () => {
	it('matches value or label, exact first', () => {
		expect(filterOptions(MODELS, 'gemma 3 12b').map((o) => o.value)).toEqual(['gemma-3-12b']);
		expect(filterOptions(MODELS, '32').map((o) => o.value)).toEqual(['qwen3-32b']);
		expect(filterOptions(MODELS, '')).toHaveLength(3);
	});

	it('formats usage with the hint', () => {
		expect(usage(SPECS[2])).toBe('/remember <text>');
		expect(usage(SPECS[0])).toBe('/help');
	});
});

describe('findCommand', () => {
	it('needs a name', () => {
		expect(findCommand(SPECS, '')).toBeUndefined();
	});
});
