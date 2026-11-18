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

// UserMenu removed — everything it held now lives on the full profile page
// (components/app/profile), with Log out pinned at the bottom of the sidebar.
// The dropdown could not grow, and its one-shot key dialog was the reason a
// regenerated key was easy to lose.
