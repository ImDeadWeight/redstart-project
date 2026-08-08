<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { SettingsChatSystemPromptTab } from '$lib/components/app/settings';
</script>

<!-- Mirrors the providers +layout.svelte supplies, nothing more. -->
<Tooltip.Provider>
	<SettingsChatSystemPromptTab />
</Tooltip.Provider>
