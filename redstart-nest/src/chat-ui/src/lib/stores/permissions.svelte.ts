/**
 * permissions - which tools run without the permission card ("Always allow").
 *
 * Two homes, by where the tool lives (agent-runtime Phase 2, D13; plan P2-e):
 *
 * - Nest's own MCP tools (keys `mcp-redstart-<server>:<tool>`): standing grants
 *   on the SERVER, per account, through /approvals/grants. This store is a
 *   cache of that list, refreshed when Nest's tools load and after every
 *   change. A grant then follows the account to every browser and client, and
 *   Nest refuses to grant a destructive tool at all.
 * - Everything else (Twig's local file system, llama-server built-ins, the
 *   in-page sandbox, custom and third-party MCP tools): `localStorage`, as
 *   before. Those tools are the client's, and so is their prompt (D3).
 *
 * The one-time import: Nest keys found in `localStorage` from before Phase 2
 * are sent to /approvals/grants/import, which keeps only tools that may be
 * always allowed (never a delete), and then leave `localStorage`. A flag stops
 * it repeating.
 */

import { ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY } from '$lib/constants';
import { apiFetch, apiPost } from '$lib/utils/api-fetch';

import { SvelteMap, SvelteSet } from 'svelte/reactivity';

const NEST_KEY = /^mcp-(redstart-[^:]+):(.+)$/;
const IMPORTED_FLAG_KEY = `${ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY}.importedToNest`;

/** The Nest tool a permission key names, or null for a client-side tool. */
export function nestToolOfKey(key: string): string | null {
	return NEST_KEY.exec(key)?.[2] ?? null;
}

interface ServerGrant {
	id: string;
	tool: string;
}

class PermissionsStore {
	private _tools = $state(new SvelteSet<string>());
	/** Nest tool name → its grant id, from GET /approvals/grants. */
	private _server = $state(new SvelteMap<string, string>());

	constructor() {
		try {
			const stored = localStorage.getItem(ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY);
			if (stored) {
				for (const name of JSON.parse(stored) as string[]) {
					if (typeof name === 'string') this._tools.add(name);
				}
			}
		} catch (err) {
			console.error(
				`Failed to load permissions from localStorage ("${ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY}"):`,
				err
			);
		}
	}

	/** The client-side keys (localStorage). Nest's grants are in serverTools. */
	get tools(): ReadonlySet<string> {
		return this._tools;
	}

	/** Nest tools the account always allows, by tool name. */
	get serverTools(): ReadonlySet<string> {
		return new Set(this._server.keys());
	}

	hasTool(key: string): boolean {
		const nest = nestToolOfKey(key);
		return nest ? this._server.has(nest) : this._tools.has(key);
	}

	allowTool(key: string): void {
		const nest = nestToolOfKey(key);
		if (nest) {
			void this.grantOnServer(nest);
			return;
		}
		this._tools.add(key);
		this._persist();
	}

	allowTools(keys: string[]): void {
		for (const key of keys) this.allowTool(key);
	}

	revokeTool(key: string): void {
		const nest = nestToolOfKey(key);
		if (nest) {
			void this.revokeOnServer(nest);
			return;
		}
		this._tools.delete(key);
		this._persist();
	}

	/**
	 * Load the account's standing grants from Nest, then run the one-time
	 * import. Called when Nest's MCP tools load. A failure leaves the cache as
	 * it was: the card then simply shows.
	 */
	async refresh(): Promise<void> {
		if (await this.loadGrants()) await this.importOnce();
	}

	/** Replace the cache with Nest's list. False when Nest could not be asked. */
	private async loadGrants(): Promise<boolean> {
		try {
			const { grants } = await apiFetch<{ grants: ServerGrant[] }>('/approvals/grants');
			this._server.clear();
			for (const g of grants ?? []) if (g?.tool && g?.id) this._server.set(g.tool, g.id);
			return true;
		} catch {
			return false;
		}
	}

	private async grantOnServer(tool: string): Promise<void> {
		try {
			const g = await apiPost<ServerGrant>('/approvals/grants', { tool });
			if (g?.id) this._server.set(tool, g.id);
		} catch (err) {
			// Nest refuses to always allow a destructive tool, and says so.
			console.warn(`[permissions] Nest did not always allow "${tool}":`, err);
		}
	}

	private async revokeOnServer(tool: string): Promise<void> {
		const id = this._server.get(tool);
		if (!id) return;
		try {
			await apiFetch(`/approvals/grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
			this._server.delete(tool);
		} catch (err) {
			console.warn(`[permissions] could not revoke "${tool}" on Nest:`, err);
		}
	}

	private async importOnce(): Promise<void> {
		try {
			if (localStorage.getItem(IMPORTED_FLAG_KEY)) return;
		} catch {
			return;
		}
		const nestKeys = [...this._tools].filter((k) => nestToolOfKey(k));
		if (nestKeys.length > 0) {
			try {
				await apiPost('/approvals/grants/import', {
					tools: nestKeys.map((k) => nestToolOfKey(k)!)
				});
			} catch {
				return; // try again next time
			}
			for (const k of nestKeys) this._tools.delete(k);
			this._persist();
			await this.loadGrants();
		}
		try {
			localStorage.setItem(IMPORTED_FLAG_KEY, '1');
		} catch {
			/* the import is idempotent on the server; a repeat costs nothing */
		}
	}

	private _persist(): void {
		try {
			localStorage.setItem(ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY, JSON.stringify([...this._tools]));
		} catch (err) {
			console.error(
				`Failed to persist to localStorage ("${ALWAYS_ALLOWED_TOOLS_LOCALSTORAGE_KEY}"):`,
				err
			);
		}
	}
}

export const permissionsStore = new PermissionsStore();
