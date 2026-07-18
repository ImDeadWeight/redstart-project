import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { versionStore } from '$lib/stores/version.svelte';
import { BUILD_VERSION_LOCALSTORAGE_KEY } from '$lib/constants/storage';

/**
 * Build-version update detection — deliberately WITHOUT a service worker.
 *
 * Redstart is a client for a LAN server: with the server unreachable there is
 * nothing useful to do offline, so the PWA service worker's only real effect
 * here was caching a stale app shell that shadowed freshly-deployed builds (it
 * repeatedly made new builds look like they "didn't load"). We therefore do NOT
 * register it, and we tear down any service worker + caches a previous PWA build
 * left behind so affected browsers self-heal on next load.
 *
 * Update awareness is preserved cheaply: SvelteKit emits a build version
 * (_app/version.json); when it changes since the last load we surface a
 * "reload for the new version" prompt — all the update signal, none of the
 * stale-cache cost.
 */
export function usePwa() {
	// Self-heal: unregister any service worker and drop its caches from earlier
	// PWA builds. Runs once on hook init (i.e. app load).
	if (browser && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
		navigator.serviceWorker
			.getRegistrations()
			.then((regs) => regs.forEach((r) => r.unregister()))
			.catch(() => {});
		if ('caches' in window) {
			caches
				.keys()
				.then((keys) => keys.forEach((k) => caches.delete(k)))
				.catch(() => {});
		}
	}

	let needRefreshByStorage = $state(false);

	// Detect a newly deployed build and prompt a reload. _app/version.json is
	// SvelteKit's native build-version file.
	$effect(() => {
		if (!browser) return;

		const currentVersion = versionStore.value;
		if (!currentVersion) return;

		try {
			const storedVersion = localStorage.getItem(BUILD_VERSION_LOCALSTORAGE_KEY);
			needRefreshByStorage = !!storedVersion && storedVersion !== currentVersion;
			localStorage.setItem(BUILD_VERSION_LOCALSTORAGE_KEY, currentVersion);
		} catch {
			needRefreshByStorage = false;
		}
	});

	// Kept false: there is no service-worker update signal anymore.
	const noRefresh = writable(false);

	return {
		get needRefresh() {
			return noRefresh;
		},
		/** With no service worker, applying an update is just a reload. */
		updateServiceWorker: () => {
			if (browser) window.location.reload();
		},
		/** True when the deployed build version changed since the last load. */
		get needRefreshByStorage() {
			return needRefreshByStorage;
		}
	};
}
