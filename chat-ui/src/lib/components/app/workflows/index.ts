/**
 * **WorkflowsPage** - Full-page workflows view, opened from the sidebar
 *
 * Its own page beside New chat rather than a Settings section: a workflow is
 * something you run and refine, not app configuration.
 */
export { default as WorkflowsPage } from './WorkflowsPage.svelte';

/**
 * **WorkflowsPanel** - The personal and organization lists and the editor
 *
 * Personal workflows for anyone; organization workflows editable only with
 * manageOrgWorkflows (the server gates every write regardless).
 */
export { default as WorkflowsPanel } from './WorkflowsPanel.svelte';
