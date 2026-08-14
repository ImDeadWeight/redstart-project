<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';

	import RedstartLoadingScreen from '$lib/components/app/RedstartLoadingScreen.svelte';
	import { LoginForm } from '$lib/components/app';
	import { authStore } from '$lib/stores/auth.svelte';
	import { setUnauthorizedHandler } from '$lib/utils';
	import { App as CapApp } from '@capacitor/app';
	import { NetworkDiscovery, type NetworkDiscoveryPlugin } from '$lib/plugins/network-discovery';
	import { isCapacitorAndroid, isElectronLog, getServerBaseUrl } from '$lib/utils/server-url';
	import { SETTINGS_KEYS } from '$lib/constants/settings-keys';

	import {
		DesktopIconStrip,
		DialogConversationTitleUpdate,
		SidebarNavigation
	} from '$lib/components/app';
	import { PwaMetaTags, PwaRefreshAlert } from '$lib/components/pwa';
	import { pwaAssetsHead } from 'virtual:pwa-assets/head';

	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { isRouterMode, serverStore } from '$lib/stores/server.svelte';
	import { config, settingsStore } from '$lib/stores/settings.svelte';
	import { twigShellApi } from '$lib/utils/twig';
	import { ROUTES } from '$lib/constants/routes';
	import { RouterService } from '$lib/services/router.service';
	import { Toaster } from 'svelte-sonner';
	import { modelsStore } from '$lib/stores/models.svelte';
	import { mcpStore } from '$lib/stores/mcp.svelte';
	import { TOOLTIP_DELAY_DURATION } from '$lib/constants';
	import { FAVICON_PATHS, FAVICON_SELECTORS } from '$lib/constants/pwa';
	import { useKeyboardShortcuts } from '$lib/hooks/use-keyboard-shortcuts.svelte';
	import { usePwa } from '$lib/hooks/use-pwa.svelte';
	import { useSettingsNavigation } from '$lib/hooks/use-settings-navigation.svelte';
	import { conversations } from '$lib/stores/conversations.svelte';
	import { isMobile } from '$lib/stores/viewport.svelte';
	import { theme } from '$lib/stores/theme.svelte';

	let { children } = $props();
	let alwaysShowSidebarOnDesktop = $derived(config().alwaysShowSidebarOnDesktop);
	let isDesktop = $derived(!isMobile.current);
	let sidebarOpen = $state(false);
	let mounted = $state(false);
	let appReady = $state(false);
	let loadingPhase = $state<'scanning' | 'connecting'>('connecting');
	let innerHeight = $state<number | undefined>();
	let innerWidth = $state(browser ? window.innerWidth : 0);

	let chatSidebar:
		| {
				activateSearchMode?: () => void;
				editActiveConversation?: () => void;
		  }
		| undefined = $state();

	let titleUpdateDialogOpen = $state(false);
	let titleUpdateCurrentTitle = $state('');
	let titleUpdateNewTitle = $state('');
	let titleUpdateResolve: ((value: boolean) => void) | null = null;

	const panelNav = useSettingsNavigation();
	// Keep the hook object intact: destructuring needRefreshByStorage reads the getter once and freezes it
	const pwa = usePwa();
	const { needRefresh, updateServiceWorker } = pwa;

	// Native shells (Twig Windows, Android) talk to a *remote* server, so a
	// reachable connection is not guaranteed the way it is for the web-ui served
	// directly by Redstart Nest. Used to gate the chat and to offer server setup.
	const onNative = isCapacitorAndroid() || isElectronLog();

	function updateFavicon() {
		const dark = theme.isSystemDark;

		let icoLink = document.querySelector(FAVICON_SELECTORS.ICO_48X48) as HTMLLinkElement | null;
		if (icoLink) {
			icoLink.href = dark ? FAVICON_PATHS.ICO_DARK : FAVICON_PATHS.ICO_LIGHT;
		}

		let svgLink = document.querySelector(FAVICON_SELECTORS.SVG_ANY) as HTMLLinkElement | null;
		if (svgLink) {
			svgLink.href = dark ? FAVICON_PATHS.SVG_DARK : FAVICON_PATHS.SVG_LIGHT;
		}
	}

	function navigateToConversation(direction: -1 | 1) {
		const allConvs = conversations();

		if (allConvs.length === 0) return;

		const currentId = page.params.id;

		if (!currentId) {
			goto(RouterService.chat(allConvs[direction === 1 ? 0 : allConvs.length - 1].id));

			return;
		}

		const idx = allConvs.findIndex((c) => c.id === currentId);

		if (idx === -1) return;

		const targetIdx = idx + direction;

		if (targetIdx >= 0 && targetIdx < allConvs.length) {
			goto(RouterService.chat(allConvs[targetIdx].id));
		} else {
			goto(ROUTES.NEW_CHAT);
		}
	}

	// Global keyboard shortcuts
	const { handleKeydown } = useKeyboardShortcuts({
		editActiveConversation: () => chatSidebar?.editActiveConversation?.(),
		navigateToPrevConversation: () => navigateToConversation(-1),
		navigateToNextConversation: () => navigateToConversation(1)
	});

	function checkApiKey() {
		const apiKey = config().apiKey;

		// No API key configured — server doesn't require auth, no need to validate.
		// This mirrors the early return in validateApiKey() to avoid redundant /props requests.
		if (!apiKey || apiKey.trim() === '') {
			return;
		}

		untrack(() => {
			if (
				(page.route.id === '/(chat)' || page.route.id === '/(chat)/chat/[id]') &&
				page.status !== 401 &&
				page.status !== 403
			) {
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey.trim()}`
				};

				fetch(`${base}/props`, { headers })
					.then((response) => {
						if (response.status === 401 || response.status === 403) {
							window.location.reload();
						}
					})
					.catch((e) => {
						console.error('Error checking API key:', e);
					});
			}
		});
	}

	function handleTitleUpdateCancel() {
		titleUpdateDialogOpen = false;

		if (titleUpdateResolve) {
			titleUpdateResolve(false);
			titleUpdateResolve = null;
		}
	}

	function handleTitleUpdateConfirm() {
		titleUpdateDialogOpen = false;

		if (titleUpdateResolve) {
			titleUpdateResolve(true);
			titleUpdateResolve = null;
		}
	}

	// handleDeepLink processes redstart://connect?url=http://... URIs that come in
	// when the user scans a QR code from Redstart Nest. I handle it in the layout
	// (rather than a dedicated route) because the connection state needs to be
	// set up before any child route renders, and the layout is always mounted.
	// The redstart:// scheme is registered in AndroidManifest.xml so the OS knows
	// to open Redstart Twig when the camera sees one of these codes.
	function handleDeepLink(url: string) {
		try {
			const parsed = new URL(url);
			if (parsed.protocol === 'redstart:' && parsed.hostname === 'connect') {
				const serverUrl = parsed.searchParams.get('url');
				if (serverUrl) {
					settingsStore.updateConfig(SETTINGS_KEYS.SERVER_URL, serverUrl);
					void serverStore.fetch();
					toast.success('Connected to Redstart Nest!', { duration: 3000 });
				}
			}
		} catch {
			/* invalid URL */
		}
	}

	function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
		]);
	}

	// ---------------------------------------------------------------------------
	// Startup connect, with retries.
	//
	// The common case for a desktop client is being opened BEFORE the server —
	// the person turns on their laptop, then goes and starts the model. A single
	// scan at startup fails in that situation and left the app on the loading
	// screen permanently: nothing re-scanned, no server URL was ever stored, and
	// because the connect step was skipped entirely `serverStore.error` stayed
	// null — so even the error state (which has a Retry button) never rendered.
	// The only way out was restarting Twig.
	//
	// So: keep trying for a couple of minutes, then hand over to the user with a
	// visible Retry. Both halves matter — silent retrying that never ends is just
	// a nicer-looking hang.
	// ---------------------------------------------------------------------------

	const RETRY_INTERVAL_MS = 10_000;
	const RETRY_WINDOW_MS = 120_000;

	/** Retrying in the background; drives the loading screen's "retrying" text. */
	let retrying = $state(false);
	/** The retry window elapsed without a connection — the user takes over. */
	let retriesExhausted = $state(false);

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	/**
	 * Did we reach a server? Reaching the LOGIN screen counts — that is a server
	 * answering, and the retry loop's job is connectivity, not authentication.
	 */
	function isConnected(): boolean {
		if (authStore.serverReachable) return true;
		return !!serverStore.props && !serverStore.error;
	}

	/** One connect attempt: discover if needed, then resolve auth and props. */
	async function attemptConnect(): Promise<boolean> {
		const onNativePlatform = isCapacitorAndroid() || isElectronLog();

		if (onNativePlatform && !getServerBaseUrl()) {
			loadingPhase = 'scanning';
			try {
				// Both Android (Capacitor) and Redstart Twig Windows expose the same
				// NetworkDiscoveryPlugin interface — Capacitor via its native plugin,
				// Windows via an IPC bridge in the Electron preload.
				const discovery: NetworkDiscoveryPlugin = isCapacitorAndroid()
					? NetworkDiscovery
					: (window as unknown as { redstartTwigAPI: { network: NetworkDiscoveryPlugin } })
							.redstartTwigAPI.network;

				const info = await raceTimeout(discovery.getLocalNetworkInfo(), 5000);
				const result = await raceTimeout(
					discovery.scanForServers({ subnet: info.subnet, timeout: 400 }),
					8000
				);
				if (result.servers.length > 0) {
					settingsStore.updateConfig(SETTINGS_KEYS.SERVER_URL, result.servers[0].url);
				}
			} catch {
				/* scan failed this round — the caller decides whether to try again */
			}
		}

		loadingPhase = 'connecting';
		if (onNativePlatform && !getServerBaseUrl()) return false; // nothing to connect to yet

		// Resolve auth state BEFORE fetching protected data. Fetching /props
		// first (the old order) meant an unauthenticated device always sent a
		// doomed request when login is required, surfacing a generic "server
		// unavailable" error instead of the login gate below ever getting a
		// chance to show.
		await authStore.init().catch(() => {});
		if (!authStore.authRequired || authStore.user) {
			await serverStore.fetch().catch(() => {});
		}
		return isConnected();
	}

	/** Attempt, then keep attempting on an interval until the window elapses. */
	async function connectWithRetries() {
		retriesExhausted = false;
		if (await attemptConnect()) {
			retrying = false;
			return;
		}

		retrying = true;
		const deadline = Date.now() + RETRY_WINDOW_MS;
		while (Date.now() < deadline) {
			await sleep(RETRY_INTERVAL_MS);
			// A URL entered in Settings, or a QR deep link, resolves this from
			// elsewhere — stop rather than fighting whatever the user just did.
			if (isConnected()) break;
			if (await attemptConnect()) break;
		}

		retrying = false;
		if (!isConnected()) retriesExhausted = true;
	}

	async function initApp() {
		// If the app was opened via QR deep link, apply it before anything else.
		// This sets SERVER_URL so the scan below is skipped.
		if (isCapacitorAndroid()) {
			try {
				const launchUrl = await CapApp.getLaunchUrl();
				if (launchUrl?.url) handleDeepLink(launchUrl.url);
			} catch {
				/* ignore */
			}
		}

		// One attempt before revealing the UI, so an already-running server
		// connects instantly with no flash of a "retrying" message.
		await attemptConnect();
		appReady = true;

		// Not connected yet: keep trying in the background while the loading
		// screen explains what is happening.
		if (!isConnected()) void connectWithRetries();
	}

	// The loading screen's Retry button: restart the whole loop, including
	// rediscovery. Previously this only re-fetched auth + props, so on a device
	// that had never found a server there was nothing to re-fetch and the button
	// did nothing visible.
	async function retryConnect() {
		if (retrying) return; // already trying; a second loop would double the traffic
		await connectWithRetries();
	}

	// Let the user reach server setup from the loading screen when disconnected.
	function openServerSettings() {
		goto(RouterService.settings('server'));
	}

	onMount(() => {
		// Route every authenticated request's 401 through the auth store so a
		// dead session drops back to the login gate. Registered here at runtime
		// (not at module scope in the auth store) to avoid a circular-import
		// evaluation cycle during SvelteKit's prerender analysis. Set before
		// initApp() so the very first auth check is already covered.
		setUnauthorizedHandler(() => authStore.handleUnauthorized());

		updateFavicon();
		mounted = true;
		void initApp();

		// Twig desktop only (no-op elsewhere): mirror local stdio MCP servers
		// from twig-mcp.json into the settings list. Runs on mount, not on
		// server-props load, because local servers exist without a Nest.
		void mcpStore.syncLocalServersFromTwig();

		// Handle QR deep links while the app is already running
		if (isCapacitorAndroid()) {
			CapApp.addListener('appUrlOpen', (data) => handleDeepLink(data.url));
		}
	});

	$effect(() => {
		void theme.isSystemDark;

		updateFavicon();
	});

	$effect(() => {
		if (alwaysShowSidebarOnDesktop && isDesktop) {
			sidebarOpen = true;

			return;
		}
	});

	// Twig desktop only: colour the window-controls overlay (min/max/close) to
	// match the app. No-op elsewhere. The theme name is a constant now that the
	// app is dark-only, but the background is still read from the DOM (below).
	$effect(() => {
		const shell = twigShellApi();
		if (!shell) return;
		// Send the background colour the app is ACTUALLY painting, not just the
		// theme name. The Electron shell colours the window-controls overlay (the
		// strip behind minimise/maximise/close), and it used to map theme -> a
		// hardcoded hex. Those two values drifted: the app renders
		// oklch(0.12 0 0) = #060606 while the overlay was #09090b, leaving a
		// visibly lighter band behind the buttons. Reading the computed value
		// means the overlay follows the theme by construction instead of by two
		// constants happening to agree.
		const background = getComputedStyle(document.body).backgroundColor;
		void shell.setTheme('dark', background);
	});

	// Twig desktop runs frameless (hidden title bar + window-controls overlay).
	// The `twig-desktop` class activates the drag strip and the layout offsets
	// that make room for it (see app.css).
	const inTwigShell = twigShellApi() !== null;
	$effect(() => {
		if (inTwigShell) document.documentElement.classList.add('twig-desktop');
	});

	// Sync settings when server props are loaded
	$effect(() => {
		const serverProps = serverStore.props;

		if (serverProps) {
			untrack(() => {
				settingsStore.syncWithServerDefaults();
				// MCP servers are managed centrally in Redstart Nest — pull the
				// current list from the host instead of per-device settings.
				void mcpStore.syncServersFromHost();
			});
		}
	});

	// Re-fetch server props once a login succeeds. The initial mount either
	// skipped this fetch entirely (auth required, no session yet) or it
	// already failed with a 401 — nothing else retries it once a session
	// exists, so a successful login would otherwise leave a stale error on
	// screen until a manual refresh.
	let serverFetchedForUser: string | null = null;
	$effect(() => {
		const user = authStore.user;
		if (user && serverFetchedForUser !== user.id && (!serverStore.props || serverStore.error)) {
			serverFetchedForUser = user.id;
			void serverStore.fetch();
		}
	});

	// Inject custom CSS at runtime through an action on the head style node
	// textContent keeps the value as text, never parsed as HTML
	function customCss(node: HTMLStyleElement) {
		$effect(() => {
			node.textContent = (config().customCss as string | undefined) ?? '';
		});
	}

	// Fetch router models when in router mode (for status and modalities)
	// Wait for models to be loaded first, run only once
	let routerModelsFetched = false;

	$effect(() => {
		const isRouter = isRouterMode();
		const modelsCount = modelsStore.models.length;

		// Only fetch router models once when we have models loaded and in router mode
		if (isRouter && modelsCount > 0 && !routerModelsFetched) {
			routerModelsFetched = true;

			untrack(() => {
				modelsStore.fetchRouterModels();
			});
		}
	});

	// Background MCP server health checks.
	//
	// Gated on auth being RESOLVED, and re-run when the identity or the server
	// set changes — the same rule, for the same reason, as the server-props
	// effect above.
	//
	// The server list comes from persisted settings, so it is populated on the
	// very first paint, long before authStore.init() has exchanged a token.
	// Running then sent every check with whatever token localStorage still held
	// — and sessions live in memory server-side, so an app restart invalidates
	// exactly that token. Every cold start therefore failed its health checks
	// with a 401. Nothing retried once the real session arrived a few seconds
	// later, so the server sat in a permanent error state: the MCP toggle showed
	// an error and its tools never appeared, until a manual reload that happened
	// to reuse a still-valid token.
	//
	// Keyed by identity + the enabled server ids, so a login and a host re-sync
	// that provisions new servers both re-check, while a steady state does not
	// re-check on every unrelated settings change.
	let healthCheckKey: string | null = null;
	$effect(() => {
		if (!browser) return;

		// Auth unresolved: a check now would be sent with a stale token or none.
		if (!authStore.checked) return;
		// Login required but not yet done — the gate is up; nothing to authenticate with.
		if (authStore.authRequired && !authStore.user) return;

		const enabledServers = mcpStore.getServers().filter((s) => s.enabled && s.url.trim());
		if (enabledServers.length === 0) return;

		const identity = authStore.user?.id ?? 'anonymous';
		const key = `${identity}|${enabledServers.map((s) => s.id).sort().join(',')}`;
		if (healthCheckKey === key) return;
		healthCheckKey = key;

		untrack(() => {
			// Run health checks in background (don't await)
			mcpStore.runHealthChecksForServers(enabledServers, false).catch((error) => {
				console.warn('[layout] MCP health checks failed:', error);
			});
		});
	});

	// Monitor API key changes and redirect to error page if removed or changed when required
	$effect(() => {
		checkApiKey();
	});

	// Set up title update confirmation callback
	$effect(() => {
		conversationsStore.setTitleUpdateConfirmationCallback(
			async (currentTitle: string, newTitle: string) => {
				return new Promise<boolean>((resolve) => {
					titleUpdateCurrentTitle = currentTitle;
					titleUpdateNewTitle = newTitle;
					titleUpdateResolve = resolve;
					titleUpdateDialogOpen = true;
				});
			}
		);
	});
</script>

<svelte:head>
	{#if pwaAssetsHead.themeColor}
		<meta name="theme-color" content={pwaAssetsHead.themeColor.content} />
	{/if}

	{#if config().customCss}
		<style use:customCss></style>
	{/if}

	{#each pwaAssetsHead.links as link (link.href)}
		<link {...link} />
	{/each}

	<PwaMetaTags />
</svelte:head>

{#if inTwigShell}
	<!-- Frameless-window drag strip. Spans the top edge under the OS-drawn
	     min/max/close overlay buttons; -webkit-app-region: drag makes it the
	     window's title bar (drag to move, double-click to maximize). -->
	<div class="twig-titlebar" aria-hidden="true"></div>
{/if}

<!-- PWA update prompt -->
<div class="fixed right-4 bottom-4 z-9999 flex flex-col items-end gap-1">
	<PwaRefreshAlert
		needRefresh={$needRefresh || pwa.needRefreshByStorage}
		forceReload={pwa.needRefreshByStorage}
		{updateServiceWorker}
	/>
</div>

<Tooltip.Provider delayDuration={TOOLTIP_DELAY_DURATION}>
	<Toaster richColors />

	<!-- Pre-chat gate. The chat is never revealed until there is a live server
	     connection (and a session, when login is required). Loading and
	     connection-error states live HERE, on the loading screen — not inside the
	     chat window. Native shells can still reach server settings while
	     disconnected so they can point the app at a server. -->
	{#if !appReady}
		<RedstartLoadingScreen phase={loadingPhase} />
	{:else if authStore.authRequired && !authStore.user}
		<LoginForm />
	{:else if !(serverStore.props && !serverStore.error) && !(onNative && panelNav.isSettingsRoute)}
		<!-- `error` is null when the connect step never ran (no server found to
		     connect TO), which used to render a bare spinner with no way out.
		     `retrying`/`retriesExhausted` carry that case: keep the user informed
		     while we retry, then show Retry once we stop. -->
		<RedstartLoadingScreen
			phase="connecting"
			error={serverStore.error}
			{retrying}
			showRetry={retriesExhausted || !!serverStore.error}
			onRetry={retryConnect}
			onOpenSettings={onNative ? openServerSettings : undefined}
		/>
	{:else}
		<Sidebar.Provider bind:open={sidebarOpen}>
			<div class="flex h-dvh w-full">
				<Sidebar.Root variant="floating" class="h-full"
					><SidebarNavigation bind:this={chatSidebar} /></Sidebar.Root
				>

				{#if !(alwaysShowSidebarOnDesktop && isDesktop) && !(panelNav.isSettingsRoute && !isDesktop)}
					{#if mounted}
						<div in:fade={{ duration: 200 }}>
							<Sidebar.Trigger
								class="transition-left absolute left-0 z-900 duration-200 ease-linear {sidebarOpen
									? 'left-[calc(var(--sidebar-width)+0.75rem)] max-md:hidden'
									: 'left-0!'}"
								style="translate: 1rem 1rem;"
							/>
						</div>
					{/if}
				{/if}

				{#if isDesktop && !alwaysShowSidebarOnDesktop}
					<DesktopIconStrip
						{sidebarOpen}
						onSearchClick={() => {
							if (chatSidebar?.activateSearchMode) {
								chatSidebar.activateSearchMode();
							}

							sidebarOpen = true;
						}}
					/>
				{/if}

				<Sidebar.Inset class="flex flex-1 flex-col overflow-hidden">
					{@render children?.()}
				</Sidebar.Inset>
			</div>
		</Sidebar.Provider>
	{/if}

	<DialogConversationTitleUpdate
		bind:open={titleUpdateDialogOpen}
		currentTitle={titleUpdateCurrentTitle}
		newTitle={titleUpdateNewTitle}
		onConfirm={handleTitleUpdateConfirm}
		onCancel={handleTitleUpdateCancel}
	/>
</Tooltip.Provider>

<svelte:window onkeydown={handleKeydown} bind:innerHeight bind:innerWidth />
