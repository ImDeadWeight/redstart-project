<script lang="ts">
	import { apiFetch, apiPost } from '$lib/utils';
	import { authStore } from '$lib/stores/auth.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Loader, Trash2, KeyRound, RotateCw, Copy, Check } from '@lucide/svelte';

	type Account = { id: string; username: string; role: 'owner' | 'admin' | 'user'; createdAt: string; apiKeyPrefix: string };

	let accounts = $state<Account[]>([]);
	let loading = $state(true);
	let error = $state('');

	let newUsername = $state('');
	let newPassword = $state('');
	let newRole = $state<'admin' | 'user'>('user');
	// Only the Owner can create Admin accounts — an Admin viewer only ever
	// creates Users, matching the backend's canManage() enforcement.
	let creating = $state(false);

	let revealed = $state<{ username: string; apiKey: string } | null>(null);
	let confirmDeleteId = $state<string | null>(null);
	let resettingId = $state<string | null>(null);
	let resetPasswordValue = $state('');
	let busyId = $state<string | null>(null);

	async function loadAccounts() {
		loading = true;
		error = '';
		try {
			const result = await apiFetch<{ accounts: Account[] }>('/auth/accounts', { authOnly: true });
			accounts = result.accounts;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load accounts';
		} finally {
			loading = false;
		}
	}

	void loadAccounts();

	async function createAccount() {
		const username = newUsername.trim();
		if (!username || !newPassword) return;

		creating = true;
		error = '';
		try {
			const result = await apiPost<{ account: Account; apiKey: string }>('/auth/accounts', {
				username,
				password: newPassword,
				role: newRole
			});
			revealed = { username: result.account.username, apiKey: result.apiKey };
			newUsername = '';
			newPassword = '';
			newRole = 'user';
			await loadAccounts();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create account';
		} finally {
			creating = false;
		}
	}

	async function deleteAccount(id: string) {
		busyId = id;
		try {
			await apiFetch(`/auth/accounts/${id}`, { method: 'DELETE', authOnly: true });
			confirmDeleteId = null;
			await loadAccounts();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete account';
		} finally {
			busyId = null;
		}
	}

	async function submitResetPassword(id: string) {
		if (!resetPasswordValue) return;
		busyId = id;
		try {
			await apiPost(`/auth/accounts/${id}/reset-password`, { password: resetPasswordValue });
			resettingId = null;
			resetPasswordValue = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to reset password';
		} finally {
			busyId = null;
		}
	}

	async function regenerateKey(account: Account) {
		busyId = account.id;
		try {
			const result = await apiPost<{ account: Account; apiKey: string }>(
				`/auth/accounts/${account.id}/regenerate-key`,
				{}
			);
			revealed = { username: account.username, apiKey: result.apiKey };
			await loadAccounts();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to regenerate API key';
		} finally {
			busyId = null;
		}
	}

	let copied = $state(false);
	function copyKey(key: string) {
		navigator.clipboard.writeText(key);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="space-y-8">
	<!-- Newly generated key — shown once -->
	{#if revealed}
		<div class="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-3">
			<p class="text-sm font-medium">
				API key for <span class="font-mono">{revealed.username}</span> — copy it now, it won't be shown
				again:
			</p>
			<div class="flex gap-2">
				<code class="flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">{revealed.apiKey}</code>
				<Button size="sm" variant="outline" onclick={() => copyKey(revealed!.apiKey)}>
					{#if copied}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
				</Button>
			</div>
			<p class="text-xs text-muted-foreground">
				Use this as the "API Key" in Kilo Code, Continue, or any OpenAI-compatible tool.
			</p>
			<Button size="sm" variant="ghost" onclick={() => (revealed = null)}>Dismiss</Button>
		</div>
	{/if}

	{#if error}
		<p class="text-sm text-destructive">{error}</p>
	{/if}

	<!-- Create account -->
	<div class="space-y-3 border-b border-border/40 pb-6">
		<h4 class="text-sm font-medium">Create Account</h4>
		<div class="flex flex-wrap gap-2">
			<Input placeholder="Username" bind:value={newUsername} class="max-w-45" />
			<Input type="password" placeholder="Password" bind:value={newPassword} class="max-w-45" />
			<select
				bind:value={newRole}
				class="h-9 rounded-md border border-input bg-background px-2 text-sm"
			>
				<option value="user">User</option>
				{#if authStore.isOwner}
					<option value="admin">Admin</option>
				{/if}
			</select>
			<Button onclick={createAccount} disabled={creating || !newUsername.trim() || !newPassword}>
				{#if creating}<Loader class="h-3.5 w-3.5 animate-spin" />{/if} Create
			</Button>
		</div>
	</div>

	<!-- Account list -->
	<div class="space-y-2">
		<h4 class="text-sm font-medium">Accounts</h4>
		{#if loading}
			<p class="flex items-center gap-1.5 text-sm text-muted-foreground">
				<Loader class="h-3.5 w-3.5 animate-spin" /> Loading…
			</p>
		{:else if accounts.length === 0}
			<p class="text-sm text-muted-foreground">No accounts yet.</p>
		{:else}
			<ul class="space-y-2">
				{#each accounts as account (account.id)}
					<li class="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
						<div class="flex items-center justify-between gap-2">
							<div>
								<p class="text-sm font-medium">
									{account.username}
									<span class="ml-1 text-xs text-muted-foreground">({account.role})</span>
									{#if account.username === authStore.user?.username}
										<span class="ml-1 text-xs text-muted-foreground">— you</span>
									{/if}
								</p>
								<p class="text-xs text-muted-foreground">
									API key: {account.apiKeyPrefix}… · created {new Date(account.createdAt).toLocaleDateString()}
								</p>
							</div>
							<!-- The Owner account has no destructive actions here — no
							     self-service reset/delete through the admin panel, and
							     nobody else can manage it (canManage() rejects it server-side
							     regardless, but there's no reason to show controls that
							     would only ever come back 403). -->
							{#if account.role !== 'owner'}
								<div class="flex shrink-0 items-center gap-1">
									<Button
										size="sm"
										variant="ghost"
										title="Reset password"
										onclick={() => { resettingId = resettingId === account.id ? null : account.id; resetPasswordValue = ''; }}
									>
										<KeyRound class="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										title="Regenerate API key"
										disabled={busyId === account.id}
										onclick={() => regenerateKey(account)}
									>
										<RotateCw class="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										title="Delete account"
										disabled={busyId === account.id}
										onclick={() => (confirmDeleteId = confirmDeleteId === account.id ? null : account.id)}
									>
										<Trash2 class="h-3.5 w-3.5" />
									</Button>
								</div>
							{/if}
						</div>

						{#if resettingId === account.id}
							<div class="mt-2 flex gap-2">
								<Input
									type="password"
									placeholder="New password"
									bind:value={resetPasswordValue}
									class="max-w-45"
								/>
								<Button size="sm" disabled={!resetPasswordValue} onclick={() => submitResetPassword(account.id)}>
									Set Password
								</Button>
							</div>
						{/if}

						{#if confirmDeleteId === account.id}
							<div class="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
								<span class="flex-1 text-xs">Delete this account? Active sessions will be revoked.</span>
								<Button size="sm" variant="destructive" onclick={() => deleteAccount(account.id)}>Delete</Button>
								<Button size="sm" variant="ghost" onclick={() => (confirmDeleteId = null)}>Cancel</Button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
