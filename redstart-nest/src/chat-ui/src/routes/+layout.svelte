<script lang="ts">
	import '../app.css';
	import { base } from '$app/paths';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { toast } from 'svelte-sonner';

	import RedstartLoadingScreen from '$lib/components/app/RedstartLoadingScreen.svelte';
	import { LoginForm } from '$lib/components/app';
	import { authStore } from '$lib/stores/auth.svelte';
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
	import { ModeWatcher } from 'mode-watcher';
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
		} catch { /* invalid URL */ }
	}

	function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
		]);
	}

	async function initApp() {
		let scanFailed = false;

		// If the app was opened via QR deep link, apply it before anything else.
		// This sets SERVER_URL so needsScan becomes false and we skip the scan.
		if (isCapacitorAndroid()) {
			try {
				const launchUrl = await CapApp.getLaunchUrl();
				if (launchUrl?.url) handleDeepLink(launchUrl.url);
			} catch { /* ignore */ }
		}

		const needsScan = (isCapacitorAndroid() || isElectronLog()) && !getServerBaseUrl();

		if (needsScan) {
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
				} else {
					scanFailed = true;
				}
			} catch {
				scanFailed = true;
			}
		}

		loadingPhase = 'connecting';
		// On native platforms (Redstart Twig Windows/Android), only fetch if we actually
		// have a server URL — either pre-configured or just found by the scan.
		// Skipping when there's no URL prevents the error banner from appearing
		// alongside the "no server found" toast after a failed scan.
		const onNativePlatform = isCapacitorAndroid() || isElectronLog();
		if (!onNativePlatform || getServerBaseUrl()) {
			// Resolve auth state BEFORE fetching protected data. Fetching /props
			// first (the old order) meant an unauthenticated device always sent a
			// doomed request when login is required, surfacing a generic "server
			// unavailable" error instead of the login gate below ever getting a
			// chance to show.
			await authStore.init().catch(() => {});
			if (!authStore.authRequired || authStore.user) {
				await serverStore.fetch().catch(() => {});
			}
		}

		appReady = true;

		// After the loading screen fades out, nudge the user if no server was found
		if (scanFailed) {
			setTimeout(() => {
				toast('No server found automatically.', {
					description: 'Go to Settings → Server to enter your server address.',
					duration: 12000,
					action: {
						label: 'Open Settings',
						onClick: () => goto(RouterService.settings('server'))
					}
				});
			}, 550);
		}
	}

	onMount(() => {
		updateFavicon();
		mounted = true;
		void initApp();

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

	// Sync settings when server props are loaded
	$effect(() => {
		const serverProps = serverStore.props;

		if (serverProps) {
			untrack(() => {
				settingsStore.syncWithServerDefaults();
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

	// Background MCP server health checks on app load
	// Fetch enabled servers from settings and run health checks in background
	$effect(() => {
		if (!browser) return;

		const mcpServers = mcpStore.getServers();

		// Only run health checks if we have enabled servers with URLs
		const enabledServers = mcpServers.filter((s) => s.enabled && s.url.trim());

		if (enabledServers.length > 0) {
			untrack(() => {
				// Run health checks in background (don't await)
				mcpStore.runHealthChecksForServers(enabledServers, false).catch((error) => {
					console.warn('[layout] MCP health checks failed:', error);
				});
			});
		}
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

<!-- PWA update prompt -->
<div class="fixed right-4 bottom-4 z-9999 flex flex-col items-end gap-1">
	<PwaRefreshAlert
		needRefresh={$needRefresh || pwa.needRefreshByStorage}
		forceReload={pwa.needRefreshByStorage}
		{updateServiceWorker}
	/>
</div>

<Tooltip.Provider delayDuration={TOOLTIP_DELAY_DURATION}>
	<ModeWatcher />

	<Toaster richColors />

	<!-- Loading screen — covers everything until server init completes -->
	{#if !appReady}
		<div
			out:fade={{ duration: 500, easing: cubicOut }}
			class="fixed inset-0 z-9999"
		>
			<RedstartLoadingScreen phase={loadingPhase} />
		</div>
	{/if}

	<DialogConversationTitleUpdate
		bind:open={titleUpdateDialogOpen}
		currentTitle={titleUpdateCurrentTitle}
		newTitle={titleUpdateNewTitle}
		onConfirm={handleTitleUpdateConfirm}
		onCancel={handleTitleUpdateCancel}
	/>

	{#if authStore.authRequired && !authStore.user}
		<LoginForm />
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
</Tooltip.Provider>

<svelte:window onkeydown={handleKeydown} bind:innerHeight bind:innerWidth />
