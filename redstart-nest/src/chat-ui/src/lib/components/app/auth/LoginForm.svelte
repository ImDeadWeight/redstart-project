<script lang="ts">
	import { authStore } from '$lib/stores/auth.svelte';

	let username = $state('');
	let password = $state('');
	let submitting = $state(false);
	let error = $state('');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!username.trim() || !password || submitting) return;

		submitting = true;
		error = '';

		try {
			await authStore.login(username.trim(), password);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Login failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="fixed inset-0 z-9999 flex items-center justify-center bg-zinc-950">
	<form onsubmit={handleSubmit} class="flex w-full max-w-xs flex-col items-center gap-6 px-6">
		<img src="/redstart.svg" alt="Redstart" width="64" height="64" style="image-rendering: pixelated" />

		<div class="flex flex-col items-center gap-1">
			<h1 class="text-xl font-bold tracking-tight text-white">Redstart</h1>
			<p class="text-sm text-zinc-400">Sign in to continue</p>
		</div>

		<div class="flex w-full flex-col gap-3">
			<input
				type="text"
				bind:value={username}
				placeholder="Username"
				autocomplete="username"
				class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-orange-500 focus:outline-none"
			/>
			<input
				type="password"
				bind:value={password}
				placeholder="Password"
				autocomplete="current-password"
				class="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-orange-500 focus:outline-none"
			/>
		</div>

		{#if error}
			<p class="text-xs text-red-400">{error}</p>
		{/if}

		<button
			type="submit"
			disabled={submitting || !username.trim() || !password}
			class="w-full rounded bg-orange-500 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
		>
			{submitting ? 'Signing in…' : 'Sign in'}
		</button>
	</form>
</div>
