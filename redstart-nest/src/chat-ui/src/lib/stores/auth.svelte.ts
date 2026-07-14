import { persisted } from './persisted.svelte';
import { apiFetch, apiPost } from '$lib/utils';
import { AUTH_TOKEN_LOCALSTORAGE_KEY } from '$lib/constants/storage';

/**
 * authStore - login state for the shared chat-ui (Redstart Nest's browser view,
 * Redstart Twig Windows, Redstart Twig Android all render this same frontend).
 *
 * The session token is persisted client-side so users aren't forced to
 * re-login every app launch. It's issued server-side in-memory only, so an
 * Electron restart invalidates it — init() below detects that (401 from
 * /auth/me) and clears the stale token rather than looping.
 */

export type AuthUser = {
	id: string;
	username: string;
	role: 'owner' | 'admin' | 'user';
	apiKeyPrefix?: string;
	createdAt?: string;
	lastLoginAt?: string | null;
};

class AuthStore {
	private tokenState = persisted<string | null>(AUTH_TOKEN_LOCALSTORAGE_KEY, null);

	user = $state<AuthUser | null>(null);
	authRequired = $state(false);
	checked = $state(false);

	get token(): string | null {
		return this.tokenState.value;
	}

	/** Admin-tier or above — gates visibility of the Accounts settings section. */
	get isAdmin(): boolean {
		return this.user?.role === 'admin' || this.user?.role === 'owner';
	}

	/** The single sys-admin account — gates Admin-account management inside the Accounts tab. */
	get isOwner(): boolean {
		return this.user?.role === 'owner';
	}

	async init(): Promise<void> {
		try {
			const config = await apiFetch<{ authRequired: boolean }>('/auth/config');
			this.authRequired = config.authRequired;
		} catch {
			this.authRequired = false;
		}

		if (this.tokenState.value) {
			try {
				const me = await apiFetch<{ user: AuthUser | null }>('/auth/me', { authOnly: true });
				this.user = me.user;
			} catch {
				// Stale/expired token (e.g. Redstart Nest restarted since login) — clear
				// it so the login gate reappears instead of retrying indefinitely.
				this.tokenState.value = null;
				this.user = null;
			}
		}

		this.checked = true;
	}

	async login(username: string, password: string): Promise<void> {
		const result = await apiPost<{ token: string; user: AuthUser }>('/auth/login', {
			username,
			password
		});
		this.tokenState.value = result.token;
		this.user = result.user;
	}

	/**
	 * Rotate the current user's own API key. Returns the new full key, which is
	 * shown to the user exactly once (the server only ever stores its hash).
	 * Updates this.user with the fresh apiKeyPrefix so the menu reflects it.
	 */
	async regenerateOwnApiKey(): Promise<string> {
		const result = await apiPost<{ account: AuthUser; apiKey: string }>(
			'/auth/me/regenerate-key',
			{},
			{ authOnly: true }
		);
		this.user = result.account;
		return result.apiKey;
	}

	async logout(): Promise<void> {
		try {
			await apiPost('/auth/logout', {}, { authOnly: true });
		} catch {
			// Best-effort — clear local state regardless of server response.
		}
		this.tokenState.value = null;
		this.user = null;
	}

	/**
	 * Drop a stale/revoked session so the reactive login gate reappears.
	 * Called centrally whenever an authenticated request comes back 401
	 * mid-session (server restarted, admin revoked the account, session
	 * expired) rather than leaving the app to show a generic connectivity
	 * error.
	 *
	 * A 401 also proves the server requires auth, so force authRequired true:
	 * this closes the gap where /auth/config couldn't be reached at startup
	 * (init() defaults authRequired to false on failure), which would
	 * otherwise leave the app showing the chat UI with 401 errors instead of
	 * the login gate.
	 */
	handleUnauthorized(): void {
		this.authRequired = true;
		this.tokenState.value = null;
		this.user = null;
	}
}

export const authStore = new AuthStore();
