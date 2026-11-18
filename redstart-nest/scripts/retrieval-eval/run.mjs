#!/usr/bin/env node
// =============================================================================
// Tool retrieval eval — run the labelled cases against the real embedder
// =============================================================================
// Tool retrieval second pass, 0.4. Scores every search case in cases.json
// against catalog.json through the production ranking search_tools runs
// (lib.mjs), with vectors from a real bge-small embedding server. Reports,
// overall and per source:
//
//   MRR, recall@K, precision@K   the full ranking (searchTools, no limit)
//   ms                           ranking time per case, vectors cached
//
// One ranking: the production one (fused, master plan 3.3 fixed it). The
// scorer, text-version, floor and min-tools flags went with per-turn
// selection, and so did the selection columns.
//
// The embedding server: Nest's own sidecar on 19084 while retrieval is on, or
// one started by hand on another port (the eval then never touches Nest):
//   llama-server -m bge-small-en-v1.5-f16.gguf --embeddings --host 127.0.0.1 \
//     --port 19184 -ngl 0 -c 512
//
//   node scripts/retrieval-eval/run.mjs [--port 19084] [--source <name>]
//     [--json <file>] [--freeze]
//
// --freeze rewrites frozen.json: the cases the ranking gets right (a right
// tool in the top 3) with every vector they use, so test-retrieval-eval.mjs
// fails in CI when a change drops one. Refreeze after rebuilding
// catalog.json, after a change to the text tools are embedded by, or when a
// change moves more cases into passing, and say so in the commit.
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
  const head = `| ${label} | cases | MRR | ${KS.map((k) => `R@${k}`).join(' | ')} | P@3 | ms |`
  const sep = `|${'---|'.repeat(5 + KS.length)}`
  const row = (name, a) => `| ${name} | ${a.cases} | ${n3(a.mrr)} | ${KS.map((k) => pct(a.recall[k])).join(' | ')} | ${pct(a.precision[3])} | ${n1(a.ms)} |`
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
  const rows = []
  for (const c of cases) {
    const scored = await scoreCase(c, { wire, embed: recorder.embed })
    rows.push({ case: c, scored, metrics: caseMetrics(c.expected, scored, c.need), ms: scored.ms })
  }
  // The first case pays for embedding the whole catalog; leave it out of ms.
  rows[0].ms = rows.length > 1 ? rows[1].ms : rows[0].ms
  const agg = aggregate(rows)
  log(`\n${table('search_tools', agg)}`)
  const misses = rows.filter((r) => !frozenCaseOk(r.case, r.scored))
  log(`\n${misses.length} case(s) the ranking gets wrong (right tool not in the top 3):`)
  for (const r of misses) {
    const best = Math.min(...r.metrics.ranks)
    log(`- ${r.case.id} (${r.case.source}): wants ${r.case.expected.join('|')}, best rank ${best}; top 3 ${r.scored.ranking.slice(0, 3).join(' ')}`)
  }

  if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify(agg, null, 2)}\n`)

  if (opts.freeze) {
    const kept = rows.filter((r) => frozenCaseOk(r.case, r.scored)).map((r) => r.case.id)
    fs.writeFileSync(FROZEN_FILE, `${JSON.stringify({
      note: 'Generated by run.mjs --freeze. Cases the production ranking got right at freeze time, and every vector they use (bge-small-en-v1.5 f16, base64 float32, keyed by sha256 of the text). Do not edit by hand.',
      frozenAt: new Date().toISOString().slice(0, 10),
      catalogHash: catalogHash(catalog),
      cases: kept,
      vectors: recorder.seen,
    })}\n`)
    log(`\nfroze ${kept.length} of ${rows.length} cases and ${Object.keys(recorder.seen).length} vectors -> ${path.relative(process.cwd(), FROZEN_FILE)}`)
  }
  return { agg, rows }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`retrieval-eval: ${err.message}`)
    process.exit(1)
  })
}
