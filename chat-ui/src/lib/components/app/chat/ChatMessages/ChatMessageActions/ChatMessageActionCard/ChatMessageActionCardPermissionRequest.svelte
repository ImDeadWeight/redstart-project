<script lang="ts">
	import { ChevronDown, ShieldQuestion } from '@lucide/svelte';
	import { ChatMessageActionCard } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import * as ButtonGroup from '$lib/components/ui/button-group';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ToolSource, ToolPermissionDecision } from '$lib/enums';
	import { TOOL_SERVER_LABELS } from '$lib/constants';
	import { toolsStore } from '$lib/stores/tools.svelte';

	interface Props {
		toolName: string;
		serverLabel: string;
		onDecision: (decision: ToolPermissionDecision) => void;
	}

	let { toolName, serverLabel, onDecision }: Props = $props();

	// A destructive tool (currently only file deletion) prompts on every call and
	// is never offered an "always" option. The agentic store enforces this too —
	// this is the half that stops the user being invited to make a choice the
	// system will then refuse to honour.
	const destructive = $derived(toolsStore.isDestructiveTool(toolName));
</script>

<ChatMessageActionCard icon={ShieldQuestion}>
	{#snippet message()}
		Allow use of

		<span class="font-semibold">{toolName}</span>

		{#if serverLabel}
			from <span class="font-semibold">{serverLabel}</span>
		{/if}

		?

		{#if destructive}
			<span class="mt-1 block text-xs text-muted-foreground">
				This deletes data. It asks every time — there is no "always allow" for deletion. Deleted
				items go to the recycle bin, so they can be recovered.
			</span>
		{/if}
	{/snippet}

	{#snippet actions()}
		{#if destructive}
			<Button size="sm" onclick={() => onDecision(ToolPermissionDecision.ONCE)}>Allow once</Button>
		{:else}
			<DropdownMenu.Root>
				<ButtonGroup.Root
					class="overflow-hidden rounded-md bg-foreground text-white shadow-sm dark:bg-secondary dark:text-foreground"
				>
					<Button
						class="rounded-none! shadow-none!"
						size="sm"
						onclick={() => onDecision(ToolPermissionDecision.ONCE)}
					>
						Allow once
					</Button>

					<ButtonGroup.Separator />

					<DropdownMenu.Trigger>
						<Button size="sm" class="rounded-none! ps-2! shadow-none!">
							<ChevronDown class="h-3.5 w-3.5" />
						</Button>
					</DropdownMenu.Trigger>
				</ButtonGroup.Root>

				<DropdownMenu.Content align="start" class="min-w-32">
					<DropdownMenu.Item onclick={() => onDecision(ToolPermissionDecision.ALWAYS)}>
						Always allow <pre>{toolName}</pre>
						tool
					</DropdownMenu.Item>
					{#if serverLabel}
						<DropdownMenu.Item onclick={() => onDecision(ToolPermissionDecision.ALWAYS_SERVER)}>
							Always allow all tools from {serverLabel}
						</DropdownMenu.Item>
					{:else}
						{@const source = toolsStore.getToolSource(toolName)}
						{@const providerName =
							source === ToolSource.BUILTIN
								? TOOL_SERVER_LABELS[ToolSource.BUILTIN]
								: source === ToolSource.CUSTOM
									? TOOL_SERVER_LABELS[ToolSource.CUSTOM]
									: 'MCP Tools'}
						<DropdownMenu.Item onclick={() => onDecision(ToolPermissionDecision.ALWAYS_SERVER)}>
							Approve all tools from {providerName}
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}

		<Button
			variant="destructive"
			size="sm"
			class="text-destructive hover:text-destructive"
			onclick={() => onDecision(ToolPermissionDecision.DENY)}
		>
			Deny
		</Button>
	{/snippet}
</ChatMessageActionCard>
