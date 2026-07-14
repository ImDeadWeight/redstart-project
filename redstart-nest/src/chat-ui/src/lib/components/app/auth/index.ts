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
