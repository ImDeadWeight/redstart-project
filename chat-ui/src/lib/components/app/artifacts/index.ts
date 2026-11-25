/**
 * **ArtifactViewer** - One artifact in a sandboxed frame on the content origin
 * (artifacts plan §10), beside a chat or on its own page.
 */
export { default as ArtifactViewer } from './ArtifactViewer.svelte';

/** **ArtifactCard** - An artifact a tool made or changed, in the transcript. */
export { default as ArtifactCard } from './ArtifactCard.svelte';

/** **ArtifactsGallery** - The artifacts this account can see; a project's, with `projectId`. */
export { default as ArtifactsGallery } from './ArtifactsGallery.svelte';

/** **ArtifactShareDialog** - Project access and members, most specific wins (§5). */
export { default as ArtifactShareDialog } from './ArtifactShareDialog.svelte';
