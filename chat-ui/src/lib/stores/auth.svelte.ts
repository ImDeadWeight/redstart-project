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

/**
 * A per-connector credential (system-prompt spec §8). The key itself is never
 * stored client-side or returned again — only this metadata, plus a prefix so
 * a user can tell one key from another.
 */
export type ConnectorKey = {
	id: string;
	surface: string;
	label: string;
	keyPrefix: string;
	createdAt: string;
};

export type AuthUser = {
	id: string;
	username: string;
	/** Management tier — governs account administration. */
	tier: 'owner' | 'admin' | 'user';
	/**
	 * Mirror of `tier` under its old name. The server emits both so connector
	 * apps holding their own copy of this shape keep working; prefer `tier`.
	 */
	role: 'owner' | 'admin' | 'user';
	/** Admin-defined capability role, or null for Full Access. */
	roleId?: string | null;
	apiKeyPrefix?: string;
	createdAt?: string;
	lastLoginAt?: string | null;
};

class AuthStore {
	private tokenState = persisted<string | null>(AUTH_TOKEN_LOCALSTORAGE_KEY, null);

	user = $state<AuthUser | null>(null);
	authRequired = $state(false);
	checked = $state(false);
	/**
	 * Whether the last init() actually got an answer from the server.
	 *
	 * Distinct from `authRequired`: a failed request leaves that false, which is
	 * indistinguishable from a server that genuinely requires no login. The
	 * startup retry loop needs to tell those apart to know whether waiting will
	 * help.
	 */
	serverReachable = $state(false);

	get token(): string | null {
		return this.tokenState.value;
	}

	/**
	 * Admin-tier or above — gates visibility of the Accounts and Roles sections.
	 *
	 * Falls back to `role` so a session restored from an older server (which
	 * emits only the old field) does not silently read as "not an admin".
	 */
	get isAdmin(): boolean {
		const tier = this.user?.tier ?? this.user?.role;
		return tier === 'admin' || tier === 'owner';
	}

	/** The single sys-admin account — gates Admin-account management inside the Accounts tab. */
	get isOwner(): boolean {
		return (this.user?.tier ?? this.user?.role) === 'owner';
	}

	async init(): Promise<void> {
		try {
			const config = await apiFetch<{ authRequired: boolean }>('/auth/config');
			this.authRequired = config.authRequired;
			this.serverReachable = true;
		} catch {
			// A server that cannot be asked is NOT a server that said "no auth
			// needed" — collapsing those two into `authRequired = false` is why an
			// unreachable server looked, to the rest of the app, like an open one.
			// The flag keeps them distinct so callers can retry rather than
			// proceeding on an answer nobody gave.
			this.authRequired = false;
			this.serverReachable = false;
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

	/**
	 * Per-connector credentials (system-prompt spec §8).
	 *
	 * Self-service by design — these act on the current account only. The
	 * server derives which app is calling from the key itself, so a key issued
	 * here is what makes a connector's surface trustworthy rather than a
	 * header it could set freely.
	 */
	async listClientKeys(): Promise<{ clientKeys: ConnectorKey[]; surfaces: string[] }> {
		return apiFetch<{ clientKeys: ConnectorKey[]; surfaces: string[] }>('/auth/me/client-keys', {
			authOnly: true
		});
	}

	/** Returns the raw key, which the server never stores and will not show again. */
	async issueClientKey(
		surface: string,
		label?: string
	): Promise<{ apiKey: string; clientKey: ConnectorKey }> {
		return apiPost<{ apiKey: string; clientKey: ConnectorKey }>(
			'/auth/me/client-keys',
			{ surface, label },
			{ authOnly: true }
		);
	}

	async revokeClientKey(id: string): Promise<void> {
		await apiFetch(`/auth/me/client-keys/${id}`, { method: 'DELETE', authOnly: true });
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
