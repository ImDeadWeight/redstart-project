<script lang="ts">
	import { authStore, type ConnectorKey } from '$lib/stores/auth.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import { copyToClipboard } from '$lib/utils';
	import { Loader, Plus, Trash2, Copy, KeyRound } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';

	let keys = $state<ConnectorKey[]>([]);
	let surfaces = $state<string[]>([]);
	let loading = $state(true);
	let issuing = $state(false);
	let revokingId = $state<string | null>(null);
	let error = $state('');

	let newSurface = $state('');
	let newLabel = $state('');

	let revealOpen = $state(false);
	let revealedKey = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const result = await authStore.listClientKeys();
			keys = result.clientKeys;
			surfaces = result.surfaces;
			if (!newSurface && surfaces.length) newSurface = surfaces[0];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load connector keys';
		} finally {
			loading = false;
		}
	}

	void load();

	async function issue() {
		if (!newSurface || issuing) return;
		issuing = true;
		error = '';
		try {
			const result = await authStore.issueClientKey(newSurface, newLabel.trim() || undefined);
			revealedKey = result.apiKey;
			revealOpen = true;
			newLabel = '';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to issue key';
		} finally {
			issuing = false;
		}
	}

	async function revoke(key: ConnectorKey) {
		revokingId = key.id;
		try {
			await authStore.revokeClientKey(key.id);
			toast.success(`Revoked ${key.label}`);
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to revoke key');
		} finally {
			revokingId = null;
		}
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<p class="text-sm text-muted-foreground">
		Connector apps — Blueprints, Yellowscript, and others — authenticate with a key issued for a
		specific app. The server identifies which app is calling from the key itself, which is why a
		connector cannot simply claim to be something else. Keys act on your account only.
	</p>

	{#if error}
		<div class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>
	{/if}

	{#if loading}
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<Loader class="h-4 w-4 animate-spin" />
			Loading keys…
		</div>
	{:else}
		<div class="space-y-2">
			<div class="text-sm font-medium">Issue a key</div>

			<div class="flex flex-wrap items-center gap-2">
				<select
					bind:value={newSurface}
					class="h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
					aria-label="Connector app"
				>
					{#each surfaces as surface (surface)}
						<option value={surface}>{surface}</option>
					{/each}
				</select>

				<Input
					bind:value={newLabel}
					placeholder="Label (e.g. work laptop)"
					class="h-9 max-w-56"
					maxlength={64}
				/>

				<Button size="sm" class="h-9" disabled={issuing || !newSurface} onclick={issue}>
					{#if issuing}
						<Loader class="h-3 w-3 animate-spin" />
					{:else}
						<Plus class="h-3 w-3" />
					{/if}
					Issue
				</Button>
			</div>
		</div>

		<div class="space-y-2">
			<div class="text-sm font-medium">Your keys</div>

			{#if keys.length === 0}
				<p class="text-sm text-muted-foreground">
					No connector keys yet. Apps can still connect with your account API key, but the server
					will not know which app they are.
				</p>
			{:else}
				<div class="divide-y divide-border/40 rounded-md border border-border/40">
					{#each keys as key (key.id)}
						<div class="flex items-center gap-3 p-3">
							<KeyRound class="h-4 w-4 shrink-0 text-muted-foreground" />

							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium">{key.label}</div>
								<div class="text-xs text-muted-foreground">
									{key.surface} · {key.keyPrefix}… · issued {formatDate(key.createdAt)}
								</div>
							</div>

							<Button
								variant="outline"
								size="sm"
								class="h-8 shrink-0"
								disabled={revokingId === key.id}
								onclick={() => revoke(key)}
							>
								{#if revokingId === key.id}
									<Loader class="h-3 w-3 animate-spin" />
								{:else}
									<Trash2 class="h-3 w-3" />
								{/if}
								Revoke
							</Button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<Dialog.Root bind:open={revealOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>New connector key</Dialog.Title>
			<Dialog.Description>
				Copy it now — it is shown once and only its hash is stored, so it cannot be retrieved
				again. Revoking and re-issuing is the way to recover from a lost key.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-2">
			<code class="flex-1 truncate rounded bg-muted px-2 py-2 font-mono text-sm">{revealedKey}</code>
			<Button
				variant="outline"
				size="icon"
				class="shrink-0"
				onclick={() => copyToClipboard(revealedKey)}
			>
				<Copy class="h-4 w-4" />
				<span class="sr-only">Copy key</span>
			</Button>
		</div>

		<Dialog.Footer>
			<Button onclick={() => (revealOpen = false)}>Done</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
