<script lang="ts">
	/**
	 * Settings → Server → Updates, inside Redstart Twig only.
	 *
	 * The shell (redstart-twig/windows/shell/src/update.rs) checks GitHub every
	 * six hours while automatic updates are on, downloads in the background, and
	 * verifies the installer's signature. A downloaded update installs when Twig
	 * closes, or now from "Restart to update". Nothing restarts on its own.
	 */
	import { onMount } from 'svelte';
	import type { TwigUpdatesApi, TwigUpdateStatus } from '$lib/utils/twig';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import { AlertCircle, Check, Download, Loader, RefreshCw } from '@lucide/svelte';

	let { api }: { api: TwigUpdatesApi } = $props();

	let status = $state<TwigUpdateStatus | null>(null);
	let busy = $state(false);
	let actionError = $state('');

	onMount(() => {
		api.status().then((s) => (status = s)).catch(() => {});
		return api.onStatus((s) => (status = s));
	});

	async function run(fn: () => Promise<unknown>) {
		busy = true;
		actionError = '';
		try {
			const s = await fn();
			if (s && typeof s === 'object') status = s as TwigUpdateStatus;
		} catch (err) {
			actionError = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	const checkedAt = $derived(status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : null);
</script>

<div class="space-y-4 border-t border-border/40 pt-6">
	<div>
		<h4 class="text-sm font-medium">Updates</h4>
		<p class="text-xs text-muted-foreground">
			Redstart Twig {status?.current ?? ''}. Updates download in the background and install when you
			close Twig.
		</p>
	</div>

	{#if status && !status.supported}
		<p class="text-xs text-muted-foreground">
			This build does not update itself (a development run).
		</p>
	{:else if status}
		<div class="flex items-center gap-2">
			<Switch
				id="twig-auto-update"
				checked={status.auto}
				disabled={busy}
				onCheckedChange={(on) => run(() => api.setAuto(on))}
			/>
			<Label for="twig-auto-update" class="text-sm">Check for updates automatically</Label>
		</div>

		{#if status.state === 'checking'}
			<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Loader class="h-4 w-4 animate-spin" /> Checking…
			</p>
		{:else if status.state === 'downloading'}
			<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Loader class="h-4 w-4 animate-spin" /> Downloading {status.version}…
			</p>
		{:else if status.state === 'ready'}
			<p class="flex items-center gap-1.5 text-sm">
				<Check class="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
				Version {status.version} is ready. It installs when you close Twig.
			</p>
		{:else if status.state === 'error'}
			<p class="flex items-start gap-1.5 text-sm text-destructive">
				<AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
				<span class="break-words">The last check failed: {status.error}</span>
			</p>
		{:else if checkedAt}
			<p class="text-xs text-muted-foreground">Up to date. Last checked {checkedAt}.</p>
		{/if}

		{#if actionError}
			<p class="flex items-center gap-1.5 text-sm text-destructive">
				<AlertCircle class="h-4 w-4" />
				{actionError}
			</p>
		{/if}

		<div class="flex gap-2">
			{#if status.state === 'ready'}
				<Button size="sm" onclick={() => run(() => api.install())} disabled={busy}>
					<Download class="h-3.5 w-3.5" /> Restart to update
				</Button>
			{:else}
				<Button
					variant="outline"
					size="sm"
					onclick={() => run(() => api.checkNow())}
					disabled={busy || status.state === 'checking' || status.state === 'downloading'}
				>
					<RefreshCw class="h-3.5 w-3.5" /> Check now
				</Button>
			{/if}
		</div>
	{/if}
</div>
