<script lang="ts">
	import { Workflow } from '@lucide/svelte';
	import WorkflowsPanel from './WorkflowsPanel.svelte';
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-6 md:pt-28">
	<div class="flex items-center gap-3">
		<Workflow class="h-6 w-6 shrink-0" />

		<div class="min-w-0 flex-1">
			<h1 class="truncate text-lg font-semibold">Workflows</h1>
			<p class="text-sm text-muted-foreground">Saved instructions you run with / in a chat</p>
		</div>
	</div>

	<WorkflowsPanel />
</div>
