<script lang="ts" module>
	import { badgeVariants, type BadgeVariant } from './badge-variants.js';
	export { badgeVariants, type BadgeVariant };
</script>

<script lang="ts">
	import type { HTMLAnchorAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '$lib/components/ui/utils';

	let {
		ref = $bindable(null),
		href,
		class: className,
		variant = 'default',
		children,
		...restProps
	}: WithElementRef<HTMLAnchorAttributes> & {
		variant?: BadgeVariant;
	} = $props();
</script>

<svelte:element
	this={href ? 'a' : 'span'}
	bind:this={ref}
	data-slot="badge"
	{href}
	class={cn(badgeVariants({ variant }), className, 'backdrop-blur-sm')}
	{...restProps}
>
	{@render children?.()}
</svelte:element>
