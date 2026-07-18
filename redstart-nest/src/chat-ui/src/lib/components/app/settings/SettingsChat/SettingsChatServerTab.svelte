<script lang="ts">
	import { onMount } from 'svelte';
	import { isCapacitorAndroid, isElectronLog } from '$lib/utils/server-url';
	import { twigFsApi } from '$lib/utils/twig';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { serverStore } from '$lib/stores/server.svelte';
	import { toolsStore } from '$lib/stores/tools.svelte';
	import { SETTINGS_KEYS } from '$lib/constants/settings-keys';
	import { NetworkDiscovery, type DiscoveredServer, type NetworkDiscoveryPlugin } from '$lib/plugins/network-discovery';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Wifi, RefreshCw, Check, AlertCircle, Loader, FolderOpen } from '@lucide/svelte';

	// ── State ─────────────────────────────────────────────────────────────────

	let serverUrl = $state(String(settingsStore.getConfig(SETTINGS_KEYS.SERVER_URL) ?? ''));
	let testStatus = $state<'idle' | 'testing' | 'ok' | 'error'>('idle');
	let testError = $state('');
	let scanning = $state(false);
	let discovered = $state<DiscoveredServer[]>([]);
	let scanError = $state('');

	const onAndroid = isCapacitorAndroid();
	const onElectron = isElectronLog();

	// ── Local file access (Twig desktop only) ─────────────────────────────────

	let localFsRoot = $state<string | null>(null);
	let fsBusy = $state(false);

	onMount(async () => {
		const api = twigFsApi();
		if (!api) return;
		try {
			const { rootDir } = await api.getRoot();
			localFsRoot = rootDir;
		} catch {
			/* not available */
		}
	});

	async function pickLocalFolder() {
		const api = twigFsApi();
		if (!api) return;
		fsBusy = true;
		try {
			const { rootDir } = await api.pickRoot();
			localFsRoot = rootDir;
			// Refresh the advertised tool set so the fs_* tools appear (or update)
			// immediately after the folder is granted.
			await toolsStore.loadLocalFsTools();
		} catch {
			/* user cancelled or bridge error */
		} finally {
			fsBusy = false;
		}
	}

	// ── Handlers ──────────────────────────────────────────────────────────────

	function applyUrl(url: string) {
		serverUrl = url.trim().replace(/\/$/, '');
		settingsStore.updateConfig(SETTINGS_KEYS.SERVER_URL, serverUrl);
		testStatus = 'idle';
		testError = '';
		void serverStore.fetch();
	}

	function handleInput(e: Event) {
		serverUrl = (e.target as HTMLInputElement).value;
		testStatus = 'idle';
	}

	function handleSave() {
		settingsStore.updateConfig(SETTINGS_KEYS.SERVER_URL, serverUrl.trim().replace(/\/$/, ''));
		testStatus = 'idle';
		void serverStore.fetch();
	}

	async function testConnection() {
		const url = serverUrl.trim().replace(/\/$/, '');
		if (!url) {
			testStatus = 'error';
			testError = 'Enter a server URL first.';
			return;
		}

		testStatus = 'testing';
		testError = '';

		try {
			const res = await fetch(`${url}/props`, { signal: AbortSignal.timeout(4000) });
			if (res.ok) {
				testStatus = 'ok';
				// Auto-apply: save the URL and connect so the user doesn't need to
				// click Save separately after a successful test.
				settingsStore.updateConfig(SETTINGS_KEYS.SERVER_URL, url);
				void serverStore.fetch();
			} else {
				testStatus = 'error';
				testError = `Server responded with ${res.status}`;
			}
		} catch (e) {
			testStatus = 'error';
			testError = e instanceof Error ? e.message : 'Connection failed';
		}
	}

	function getDiscovery(): NetworkDiscoveryPlugin {
		if (onAndroid) return NetworkDiscovery;
		// On Windows Electron, route through the preload IPC bridge instead of
		// the Capacitor plugin (which only works on Android).
		return (window as unknown as { redstartTwigAPI: { network: NetworkDiscoveryPlugin } })
			.redstartTwigAPI.network;
	}

	async function scanNetwork() {
		scanning = true;
		discovered = [];
		scanError = '';

		try {
			const discovery = getDiscovery();
			const info = await discovery.getLocalNetworkInfo();
			const result = await discovery.scanForServers({ subnet: info.subnet, timeout: 400 });
			discovered = result.servers;
			if (discovered.length === 0) {
				scanError = 'No Redstart Nest servers found. Make sure a model is running on Redstart Nest.';
			}
		} catch (e) {
			scanError = e instanceof Error ? e.message : 'Scan failed';
		} finally {
			scanning = false;
		}
	}
