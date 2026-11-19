<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { ChatFormModeToggle } from '$lib/components/app';
</script>

<!--
	The picker lives inside the chat form, which sits under Tooltip.Provider.
	It hides itself when the server advertises no modes, so the mocked
	/prompt-modes response is what makes it render at all.
-->
<Tooltip.Provider>
	<ChatFormModeToggle />
</Tooltip.Provider>
