/**
 * **ProjectsPage** - The list of the account's projects, and New project
 *
 * Opened from the sidebar beside Workflows (projects-plan Phase 2).
 */
export { default as ProjectsPage } from './ProjectsPage.svelte';

/**
 * **ProjectPage** - One project: chats, instructions, project memory, files
 *
 * Owner-only today; Nest answers 404 for anyone else (plan D7).
 */
export { default as ProjectPage } from './ProjectPage.svelte';

/**
 * **ProgramPage** - One program: a group of projects and their tasks together
 *
 * A program gives no access (tasks plan Phase 4): it shows only the projects
 * in it the viewer can already open.
 */
export { default as ProgramPage } from './ProgramPage.svelte';