</script>

<div class="space-y-8">
	<!-- Server URL input -->
	<div class="space-y-3">
		<Label for="server-url">Server URL</Label>
		<p class="text-sm text-muted-foreground">
			The base URL of your Redstart/llama.cpp server on the local network (e.g.
			<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">http://192.168.1.100:8080</code
			>).
		</p>
		<div class="flex gap-2">
			<Input
				id="server-url"
				type="url"
				placeholder="http://192.168.1.100:8080"
				value={serverUrl}
				oninput={handleInput}
				class="font-mono"
			/>
			<Button variant="outline" onclick={handleSave}>Save</Button>
		</div>

		<!-- Connection test feedback -->
		{#if testStatus === 'ok'}
			<p class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
				<Check class="h-4 w-4" /> Connected successfully
			</p>
		{:else if testStatus === 'error'}
			<p class="flex items-center gap-1.5 text-sm text-destructive">
				<AlertCircle class="h-4 w-4" />
				{testError}
			</p>
		{/if}

		<div class="flex gap-2">
			<Button variant="outline" size="sm" onclick={testConnection} disabled={testStatus === 'testing'}>
				{#if testStatus === 'testing'}
					<Loader class="h-3.5 w-3.5 animate-spin" /> Testing…
				{:else}
					Test connection
				{/if}
			</Button>
		</div>
	</div>

	<!-- Network scan (Android and Windows Electron) -->
	{#if onAndroid || onElectron}
		<div class="space-y-4 border-t border-border/40 pt-6">
			<div class="flex items-center justify-between">
				<div>
					<h4 class="text-sm font-medium">Discover on Network</h4>
					<p class="text-xs text-muted-foreground">
						Scan the local network for llama.cpp servers.
					</p>
				</div>
				<Button variant="outline" size="sm" onclick={scanNetwork} disabled={scanning}>
					{#if scanning}
						<Loader class="h-3.5 w-3.5 animate-spin" /> Scanning…
					{:else}
						<Wifi class="h-3.5 w-3.5" />
						Scan
					{/if}
				</Button>
			</div>

			{#if scanError}
				<p class="text-sm text-muted-foreground">{scanError}</p>
			{/if}

			{#if discovered.length > 0}
				<ul class="space-y-2">
					{#each discovered as server}
						<li class="flex items-center justify-between rounded-md border border-border/50 bg-muted/30 px-3 py-2">
							<div>
								<p class="font-mono text-sm">{server.url}</p>
								<p class="text-xs text-muted-foreground">{server.ip}:{server.port}</p>
							</div>
							<Button size="sm" variant="ghost" onclick={() => applyUrl(server.url)}>
								<Check class="h-3.5 w-3.5" /> Use
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Local file access (Twig desktop only) -->
	{#if onElectron}
		<div class="space-y-4 border-t border-border/40 pt-6">
			<div>
				<h4 class="text-sm font-medium">Local Files</h4>
				<p class="text-xs text-muted-foreground">
					Grant a folder on this PC that the assistant may read and write directly. File tools stay
					inside the folder you choose. Leave unset to keep local file access off.
				</p>
			</div>

			{#if localFsRoot}
				<p class="flex items-center gap-1.5 text-sm">
					<Check class="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
					<span class="break-all font-mono text-xs">{localFsRoot}</span>
				</p>
			{:else}
				<p class="text-xs text-muted-foreground">
					No folder granted — local file tools are disabled.
				</p>
			{/if}

			<Button variant="outline" size="sm" onclick={pickLocalFolder} disabled={fsBusy}>
				{#if fsBusy}
					<Loader class="h-3.5 w-3.5 animate-spin" /> Working…
				{:else}
					<FolderOpen class="h-3.5 w-3.5" />
					{localFsRoot ? 'Change folder' : 'Choose folder'}
				{/if}
			</Button>
		</div>
	{/if}

	<!-- Reload note -->
	<div class="border-t border-border/40 pt-6">
		<div class="flex items-center justify-between">
			<p class="text-xs text-muted-foreground">
				Changes take effect after reloading the app.
			</p>
			<Button variant="outline" size="sm" onclick={() => window.location.reload()}>
				<RefreshCw class="h-3.5 w-3.5" /> Reload app
			</Button>
		</div>
	</div>
</div>
