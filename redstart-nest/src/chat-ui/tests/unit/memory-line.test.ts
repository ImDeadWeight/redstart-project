import { describe, it, expect } from 'vitest';
import { parseToolResultWithImages } from '$lib/utils/agentic';

// memory_save's first result line becomes the "Remembered" chip with Undo.
// Server side the line is built in daemon/memory-tool.mjs and pinned by
// scripts/test-projects.mjs; a project save names its project
// (projects-plan D13) so Undo deletes from that project's memory.

const ID = '0f8e2c4a-1b2c-4d5e-8f90-123456789abc';
const PROJECT = '9a8b7c6d-1111-2222-3333-444455556666';

function memoryOf(line: string) {
	return parseToolResultWithImages(line)[0].memory;
}

describe('memory_save result line', () => {
	it('parses a plain save', () => {
		expect(memoryOf(`[memory: ${ID}] Uses Postgres 16`)).toEqual({
			id: ID,
			text: 'Uses Postgres 16',
			fromWeb: false,
			projectId: undefined
		});
	});

	it('parses the web mark', () => {
		expect(memoryOf(`[memory: ${ID} web] Likes tea`)).toMatchObject({ fromWeb: true });
	});

	it('parses a project save, with and without the web mark', () => {
		expect(memoryOf(`[memory: ${ID} project:${PROJECT}] Deploys on Fridays`)).toEqual({
			id: ID,
			text: 'Deploys on Fridays',
			fromWeb: false,
			projectId: PROJECT
		});
		expect(memoryOf(`[memory: ${ID} web project:${PROJECT}] X`)).toMatchObject({
			fromWeb: true,
			projectId: PROJECT
		});
	});

	it('is not fooled by text that only looks like a scope', () => {
		const m = memoryOf(`[memory: ${ID}] project:${PROJECT} is the code name`);
		expect(m?.projectId).toBeUndefined();
		expect(m?.text).toBe(`project:${PROJECT} is the code name`);
	});

	it('ignores ordinary lines', () => {
		expect(memoryOf('Saved. The user can see it and undo it.')).toBeUndefined();
	});
});
