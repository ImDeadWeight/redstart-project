/**
 *
 * AUTH
 *
 * Login gate and account management UI.
 *
 */

/**
 * **LoginForm** - Full-screen username/password login gate
 *
 * Shown in place of the app shell when the server requires login and no
 * valid session exists. Posts to /auth/login via authStore.
 */
export { default as LoginForm } from './LoginForm.svelte';

/**
 * **UserMenu** - Top-level account menu (sidebar header)
 *
 * Shown when a user is logged in. Dropdown with username, role, account
 * timestamps, API key prefix + self-service regenerate (one-time key reveal),
 * and Log out. Renders nothing when not logged in (e.g. auth disabled).
 */
export { default as UserMenu } from './UserMenu.svelte';
