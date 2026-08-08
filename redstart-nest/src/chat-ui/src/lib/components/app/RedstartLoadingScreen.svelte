<script lang="ts">
	// Shares the login page's shell (see LoginForm.svelte) so the pre-chat states
	// — loading, connection error — look like one continuous screen. The chat is
	// never revealed behind this; the layout gates on it.
	interface Props {
		phase?: 'scanning' | 'connecting';
		/** Connection error message. When set, shows the error state. */
		error?: string | null;
		/** Still retrying in the background — say so rather than showing a bare spinner. */
		retrying?: boolean;
		/**
		 * Offer the Retry button.
		 *
		 * Separate from `error` because the worst case has NO error message: when
		 * no server was ever found there was nothing to connect to, so nothing
		 * failed, so `error` stayed null — and the screen showed an endless
		 * spinner with no way out. Whether the user can act is a different
		 * question from whether something errored.
		 */
		showRetry?: boolean;
		/** Retry the server connection. */
		onRetry?: () => void;
		/** Open server settings (native shells, so the user can point at a server). */
		onOpenSettings?: () => void;
	}
	let {
		phase = 'connecting',
		error = null,
		retrying = false,
		showRetry = false,
		onRetry,
		onOpenSettings
	}: Props = $props();

	const subtitle = $derived(
		retrying
			? 'Looking for your server…'
			: phase === 'scanning'
				? 'Scanning local network…'
				: 'Redstart is nesting'
	);
</script>

<!-- bg-background, not a hardcoded zinc: this screen covers the whole window,
     including Twig's drag strip at z-1000, so any shade that isn't --background
     shows up as a lighter window that darkens the moment the chat appears. -->
<div class="fixed inset-0 z-9999 flex items-center justify-center bg-background">
	<div class="flex w-full max-w-xs flex-col items-center gap-6 px-6">
		<img
			src="/redstart.svg"
			alt="Redstart"
			width="64"
			height="64"
			style="image-rendering: pixelated"
		/>

		<div class="flex flex-col items-center gap-1">
			<h1 class="text-xl font-bold tracking-tight text-white">Redstart</h1>
			{#if !error}
				<p class="text-sm text-zinc-400">{subtitle}</p>
			{/if}
		</div>

		{#if error || showRetry}
			<div class="flex w-full flex-col items-center gap-4">
				{#if error}
					<div class="w-full rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-center">
						<p class="text-sm font-medium text-red-400">Can’t reach the server</p>
						<p class="mt-1 text-xs wrap-break-word text-red-400/80">{error}</p>
					</div>
				{:else}
					<!-- No error to report because nothing failed — there was simply no
					     server to reach. Say that plainly instead of showing a red box
					     about a request that was never made. -->
					<div class="w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-center">
						<p class="text-sm font-medium text-zinc-200">No server found</p>
						<p class="mt-1 text-xs text-zinc-400">
							Make sure Redstart Nest is running and a model has been started, then try again.
						</p>
					</div>
				{/if}
				<div class="flex w-full flex-col gap-2">
					{#if onRetry}
						<button
							type="button"
							onclick={onRetry}
							class="w-full rounded bg-orange-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-400"
						>
							Retry
						</button>
					{/if}
					{#if onOpenSettings}
						<button
							type="button"
							onclick={onOpenSettings}
							class="w-full rounded border border-zinc-700 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
						>
							Server settings
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div
				class="h-8 w-8 animate-spin rounded-full border-[3px] border-zinc-700 border-t-orange-500"
			></div>
			{#if retrying}
				<!-- Retrying silently is indistinguishable from being hung. -->
				<p class="text-center text-xs text-zinc-500">
					Retrying every 10 seconds. Start Redstart Nest and this will connect on its own.
				</p>
			{/if}
		{/if}
	</div>
</div>
