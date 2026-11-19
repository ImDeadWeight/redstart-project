<script lang="ts">
	import { Check, Compass } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { conversationsStore } from '$lib/stores/conversations.svelte';
	import { promptModesStore } from '$lib/stores/prompt-modes.svelte';
	import type { PromptMode } from '$lib/types';

	// Modes are server-owned; an empty list means this deployment offers none
	// (or predates the route), in which case the control hides entirely rather
	// than showing an empty menu.
	void promptModesStore.ensureLoaded();

	let modes = $derived(promptModesStore.modes);
	let currentMode = $derived(conversationsStore.getPromptMode());
	let activeLabel = $derived(modes.find((m) => m.id === currentMode)?.label ?? null);
	let tooltipText = $derived(activeLabel ? `${activeLabel} mode` : 'No task mode');
	let open = $state(false);

	function select(mode: PromptMode | null) {
		// Selecting the active mode clears it, so the control is its own "off"
		// switch and the menu needs no separate None row to mis-click.
		const next = mode && mode.id !== currentMode ? mode.id : null;
		void conversationsStore.setPromptMode(next);
		open = false;
	}
</script>

{#if modes.length > 0}
	<DropdownMenu.Root bind:open>
		<Tooltip.Root>
			<Tooltip.Trigger>
				<DropdownMenu.Trigger
					class={[
						'flex h-6 w-6 cursor-pointer items-center justify-center rounded-full p-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
						currentMode ? 'bg-sky-400/10 hover:bg-sky-400/20' : 'bg-muted'
					]}
					aria-label={`${tooltipText}. Click to change.`}
				>
					<Compass
						class={[
							'h-3 w-3',
							currentMode ? 'text-sky-400' : 'text-muted-foreground'
						]}
					/>
				</DropdownMenu.Trigger>
			</Tooltip.Trigger>

			<Tooltip.Content>
				<p>{tooltipText}</p>
			</Tooltip.Content>
		</Tooltip.Root>

		<DropdownMenu.Content
			align="start"
			class="w-60 rounded-xl bg-popover p-3 text-popover-foreground shadow-md outline-none"
		>
			<div class="mb-2 px-2.5 text-sm font-medium">Task mode</div>

			{#each modes as mode (mode.id)}
				<button
					type="button"
					class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent"
					class:bg-accent={currentMode === mode.id}
					onclick={() => select(mode)}
				>
					{#if currentMode === mode.id}
						<Check class="h-4 w-4 shrink-0 text-foreground" />
					{:else}
						<div class="h-4 w-4 shrink-0"></div>
					{/if}

					<span class="flex-1">{mode.label}</span>

					<span class="text-[11px] text-muted-foreground opacity-60">{mode.summary}</span>
				</button>
			{/each}

			<p class="mt-2 px-2.5 text-[11px] text-muted-foreground">
				Applies to this conversation. Select again to clear.
			</p>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
