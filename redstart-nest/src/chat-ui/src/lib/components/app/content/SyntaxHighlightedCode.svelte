<script lang="ts">
	import hljs from 'highlight.js';
	import { browser } from '$app/environment';

	// Dark-only app, so only the dark highlight theme is imported — the light
	// one used to be selected whenever the OS reported a light preference,
	// which painted a light code block onto the dark UI.
	import githubDarkCss from 'highlight.js/styles/github-dark.css?inline';

	interface Props {
		code: string;
		language?: string;
		class?: string;
		maxHeight?: string;
		maxWidth?: string;
	}

	let {
		code,
		language = 'text',
		class: className = '',
		maxHeight = '60vh',
		maxWidth = ''
	}: Props = $props();

	let highlightedHtml = $state('');

	function loadHighlightTheme() {
		if (!browser) return;

		const existingThemes = document.querySelectorAll('style[data-highlight-theme-preview]');
		existingThemes.forEach((style) => style.remove());

		const style = document.createElement('style');
		style.setAttribute('data-highlight-theme-preview', 'true');
		style.textContent = githubDarkCss;

		document.head.appendChild(style);
	}

	$effect(() => {
		loadHighlightTheme();
	});

	$effect(() => {
		if (!code) {
			highlightedHtml = '';
			return;
		}

		try {
			// Check if the language is supported
			const lang = language.toLowerCase();
			const isSupported = hljs.getLanguage(lang);

			if (isSupported) {
				const result = hljs.highlight(code, { language: lang });
				highlightedHtml = result.value;
			} else {
				// Try auto-detection or fallback to plain text
				const result = hljs.highlightAuto(code);
				highlightedHtml = result.value;
			}
		} catch {
			// Fallback to escaped plain text
			highlightedHtml = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}
	});
</script>

<div
	class="code-preview-wrapper rounded-lg border border-border bg-muted {className}"
	style="max-height: {maxHeight}; max-width: {maxWidth};"
>
	<!-- Needs to be formatted as single line for proper rendering -->
	<pre class="m-0"><code class="hljs text-sm leading-relaxed">{@html highlightedHtml}</code></pre>
</div>

<style>
	.code-preview-wrapper pre {
		background: transparent;
	}

	.code-preview-wrapper code {
		background: transparent;
	}
</style>
