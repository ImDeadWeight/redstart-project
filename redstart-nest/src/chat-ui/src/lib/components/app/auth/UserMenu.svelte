<script lang="ts">
	import { CircleUser, LogOut, RefreshCw, Copy } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { authStore } from '$lib/stores/auth.svelte';
	import { copyToClipboard } from '$lib/utils';
	import { toast } from 'svelte-sonner';

	let user = $derived(authStore.user);

	let regenerating = $state(false);
	let revealOpen = $state(false);
	let newKey = $state('');

	function formatDate(iso?: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return isNaN(d.getTime()) ? '—' : d.toLocaleString();
	}

	async function handleRegenerate() {
		if (regenerating) return;
		regenerating = true;
		try {
			newKey = await authStore.regenerateOwnApiKey();
			revealOpen = true;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to regenerate API key');
		} finally {
			regenerating = false;
		}
	}

	async function handleLogout() {
		await authStore.logout();
	}
</script>

{#if user}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			class="flex max-w-[9rem] items-center gap-1.5 rounded-full px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			aria-label="Account menu"
		>
			<CircleUser class="h-4 w-4 shrink-0" />
			<span class="truncate">{user.username}</span>
		</DropdownMenu.Trigger>

		<DropdownMenu.Content class="w-72" align="start">
			<div class="px-2 py-1.5">
				<div class="flex items-center justify-between gap-2">
					<span class="truncate font-medium">{user.username}</span>
					<Badge variant="secondary" class="capitalize">{user.role}</Badge>
				</div>
			</div>

			<DropdownMenu.Separator />

			<div class="space-y-1 px-2 py-1.5 text-xs text-muted-foreground">
				<div class="flex items-center justify-between gap-2">
					<span>Account created</span>
					<span class="text-foreground">{formatDate(user.createdAt)}</span>
				</div>
				<div class="flex items-center justify-between gap-2">
					<span>Last login</span>
					<span class="text-foreground">{formatDate(user.lastLoginAt)}</span>
				</div>
			</div>

			<DropdownMenu.Separator />

			<div class="px-2 py-1.5">
				<div class="mb-1 text-xs text-muted-foreground">API key</div>
				<div class="flex items-center justify-between gap-2">
					<code class="truncate rounded bg-muted px-1.5 py-0.5 text-xs">
						{user.apiKeyPrefix ? `${user.apiKeyPrefix}…` : '—'}
					</code>
					<Button
						variant="outline"
						size="sm"
						class="h-7 shrink-0"
						disabled={regenerating}
						onclick={handleRegenerate}
					>
						<RefreshCw class="h-3 w-3 {regenerating ? 'animate-spin' : ''}" />
						Regenerate
					</Button>
				</div>
			</div>

			<DropdownMenu.Separator />

			<DropdownMenu.Item class="flex cursor-pointer items-center gap-2" onclick={handleLogout}>
				<LogOut class="h-4 w-4" />
				<span>Log out</span>
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<Dialog.Root bind:open={revealOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>New API key</Dialog.Title>
				<Dialog.Description>
					Copy it now — for security it is only shown once and cannot be retrieved again.
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex items-center gap-2">
				<code class="flex-1 truncate rounded bg-muted px-2 py-2 font-mono text-sm">{newKey}</code>
				<Button variant="outline" size="icon" class="shrink-0" onclick={() => copyToClipboard(newKey)}>
					<Copy class="h-4 w-4" />
					<span class="sr-only">Copy API key</span>
				</Button>
			</div>

			<Dialog.Footer>
				<Button onclick={() => (revealOpen = false)}>Done</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
