/**
 * Rehype plugin to enhance links with security attributes.
 *
 * Adds target="_blank" and rel="noopener noreferrer" to all anchor elements,
 * ensuring external links open in new tabs safely.
 */

import type { Plugin } from 'unified';
import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';

/**
 * Rehype plugin that adds security attributes to all links.
 * This plugin ensures external links open in new tabs safely by adding:
 * - target="_blank"
 * - rel="noopener noreferrer"
 */
export const rehypeEnhanceLinks: Plugin<[], Root> = () => {
	return (tree: Root) => {
		visit(tree, 'element', (node: Element) => {
			if (node.tagName !== 'a') return;

			const props = node.properties ?? {};

			// Only modify if href exists
			if (!props.href) return;

			props.target = '_blank';
			// hast types rel as a token list; hast-util-to-html joins it with
			// spaces, so the output is still rel="noopener noreferrer".
			props.rel = ['noopener', 'noreferrer'];
			node.properties = props;
		});
	};
};
