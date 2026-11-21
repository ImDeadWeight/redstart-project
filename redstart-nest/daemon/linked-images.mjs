'use strict'

// =============================================================================
// Redstart Nest — images a tool linked, shown to a vision model (server runs)
// =============================================================================
// A tool that produced or opened an image (view_image, run_python's charts,
// generate_image) returns it as a resource_link, which the result text carries
// as one line:  [file: chats/c1/fig-1.png, image/png, 41 KB]
//
// In the browser, chat-ui fetches those images and sends them with the result
// to a model that can see (agentic-tool-exec.ts, linkedImagesAsDataUrls). A
// chat running ON THE SERVER (task-runner.mjs) had no such step, so view_image
// there would have shown the model nothing. This is that step, with the same
// limits: at most MAX_IMAGES per result, none over MAX_BYTES, only for a
// model whose /props reports vision, read for this request only and never
// stored.
//
// The path is resolved exactly as /files/download resolves it — inside the
// caller's own documents folder — so a link can only ever show the caller
// their own file. A path that escapes, is missing, or is not really an image
// is skipped: the model still has the line, the picture is a bonus.
// =============================================================================

import * as fs from 'fs'
import { resolveWithinRoot } from './path-scope.mjs'
import { resolveUserRoot } from './user-scope.mjs'
import { inspectImageFile } from './image-info.mjs'

/** Same numbers as chat-ui's MAX_LINKED_IMAGES_FOR_VISION / MAX_LINKED_IMAGE_BYTES. */
export const MAX_IMAGES = 4
export const MAX_BYTES = 4 * 1024 * 1024

// shared/agent-core/tool-result.mjs resourceLinkText() writes this; chat-ui's
// RESOURCE_LINE_REGEX reads it.
const RESOURCE_LINE = /^\[file: ([^,\]]+), ([^,\]]+), ([^\]]+)\]$/
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/

/** The documents-relative paths of the image links in a result, in order. */
export function linkedImagePaths(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = RESOURCE_LINE.exec(line.trim())
    if (m && IMAGE_MIME.test(m[2].trim())) out.push(m[1].trim())
  }
  return out
}

/**
 * image_url parts for the linked images in `text`, read from the caller's
 * documents folder.
 *
 * @param {string} text  a tool result, after attachment extraction
 * @param {{ documentsRoot: string|undefined, account: object|null }} where
 * @returns {{ type: 'image_url', image_url: { url: string } }[]}
 */
export function linkedImageParts(text, { documentsRoot, account }) {
  const paths = linkedImagePaths(text)
  if (paths.length === 0 || !documentsRoot) return []
  let root
  try {
    root = resolveUserRoot(documentsRoot, account ?? null)
  } catch {
    return []
  }
  const parts = []
  for (const rel of paths) {
    if (parts.length >= MAX_IMAGES) break
    try {
      const file = resolveWithinRoot(root, rel)
      const info = inspectImageFile(file)
      if (!info.ok || info.bytes > MAX_BYTES) continue
      parts.push({ type: 'image_url', image_url: { url: `data:${info.mimeType};base64,${fs.readFileSync(file).toString('base64')}` } })
    } catch {
      /* outside the folder, or gone: skipped */
    }
  }
  return parts
}

/**
 * Whether the model behind `port` reads images: llama-server's /props says so
 * only when it was started with a projector. Any failure is "no".
 */
export async function modelHasVision(port, fetchImpl = fetch) {
  if (!port) return false
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return false
    const props = await res.json()
    return props?.modalities?.vision === true
  } catch {
    return false
  }
}
