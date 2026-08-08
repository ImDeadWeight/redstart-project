/**
 * **ProfilePage** - Full-page account view
 *
 * Replaces the old UserMenu dropdown. Shows identity, account dates, and API
 * key management, with room to grow — this surface is expected to gain more
 * account-level features rather than staying a popover.
 */
export { default as ProfilePage } from './ProfilePage.svelte';

/**
 * **ProfileAccountTab** - Identity details and API key management
 */
export { default as ProfileAccountTab } from './ProfileAccountTab.svelte';

/**
 * **ProfileFilesTab** - Browser for this account's own storage on the server.
 *
 * Lives on the profile page rather than in Settings: it is about *your* files,
 * the same way the API key above it is about *your* credential. Settings
 * configures the app; this page is the account.
 */
export { default as ProfileFilesTab } from './ProfileFilesTab.svelte';
