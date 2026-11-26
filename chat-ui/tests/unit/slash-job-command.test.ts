import { describe, expect, it } from 'vitest';
import { findCommand } from '$lib/slash-commands/parse';
import { SLASH_COMMANDS } from '$lib/slash-commands/registry';

// Tasks plan Phase 0: the background command is /job, because "task" is now
// the work people give each other. /task keeps working for anyone used to it.
describe('the background job command', () => {
	it('is /job, and /task still finds it', () => {
		const job = findCommand(SLASH_COMMANDS, 'job');
		expect(job?.name).toBe('job');
		expect(findCommand(SLASH_COMMANDS, 'task')).toBe(job);
	});
});
