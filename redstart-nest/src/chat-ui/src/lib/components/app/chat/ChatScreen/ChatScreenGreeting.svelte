<script lang="ts">
	import { fadeInView } from '$lib/actions/fade-in-view.svelte';
	import { serverStore } from '$lib/stores/server.svelte';

	interface Props {
		isEmpty: boolean;
	}

	let { isEmpty = false }: Props = $props();
</script>

<div
	class={[
		'pointer-events-none mb-4 hidden px-4 text-center',
		isEmpty && 'pointer-events-auto block!'
	]}
	use:fadeInView={{ duration: 300 }}
>
	<img
		src="/redstart.svg"
		alt="Redstart"
		class="mx-auto mb-5"
		style="width: 80px; height: 80px; image-rendering: pixelated;"
	/>
	<h1 class="mb-2 text-2xl font-semibold tracking-tight md:text-3xl">Hello there</h1>

	<p class="text-muted-foreground md:text-lg">
		{serverStore.props?.modalities?.audio ? 'Record audio, type a message ' : 'Type a message'} or upload
		files to get started
	</p>
</div>
