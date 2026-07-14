<script lang="ts">
	interface Props {
		phase: 'scanning' | 'connecting';
	}
	let { phase }: Props = $props();

	const subtitle = $derived(
		phase === 'scanning' ? 'Scanning local network...' : 'Redstart is loading...'
	);
</script>

<div class="fixed inset-0 z-9999 flex items-center justify-center bg-zinc-950">
	<div class="flex flex-col items-center gap-8">
		<!-- Logo -->
		<div class="logo-enter">
			<img src="/redstart.svg" alt="Redstart" width="96" height="96" class="redstart-logo" />
		</div>

		<!-- Title + subtitle -->
		<div class="text-enter flex flex-col items-center gap-2">
			<h1 class="text-3xl font-bold tracking-tight text-white">Redstart</h1>
			<p class="text-sm text-zinc-400">{subtitle}</p>
		</div>

		<!-- Spinner -->
		<div class="spinner-enter">
			<div
				class="h-8 w-8 animate-spin rounded-full border-[3px] border-zinc-700 border-t-orange-500"
			></div>
		</div>
	</div>
</div>

<style>
	.redstart-logo {
		image-rendering: pixelated;
	}
	.logo-enter {
		animation: logoEnter 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}
	.text-enter {
		animation: fadeInUp 0.4s ease-out 0.18s both;
	}
	.spinner-enter {
		animation: fadeIn 0.3s ease-out 0.35s both;
	}

	@keyframes logoEnter {
		from {
			transform: scale(0.65);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}
	@keyframes fadeInUp {
		from {
			transform: translateY(10px);
			opacity: 0;
		}
		to {
			transform: translateY(0);
			opacity: 1;
		}
	}
	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
