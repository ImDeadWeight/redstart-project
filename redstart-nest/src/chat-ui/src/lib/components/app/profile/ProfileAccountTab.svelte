<script lang="ts">
	import { RefreshCw, Copy, Check, KeyRound, ShieldCheck } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { authStore } from '$lib/stores/auth.svelte';
	import { copyToClipboard } from '$lib/utils';
	import { toast } from 'svelte-sonner';

	// Identity details and API key management. Extracted from ProfilePage when
	// the page gained tabs; the page shell owns the header and the tab strip,
	// this owns everything under the Account tab.

	let user = $derived(authStore.user);

	let regenerating = $state(false);
	let copied = $state(false);

	// The freshly-issued key, held on the page rather than in a modal.
	//
	// The server stores only a SHA-256 hash, so a key genuinely cannot be
	// recovered later — that part is not a UI choice. What was a hassle was
	// showing it in a dialog that vanished on a stray click. Keeping it here
	// until explicitly dismissed means "copy it now" is a reasonable ask.
	let freshKey = $state('');

	function formatDate(iso?: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}

	async function handleRegenerate() {
		if (regenerating) return;
		regenerating = true;
		try {
			freshKey = await authStore.regenerateOwnApiKey();
			copied = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to regenerate API key');
		} finally {
			regenerating = false;
		}
	}

	async function handleCopy() {
		await copyToClipboard(freshKey);
		copied = true;
	}
</script>

{#if user}
	<div class="space-y-8">
		<section class="space-y-3">
			<h2 class="text-sm font-semibold">Account</h2>

			<dl class="grid gap-2 text-sm">
				<div class="flex items-center justify-between gap-2">
					<dt class="text-muted-foreground">Username</dt>
					<dd>{user.username}</dd>
				</div>
				<div class="flex items-center justify-between gap-2">
					<dt class="text-muted-foreground">Role</dt>
					<dd class="capitalize">{user.role}</dd>
				</div>
				<div class="flex items-center justify-between gap-2">
					<dt class="text-muted-foreground">Account created</dt>
					<dd>{formatDate(user.createdAt)}</dd>
				</div>
				<div class="flex items-center justify-between gap-2">
					<dt class="text-muted-foreground">Last login</dt>
					<dd>{formatDate(user.lastLoginAt)}</dd>
				</div>
			</dl>
		</section>

		<section class="space-y-3">
			<h2 class="flex items-center gap-2 text-sm font-semibold">
				<KeyRound class="h-4 w-4" />
				API key
			</h2>

			<p class="text-sm text-muted-foreground">
				Used by apps and scripts that talk to this Redstart instance on your behalf. Redstart stores
				only a hash of it, so an existing key can never be shown again — if you have lost it,
				generate a new one, which immediately stops the old one working.
			</p>

			<div class="flex flex-wrap items-center gap-3 rounded-md border border-border/40 p-3">
				<code class="rounded bg-muted px-2 py-1 font-mono text-sm">
					{user.apiKeyPrefix ? `${user.apiKeyPrefix}…` : 'None yet'}
				</code>

				<span class="flex-1 text-xs text-muted-foreground">
					Only the first characters are stored in readable form.
				</span>

				<Button variant="outline" size="sm" disabled={regenerating} onclick={handleRegenerate}>
					<RefreshCw class="h-3 w-3 {regenerating ? 'animate-spin' : ''}" />
					{user.apiKeyPrefix ? 'Generate new key' : 'Generate key'}
				</Button>
			</div>

			{#if freshKey}
				<div class="space-y-3 rounded-md border border-emerald-600/40 bg-emerald-600/5 p-3">
					<div class="flex items-center gap-2 text-sm font-medium">
						<ShieldCheck class="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
						New key generated
					</div>

					<p class="text-xs text-muted-foreground">
						Copy it now. This panel stays until you dismiss it, but once it is gone the key cannot
						be shown again. Any app still using your previous key has already stopped working.
					</p>

					<div class="flex items-center gap-2">
						<code
							class="flex-1 overflow-x-auto rounded bg-background px-2 py-2 font-mono text-sm select-all"
							>{freshKey}</code
						>

						<Button variant="outline" size="icon" class="shrink-0" onclick={handleCopy}>
							{#if copied}
								<Check class="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
							{:else}
								<Copy class="h-4 w-4" />
							{/if}
							<span class="sr-only">Copy API key</span>
						</Button>
					</div>

					<Button variant="ghost" size="sm" onclick={() => (freshKey = '')}>
						{copied ? 'Done' : 'Dismiss without copying'}
					</Button>
				</div>
			{/if}
		</section>
	</div>
{/if}
