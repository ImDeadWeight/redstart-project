/**
 * Built-in slash commands: the pure half (projects-plan D1–D4).
 *
 * A built-in command runs in the client and never reaches the model. Workflows
 * are a different thing: MCP prompts served by Nest, listed by the same `/`
 * picker. This module decides what the composer's text means — browsing the
 * list, one command with an argument, or an ordinary message — and nothing
 * else, so it imports no store and is tested in node (tests/unit/
 * slash-commands.test.ts).
 */

export type SlashArg = 'none' | 'optional' | 'required';

export interface SlashCommandSpec {
	/** Typed after `/`, lowercase, no spaces. */
	name: string;
	aliases?: string[];
	summary: string;
	arg: SlashArg;
	/** Shown after the name in the list, e.g. `<text>` or `[name]`. */
	argHint?: string;
}

/**
 * What the composer's text means right now.
 *  - `closed`: not a command — an ordinary message, or not started with `/`.
 *  - `browse`: `/` plus a partial name with no space yet; list what matches.
 *  - `command`: an exact command name followed by a space (D3), with its arg.
 */
export type SlashState<C extends SlashCommandSpec = SlashCommandSpec> =
	| { kind: 'closed' }
	| { kind: 'browse'; query: string }
	| { kind: 'command'; command: C; arg: string };

const NAME = /^\/(\S*)/;

/** Exact match on a name or an alias, case-insensitive. */
export function findCommand<C extends SlashCommandSpec>(
	specs: readonly C[],
	name: string
): C | undefined {
	const n = name.toLowerCase();
	if (!n) return undefined;
	return specs.find((c) => c.name === n || (c.aliases ?? []).includes(n));
}

/**
 * A command that takes no argument never claims text after its name:
 * `/help me write a poem`, or a paste that starts with `/new` and goes on, is
 * a message, and running the command would silently drop the rest of it.
 */
function refusesArg(command: SlashCommandSpec, rest: string): boolean {
	return command.arg === 'none' && rest.trim().length > 0;
}

export function slashState<C extends SlashCommandSpec>(
	value: string,
	specs: readonly C[]
): SlashState<C> {
	const m = NAME.exec(value);
	if (!m) return { kind: 'closed' };
	const name = m[1];
	const rest = value.slice(m[0].length);

	if (rest.length === 0) return { kind: 'browse', query: name };

	// A space (or newline) follows the name. Only an exact built-in keeps the
	// picker: anything else is a message that happens to start with `/`, and
	// `/etc/hosts is broken` must still send (D3).
	const command = findCommand(specs, name);
	if (!command || refusesArg(command, rest)) return { kind: 'closed' };
	return { kind: 'command', command, arg: rest.trim() };
}

/**
 * Commands matching a partial name, best first: exact name or alias, then
 * name/alias prefix, then a word in the summary. An empty query lists all, in
 * registry order.
 */
export function filterCommands<C extends SlashCommandSpec>(
	specs: readonly C[],
	query: string
): C[] {
	const q = query.toLowerCase();
	if (!q) return [...specs];
	const rank = (c: C): number => {
		const names = [c.name, ...(c.aliases ?? [])];
		if (names.includes(q)) return 0;
		if (names.some((n) => n.startsWith(q))) return 1;
		if (c.summary.toLowerCase().includes(q)) return 2;
		return -1;
	};
	return specs
		.map((c, i) => ({ c, i, r: rank(c) }))
		.filter((x) => x.r >= 0)
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.c);
}

/**
 * What the composer should do when the user submits this text (D4): run a
 * command, or send the text as a message. Submit runs a command even with no
 * space after the name (`/new` + send), which `slashState` reports as browse.
 */
export function commandForSubmit<C extends SlashCommandSpec>(
	value: string,
	specs: readonly C[]
): { command: C; arg: string } | null {
	const text = value.trimEnd();
	const m = NAME.exec(text);
	if (!m) return null;
	const command = findCommand(specs, m[1]);
	const rest = text.slice(m[0].length);
	if (!command || refusesArg(command, rest)) return null;
	return { command, arg: rest.trim() };
}

export interface SlashOption {
	/** Passed back to the command as its argument. */
	value: string;
	label: string;
	description?: string;
}

/**
 * Options matching what was typed, for commands that offer them (`/model`,
 * `/mode`). Exact value or label first, then prefix, then substring; an empty
 * arg lists all.
 */
export function filterOptions(options: readonly SlashOption[], arg: string): SlashOption[] {
	const q = arg.trim().toLowerCase();
	if (!q) return [...options];
	const rank = (o: SlashOption): number => {
		const v = o.value.toLowerCase();
		const l = o.label.toLowerCase();
		if (v === q || l === q) return 0;
		if (v.startsWith(q) || l.startsWith(q)) return 1;
		if (v.includes(q) || l.includes(q)) return 2;
		return -1;
	};
	return options
		.map((o, i) => ({ o, i, r: rank(o) }))
		.filter((x) => x.r >= 0)
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.map((x) => x.o);
}

/** One built-in row in the `/` picker, listed above the workflows (D2). */
export type SlashPickerItem<C extends SlashCommandSpec = SlashCommandSpec> =
	| { kind: 'command'; command: C; arg: string }
	| { kind: 'option'; command: C; option: SlashOption };

/**
 * The built-in rows for a state. Browsing lists matching commands. A typed
 * command lists its matching options when it has any; with none matching it
 * falls back to the command itself, so Enter still runs it and the command
 * can say what was wrong ("No model matches …").
 */
export function pickerItems<C extends SlashCommandSpec>(
	state: SlashState<C>,
	specs: readonly C[],
	optionsOf: (command: C) => SlashOption[] | undefined
): SlashPickerItem<C>[] {
	if (state.kind === 'closed') return [];
	if (state.kind === 'browse') {
		return filterCommands(specs, state.query).map((command) => ({
			kind: 'command',
			command,
			arg: ''
		}));
	}
	const options = filterOptions(optionsOf(state.command) ?? [], state.arg);
	if (options.length > 0) {
		return options.map((option) => ({ kind: 'option', command: state.command, option }));
	}
	return [{ kind: 'command', command: state.command, arg: state.arg }];
}

/**
 * What picking a row does: run the command with an argument, or (a required
 * argument not typed yet) put `/name ` in the composer for the user to finish.
 */
export function pickAction<C extends SlashCommandSpec>(
	item: SlashPickerItem<C>
): { run: true; command: C; arg: string } | { run: false; composer: string } {
	if (item.kind === 'option') return { run: true, command: item.command, arg: item.option.value };
	if (item.command.arg === 'required' && !item.arg) {
		return { run: false, composer: `/${item.command.name} ` };
	}
	return { run: true, command: item.command, arg: item.arg };
}

/** `/name <hint>` as shown in the list and in a usage hint. */
export function usage(spec: SlashCommandSpec): string {
	return spec.argHint ? `/${spec.name} ${spec.argHint}` : `/${spec.name}`;
}
