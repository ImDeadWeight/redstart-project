<script lang="ts">
	import { ChevronDown, ShieldQuestion } from '@lucide/svelte';
	import { ChatMessageActionCard } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import * as ButtonGroup from '$lib/components/ui/button-group';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { ToolSource, ToolPermissionDecision } from '$lib/enums';
	import { TOOL_SERVER_LABELS } from '$lib/constants';
	import { toolsStore } from '$lib/stores/tools.svelte';
	import {
		isScopedTool,
		grantScopeFor,
		scopeLabel,
		commandLine,
		type GrantScope
	} from '$lib/agent-core';

	interface Props {
		toolName: string;
		serverLabel: string;
		/** The call's arguments: run_command's card shows the exact command line. */
		args?: Record<string, unknown> | null;
		/** What "Always allow" would grant, when the caller already knows it (a task's approval). */
		scope?: GrantScope | null;
		onDecision: (decision: ToolPermissionDecision) => void;
	}

	let { toolName, serverLabel, args = null, scope = null, onDecision }: Props = $props();

	// A destructive tool (currently only file deletion) prompts on every call and
	// is never offered an "always" option. The agentic store enforces this too —
	// this is the half that stops the user being invited to make a choice the
	// system will then refuse to honour.
	const destructive = $derived(toolsStore.isDestructiveTool(toolName));

	// run_command (agent-runtime Phase 4, D19): the card shows the exact argv,
	// and "Always allow" covers that program and first argument only, worded as
	// such. With no first argument there is nothing to always allow, so only
	// "Allow once" is offered. Nest makes the grant, from this very call.
	const scoped = $derived(isScopedTool(toolName));
	const line = $derived(scoped && args ? commandLine(args) : null);
	const cwd = $derived(scoped && typeof args?.cwd === 'string' && args.cwd ? args.cwd : null);
	const commandScope = $derived(scope ?? (scoped ? grantScopeFor(toolName, args) : null));
</script>

<ChatMessageActionCard icon={ShieldQuestion}>
	{#snippet message()}
		{#if scoped}
			Run this command on the Redstart server?

			{#if line}
				<code class="mt-1 block rounded bg-muted px-2 py-1 font-mono text-xs break-all">{line}</code
				>
			{/if}
			<span class="mt-1 block text-xs text-muted-foreground">
				In {cwd ? `the workspace folder ${cwd}` : "this conversation's workspace"}. It runs as this
				machine's user and can reach the network and files outside the workspace.
			</span>
		{:else}
			Allow use of

			<span class="font-semibold">{toolName}</span>

			{#if serverLabel}
				from <span class="font-semibold">{serverLabel}</span>
			{/if}

			?
		{/if}

		{#if destructive}
			<span class="mt-1 block text-xs text-muted-foreground">
				This deletes data. It asks every time — there is no "always allow" for deletion. Deleted
				items go to the recycle bin, so they can be recovered.
			</span>
		{/if}
	{/snippet}

	{#snippet actions()}
		{#if destructive || (scoped && !commandScope)}
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
					{#if scoped && commandScope}
						<DropdownMenu.Item onclick={() => onDecision(ToolPermissionDecision.ALWAYS)}>
							Always allow <code class="font-mono">{scopeLabel(commandScope)}</code>
						</DropdownMenu.Item>
					{:else}
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
