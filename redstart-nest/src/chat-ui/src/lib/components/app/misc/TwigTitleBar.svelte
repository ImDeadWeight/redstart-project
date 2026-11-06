<script lang="ts">
	/**
	 * Redstart Twig's title bar, drawn by the page.
	 *
	 * The Tauri window has no OS frame on Windows, so this strip is the whole
	 * title bar: drag it to move the window, double-click to maximise, and the
	 * minimise / maximise / close buttons on the right. On macOS the native
	 * traffic lights sit over the left end and `drawsControls` is false, so this
	 * is only the drag area. Electron Twig had Windows draw the buttons as an
	 * overlay whose height and colour had to agree with this file; the page now
	 * draws everything, so there is nothing left to keep in step.
	 *
	 * Close goes through the shell's graceful quit (stop local MCP servers,
	 * install a downloaded update), not a hard window destroy.
	 */
	import { onMount } from 'svelte';
	import { Minus, Square, Copy, X } from '@lucide/svelte';
	import type { TwigWindowApi } from '$lib/utils/twig';

	let { win }: { win: TwigWindowApi | null } = $props();

	let maximized = $state(false);

	async function refreshMaximized() {
		if (!win) return;
		try {
			maximized = await win.isMaximized();
		} catch {
			/* the window is going away */
		}
	}

	onMount(() => {
		void refreshMaximized();
		window.addEventListener('resize', refreshMaximized);
		return () => window.removeEventListener('resize', refreshMaximized);
	});

	function onMouseDown(e: MouseEvent) {
		if (!win || e.button !== 0) return;
		// Only the bar itself drags, never a button on it.
		if ((e.target as HTMLElement).closest('button')) return;
		if (e.detail === 2) void win.toggleMaximize();
		else void win.startDragging();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="twig-titlebar" class:twig-titlebar-mac={win && !win.drawsControls} onmousedown={onMouseDown}>
	{#if win?.drawsControls}
		<div class="twig-window-controls">
			<button type="button" aria-label="Minimise" title="Minimise" onclick={() => win.minimize()}>
				<Minus class="h-4 w-4" />
			</button>
			<button
				type="button"
				aria-label={maximized ? 'Restore' : 'Maximise'}
				title={maximized ? 'Restore' : 'Maximise'}
				onclick={() => win.toggleMaximize()}
			>
				{#if maximized}
					<Copy class="h-3.5 w-3.5 -scale-x-100" />
				{:else}
					<Square class="h-3.5 w-3.5" />
				{/if}
			</button>
			<button type="button" class="twig-close" aria-label="Close" title="Close" onclick={() => win.close()}>
				<X class="h-4 w-4" />
			</button>
		</div>
	{/if}
</div>
