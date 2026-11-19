<script lang="ts">
	// TLS plan Q3: "This connection isn't encrypted", shown wherever a password
	// or a conversation is about to cross the network in the clear, the login
	// page included. Dismissible for this session only; it comes back on the
	// next visit, because the connection is still not encrypted.
	import { onMount } from 'svelte';
	import { getServerBaseUrl } from '$lib/utils/server-url';
	import { isConnectionEncrypted, NOT_ENCRYPTED_DISMISS_KEY } from '$lib/utils/connection-security';

	let show = $state(false);

	onMount(() => {
		let dismissed = false;
		try {
			dismissed = sessionStorage.getItem(NOT_ENCRYPTED_DISMISS_KEY) === '1';
		} catch {
			/* storage blocked: show it */
		}
		show = !dismissed && !isConnectionEncrypted({ secureContext: window.isSecureContext, serverBaseUrl: getServerBaseUrl() });
	});

	function dismiss() {
		show = false;
		try {
			sessionStorage.setItem(NOT_ENCRYPTED_DISMISS_KEY, '1');
		} catch {
			/* nothing to remember it in; it stays dismissed until reload */
		}
	}
</script>

{#if show}
	<div
		role="status"
		class="fixed inset-x-0 top-0 z-[9998] flex items-center justify-center gap-3 bg-amber-500/95 px-4 py-1.5 text-xs font-medium text-amber-950 shadow"
	>
		<span>This connection isn't encrypted. Others on this network could see what you send, including your password.</span>
		<button
			type="button"
			onclick={dismiss}
			class="rounded px-2 py-0.5 text-amber-950 underline-offset-2 hover:underline"
			aria-label="Dismiss for this session"
		>
			Dismiss
		</button>
	</div>
{/if}
