import { flushSync } from 'svelte';

/**
 * reactive-observer - runs an effect outside a component and records what it read
 *
 * Runes only compile in `.svelte.ts` modules, so the effect cannot live in the
 * `.svelte.test.ts` file that uses it. `$effect.root` gives an owner for an
 * effect with no component to attach to; `flushSync` runs it eagerly so a test
 * can assert without awaiting a microtask.
 *
 * `values` holds one entry per run of the effect: index 0 is the initial read,
 * and every later entry is a re-run caused by a dependency changing. An empty
 * tail is the failure this exists to catch — the value forwards, but Svelte's
 * dependency graph never reached the owning `$state`.
 */
export function observeReads<T>(read: () => T): { values: T[]; stop: () => void } {
	const values: T[] = [];

	const stop = $effect.root(() => {
		$effect(() => {
			values.push(read());
		});
	});

	flushSync();

	return { values, stop };
}
