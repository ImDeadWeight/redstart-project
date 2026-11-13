#!/usr/bin/env node
// =============================================================================
// Tool retrieval eval — run the labelled cases against the real embedder
// =============================================================================
// Tool retrieval second pass, 0.4. Scores every case in cases.json, plus the
// agent-bench tasks, against catalog.json through the production scorer
// (lib.mjs), with vectors from a real bge-small embedding server. Reports per
// variant, overall and per source:
//
//   MRR, recall@K, precision@K   the full ranking (searchTools, no limit)
//   sel. recall, sel. size       selection cases: what filterRequestTools
//                                would send, at a 32k window
//   ms                           ranking time per case, vectors cached
//
// Variants: `cosine` (today's scorer) only, until Phase 3 adds BM25 and
// fusion; each will be a setting the production functions take per call.
//
// The embedding server: Nest's own sidecar on 19084 while retrieval is on, or
// one started by hand on another port (the eval then never touches Nest):
//   llama-server -m bge-small-en-v1.5-f16.gguf --embeddings --host 127.0.0.1 \
//     --port 19184 -ngl 0 -c 512
//
//   node scripts/retrieval-eval/run.mjs [--port 19084] [--source <name>]
//     [--json <file>] [--freeze]
//
// --freeze rewrites frozen.json: the cases this scorer gets right (a search
// case's right tool in the top 3; a selection case's selection holding what it
// needs) with every vector they use, so test-retrieval-eval.mjs fails in CI
// when a change drops one. Refreeze after rebuilding catalog.json, after a
// change to the text tools are embedded by (Phase 2), or when a phase moves
// more cases into passing, and say so in the commit.
// =============================================================================

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBED_PORT } from '../../daemon/ports.mjs'
import { embedTexts } from '../../daemon/embed-server.mjs'
import {
  KS, FROZEN_FILE, aggregate, caseMetrics, loadCases, loadCatalog, recordingEmbedder, scoreCase, toWireTools,
  frozenCaseOk, catalogHash,
} from './lib.mjs'

export const VARIANTS = ['cosine']

export function parseArgs(argv) {
  const opts = { port: EMBED_PORT, freeze: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--freeze') { opts.freeze = true; continue }
    const v = argv[++i]
    if (v === undefined) throw new Error(`${a} needs a value`)
    if (a === '--port') opts.port = Number(v)
    else if (a === '--source') opts.source = v
    else if (a === '--json') opts.json = v
    else throw new Error(`unknown argument ${a}`)
  }
  if (!Number.isInteger(opts.port) || opts.port < 1) throw new Error('--port must be a port number')
  if (opts.freeze && opts.source) throw new Error('--freeze runs every case; drop --source')
  return opts
}

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
const n3 = (x) => (x == null ? '—' : x.toFixed(3))
const n1 = (x) => (x == null ? '—' : x.toFixed(1))

export function table(label, agg) {
  const head = `| ${label} | cases | MRR | ${KS.map((k) => `R@${k}`).join(' | ')} | P@3 | sel. recall | sel. size | ms |`
  const sep = `|${'---|'.repeat(6 + KS.length + 2)}`
  const row = (name, a) => `| ${name} | ${a.cases} | ${n3(a.mrr)} | ${KS.map((k) => pct(a.recall[k])).join(' | ')} | ${pct(a.precision[3])} | ${pct(a.selectedRecall)} | ${n1(a.selectedSize)} | ${n1(a.ms)} |`
  return [head, sep, row('all', agg.all), ...Object.entries(agg.bySource).map(([s, a]) => row(s, a))].join('\n')
}

/**
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void, embed?: (texts: string[]) => Promise<Float32Array[] | null> }} [io]
 */
export async function main(argv, io = {}) {
  const log = io.log ?? ((s) => console.log(s))
  const opts = parseArgs(argv)
  const catalog = loadCatalog()
  const names = new Set(catalog.map((t) => t.name))
  const wire = toWireTools(catalog)
  let cases = loadCases(names)
  if (opts.source) cases = cases.filter((c) => c.source === opts.source)
  if (cases.length === 0) throw new Error(`no cases${opts.source ? ` from source ${opts.source}` : ''}`)

  const base = io.embed ?? ((texts) => embedTexts(texts, { port: opts.port, timeoutMs: 30_000 }))
  const recorder = recordingEmbedder(async (texts) => {
    const out = await base(texts)
    if (!out) throw new Error(`no embedding server answered on port ${opts.port} (see the header of this file)`)
    return out
  })

  log(`${cases.length} cases over ${catalog.length} tools, embedding on port ${opts.port}`)
  const results = {}
  for (const variant of VARIANTS) {
    const rows = []
    for (const c of cases) {
      const scored = await scoreCase(c, { wire, embed: recorder.embed })
      rows.push({ case: c, scored, metrics: caseMetrics(c.expected, scored, c.need), ms: scored.ms })
    }
    // The first case pays for embedding the whole catalog; leave it out of ms.
    rows[0].ms = rows.length > 1 ? rows[1].ms : rows[0].ms
    const agg = aggregate(rows)
    results[variant] = { agg, rows }
    log(`\n## ${variant}\n\n${table(variant, agg)}`)
    const misses = rows.filter((r) => !frozenCaseOk(r.case, r.scored))
    log(`\n${misses.length} case(s) the scorer gets wrong (search: right tool not in the top 3; selection: a needed tool not sent):`)
    for (const r of misses) {
      const best = Math.min(...r.metrics.ranks)
      const sel = r.scored.selected ? `, sent ${r.scored.selected.length}: ${r.scored.selected.join(' ')}` : ''
      log(`- ${r.case.id} (${r.case.source}): wants ${r.case.expected.join('|')}, best rank ${best}; top 3 ${r.scored.ranking.slice(0, 3).join(' ')}${sel}`)
    }
  }

  if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify(Object.fromEntries(Object.entries(results).map(([v, r]) => [v, r.agg])), null, 2)}\n`)

  if (opts.freeze) {
    const rows = results.cosine.rows
    const kept = rows.filter((r) => frozenCaseOk(r.case, r.scored)).map((r) => r.case.id)
    fs.writeFileSync(FROZEN_FILE, `${JSON.stringify({
      note: 'Generated by run.mjs --freeze. Cases the cosine scorer got right at freeze time, and every vector they use (bge-small-en-v1.5 f16, base64 float32, keyed by sha256 of the text). Do not edit by hand.',
      frozenAt: new Date().toISOString().slice(0, 10),
      catalogHash: catalogHash(catalog),
      cases: kept,
      vectors: recorder.seen,
    })}\n`)
    log(`\nfroze ${kept.length} of ${rows.length} cases and ${Object.keys(recorder.seen).length} vectors -> ${path.relative(process.cwd(), FROZEN_FILE)}`)
  }
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`retrieval-eval: ${err.message}`)
    process.exit(1)
  })
}
