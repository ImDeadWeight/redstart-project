import { describe, expect, it } from 'vitest';
import { findCommand } from '$lib/slash-commands/parse';
import { SLASH_COMMANDS } from '$lib/slash-commands/registry';

// People read "background job" for the assistant's own background work, since
// "Tasks" on screen are the ones people give each other. The command keeps
// its name, /task, and /job finds the same one.
describe('the background job command', () => {
	it('is /task, and /job finds it too', () => {
		const command = findCommand(SLASH_COMMANDS, 'task');
		expect(command?.name).toBe('task');
		expect(findCommand(SLASH_COMMANDS, 'job')).toBe(command);
	});
});
