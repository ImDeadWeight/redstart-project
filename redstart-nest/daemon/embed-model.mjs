'use strict'

import * as fs from 'fs'
import * as path from 'path'

import { downloadArtifact, destinationFor } from './model-download.mjs'
import { logEvent } from './logger.mjs'

// =============================================================================
// Redstart Nest — the embedding model
// =============================================================================
// One fixed, Nest-chosen artifact, pinned by sha256. It does NOT go through the
// model picker: the user is not choosing this model, Nest is, and a retrieval
// index built from a model the user swapped underneath it would be silently
// meaningless rather than visibly broken.
//
// It reuses model-download.mjs's hash-verified, .part-suffixed fetch rather than
// growing a second downloader. That module's whole design is "a remote artifact
// must never be mistakable for a complete one", and that applies at 67 MB as
// much as at 18 GB — an interrupted download here would produce a GGUF
// llama-server refuses to load, on a path whose failure mode is meant to be
// "retrieval is off today", not a crash loop.
//
// Fetched on FIRST NEED, not at install: a user who never enables retrieval
// never downloads it.
// =============================================================================

/**
 * bge-small-en-v1.5, f16, 384 dimensions, 67 MB.
 *
 * Chosen empirically against this tree's own 21 built-in tool descriptions —
 * short, jargon-heavy, several actions per description — with 18 hand-labelled
 * asks phrased the way a user would phrase them rather than the way the tool
 * describes itself:
 *
 *                        recall@1   recall@3   MRR
 *   bge-small-en-v1.5      83.3%      94.4%   0.896
 *   all-MiniLM-L6-v2       72.2%      88.9%   0.817
 *
 * Both are 384-dimensional and both embed all 21 tools in about 200 ms of CPU,
 * so the ranking quality was the only axis that separated them. f16 rather than
 * a quantization: the whole file is 67 MB, and quantization noise on the one
 * component whose entire output is a similarity number is a poor trade for
 * 30 MB.
 *
 * bge's documented query-side instruction prefix ("Represent this sentence for
 * searching relevant passages: ") was measured too and made no difference here
 * (MRR 0.898 vs 0.896), so it is not used — a magic string that has to be
 * documented and kept in sync should have to earn its place.
 */
export const EMBED_MODEL = Object.freeze({
  label: 'bge-small-en-v1.5',
  dimensions: 384,
  /**
   * The model's hard positional limit, and llama-server's `-c` for it.
   *
   * NOT advisory. An input over this returns HTTP 500 ("input (N tokens) is too
   * large to process") and takes the whole batch with it, so every text handed
   * to the embedder is truncated to fit. Found the way these things are found:
   * D2 says the query is the whole conversation, this model can see 512 tokens
   * of it, and the Phase 2.4 evaluation used one-sentence queries so the two
   * never met until a real conversation did.
   */
  maxTokens: 512,
  repoId: 'CompendiumLabs/bge-small-en-v1.5-gguf',
  // A commit sha, not 'main': the pinned hash below describes the file at this
  // revision, and a branch that moves would turn a verified download into a
  // failed one with no explanation.
  revision: 'd32f8c040ea3b516330eeb75b72bcc2d3a780ab7',
  rfilename: 'bge-small-en-v1.5-f16.gguf',
  sha256: 'f0b2fef971e8366438bfd2d9aefea1b0115919389448806d290237f638bae999',
  size: 67308128,
})

/**
 * Where the embedding model lives once fetched.
 *
 * destinationFor() realpaths the models directory, which does not exist on a
 * first run, so the plain join is the answer before anything has been
 * downloaded. The containment check destinationFor() performs is about an
 * UNTRUSTED remote filename; this one is a constant three lines up, so the
 * fallback gives nothing away.
 */
export function embedModelPath(modelsDir, pin = EMBED_MODEL) {
  try {
    return destinationFor(modelsDir, pin.rfilename)
  } catch {
    return path.join(modelsDir, pin.rfilename)
  }
}

/**
 * Is it already on disk and complete? A .part does not count, and neither does
 * a file of the wrong size — a truncated artifact must never be mistakable for
 * a model, which is the same rule model-download.mjs is built around.
 *
 * `pin` exists so the suite can drive the production path against bytes a stub
 * server can serve. Production never passes it.
 */
export function hasEmbedModel(modelsDir, pin = EMBED_MODEL) {
  try {
    return fs.statSync(embedModelPath(modelsDir, pin)).size === pin.size
  } catch {
    return false
  }
}

/**
 * Fetch the embedding model if it is not already there.
 *
 * Returns the path, or null if it could not be obtained. Never throws: a failed
 * download means retrieval stays off, which is a state the whole feature is
 * built to tolerate, and it must not be able to fail whatever asked for it.
 *
 * @param {{ modelsDir: string, signal?: AbortSignal, onProgress?: (p: any) => void, pin?: typeof EMBED_MODEL }} args
 * @returns {Promise<string|null>}
 */
export async function ensureEmbedModel({ modelsDir, signal, onProgress, pin = EMBED_MODEL }) {
  const destination = embedModelPath(modelsDir, pin)
  if (hasEmbedModel(modelsDir, pin)) return destination

  // A file of the wrong size is a truncated or superseded artifact, not a
  // model. Clear it rather than downloading beside it, or every future start
  // re-checks a file that will never be right.
  try {
    if (fs.existsSync(destination)) fs.rmSync(destination)
  } catch {
    /* if it cannot be removed the download below will fail loudly enough */
  }

  logEvent('retrieval', 'embed_model_download_started', { model: pin.label, bytes: pin.size })
  try {
    const result = await downloadArtifact({
      repoId: pin.repoId,
      revision: pin.revision,
      modelsDir,
      signal,
      onProgress,
      artifact: {
        quantLabel: 'f16',
        totalBytes: pin.size,
        files: [{ rfilename: pin.rfilename, size: pin.size, sha256: pin.sha256 }],
      },
    })
    logEvent('retrieval', 'embed_model_ready', { model: pin.label })
    return result.modelPath
  } catch (err) {
    // downloadArtifact leaves a .part behind on a network failure so a retry
    // can resume, and deletes nothing on a hash mismatch — in both cases there
    // is no complete file here to mistake for one.
    logEvent('retrieval', 'embed_model_download_failed', { reason: err?.message ?? 'unknown' })
    return null
  }
}
