'use strict'

// =============================================================================
// Redstart Nest — MCP Provider: Scholar (open academic research)
// =============================================================================
// Search and retrieval across the OPEN scholarly world, using free keyless
// first-party APIs:
//   - OpenAlex   — all-fields scholarly graph (also carries Crossref metadata
//                  and Unpaywall open-access locations, so one API covers
//                  search, DOI lookup, citations, and legal OA PDF links)
//   - arXiv      — preprints (physics/CS/math/stats), direct PDFs
//   - PubMed     — biomedical literature (E-utilities)
//
// Optional VENUE WHITELIST (cfg.scholar.venueFilter): a comma-separated list
// of journal ISSNs (e.g. "1932-6203, 0028-4793") and/or arXiv categories
// (e.g. "cs.CL, stat.ML"). When set, it is compiled into the upstream query
// itself (OpenAlex filter=, PubMed [is] terms, arXiv cat: clauses) — results
// outside the whitelist never come back, and scholar_save_pdf re-checks the
// work's venue before downloading. Same philosophy as web sources: enforced
// server-side, not a prompt advisory.
//
// scholar_save_pdf resolves the open-access PDF URL SERVER-SIDE from the
// paper's identifier — the model supplies a DOI/arXiv id, never a URL — and
// saves into the configured Documents folder, where read_document can then
// read it. Only genuine PDFs are saved (magic-byte check).
// =============================================================================

import * as fs from 'fs'
import * as path from 'path'
import { resolveWithinRoot } from './path-scope.mjs'

const TOOL_NAMES = ['scholar_search', 'scholar_get', 'scholar_save_pdf']
const USER_AGENT = 'Redstart/1.0 (local AI assistant)'
const FETCH_TIMEOUT_MS = 15000
const PDF_TIMEOUT_MS = 45000
const SEARCH_LIMIT = 8
const MAX_PDF_BYTES = 30 * 1024 * 1024
const MAX_OUTPUT_CHARS = 8000

const ISSN_RE = /^\d{4}-\d{3}[\dXx]$/
const ARXIV_CAT_RE = /^[a-z-]+(\.[A-Za-z-]+)?$/
const ARXIV_ID_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/

// ---------------------------------------------------------------------------
// Venue whitelist
// ---------------------------------------------------------------------------

function parseVenueFilter(venueFilter) {
  const issns = []
  const cats = []
  for (const raw of String(venueFilter || '').split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    if (ISSN_RE.test(entry)) issns.push(entry.toUpperCase())
    else if (ARXIV_CAT_RE.test(entry)) cats.push(entry)
  }
  return { issns, cats, active: issns.length > 0 || cats.length > 0 }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function getJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json()
}

async function getText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.text()
}

function clip(text) {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Output truncated]' : text
}

// OpenAlex stores abstracts as an inverted index (word -> positions).
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return null
  const words = []
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word
  }
  const text = words.join(' ').trim()
  return text || null
}

// ---------------------------------------------------------------------------
// Identifier parsing — model supplies DOI / arXiv id / PMID, never a URL
// ---------------------------------------------------------------------------

function parseId(id) {
  const s = String(id || '').trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/^doi:/i, '')
    .replace(/^arxiv:/i, '')
    .replace(/^pmid:?\s*/i, '')
    .replace(/\.pdf$/i, '')
  if (/^10\.\d{4,9}\/\S+$/.test(s)) return { kind: 'doi', value: s.toLowerCase() }
  if (ARXIV_ID_RE.test(s)) return { kind: 'arxiv', value: s }
  if (/^\d{1,9}$/.test(s)) return { kind: 'pmid', value: s }
  return null
}

// ---------------------------------------------------------------------------
// Per-source search — venue whitelist compiled into the upstream query
// ---------------------------------------------------------------------------

async function searchOpenAlex(query, filter) {
  let url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${SEARCH_LIMIT}&sort=relevance_score:desc`
  if (filter.active) {
    if (!filter.issns.length) throw new Error('The venue whitelist has no journal ISSNs, so OpenAlex search is unavailable. Add ISSNs or use source "arxiv".')
    url += `&filter=primary_location.source.issn:${filter.issns.join('|')}`
  }
  const data = await getJson(url)
  return (data.results || []).map(w => {
    const venue = w.primary_location?.source?.display_name || 'unknown venue'
    const oa = w.best_oa_location?.pdf_url || w.open_access?.oa_url ? ' [open access]' : ''
    const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//, '')
    return `${w.title} (${w.publication_year ?? '?'}, ${venue}, cited ${w.cited_by_count ?? 0}×)${oa}\n  id: ${doi ? `doi:${doi}` : w.id}`
  })
}

async function searchArxiv(query, filter) {
  let q = `all:${encodeURIComponent(`"${query}"`)}`
  if (filter.active) {
    if (!filter.cats.length) throw new Error('The venue whitelist has no arXiv categories, so arXiv search is unavailable. Add categories (e.g. cs.CL) or use source "openalex".')
    q = `(${filter.cats.map(c => `cat:${c}`).join('+OR+')})+AND+${q}`
  }
  const xml = await getText(`https://export.arxiv.org/api/query?search_query=${q}&max_results=${SEARCH_LIMIT}&sortBy=relevance`)
  const out = []
  for (const entry of xml.split('<entry>').slice(1)) {
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim()
    const idUrl = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim() || ''
    const year = (entry.match(/<published>(\d{4})/) || [])[1] || '?'
    const arxivId = idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
    if (title && arxivId) out.push(`${title} (${year}, arXiv) [open access]\n  id: arxiv:${arxivId}`)
  }
  return out
}

async function searchPubmed(query, filter) {
  let term = query
  if (filter.active) {
    if (!filter.issns.length) throw new Error('The venue whitelist has no journal ISSNs, so PubMed search is unavailable. Add ISSNs or use source "arxiv".')
    term = `(${query}) AND (${filter.issns.map(i => `"${i}"[is]`).join(' OR ')})`
  }
  const search = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json&retmax=${SEARCH_LIMIT}`)
  const ids = search?.esearchresult?.idlist || []
  if (!ids.length) return []
  const summary = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`)
  return ids.map(pmid => {
    const r = summary?.result?.[pmid] || {}
    return `${r.title || '(untitled)'} (${(r.pubdate || '?').slice(0, 4)}, ${r.fulljournalname || r.source || 'unknown journal'})\n  id: pmid:${pmid}`
  })
}

const SEARCH_SOURCES = { openalex: searchOpenAlex, arxiv: searchArxiv, pubmed: searchPubmed }

// ---------------------------------------------------------------------------
// scholar_get — metadata + abstract by identifier (venue-checked when filtered)
// ---------------------------------------------------------------------------

async function getWork(parsed, filter) {
  if (parsed.kind === 'arxiv') {
    const xml = await getText(`https://export.arxiv.org/api/query?id_list=${parsed.value}`)
    const entry = xml.split('<entry>')[1] || ''
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim()
    if (!title) throw new Error(`arXiv paper not found: ${parsed.value}`)
    const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, ' ').trim()
    const cat = (entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1] || ''
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim()).slice(0, 8).join(', ')
    if (filter.active && filter.cats.length && !filter.cats.includes(cat)) {
      throw new Error(`Paper category "${cat}" is not on the venue whitelist (${filter.cats.join(', ')})`)
    }
    return `# ${title}\nAuthors: ${authors}\nCategory: ${cat} | id: arxiv:${parsed.value} | PDF: available (use scholar_save_pdf)\n\nAbstract:\n${summary || '(none)'}`
  }

  if (parsed.kind === 'pmid') {
    const summary = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${parsed.value}&retmode=json`)
    const r = summary?.result?.[parsed.value]
    if (!r || r.error) throw new Error(`PubMed record not found: ${parsed.value}`)
    if (filter.active && filter.issns.length) {
      const issns = [r.issn, r.essn].filter(Boolean).map(s => s.toUpperCase())
      if (!issns.some(i => filter.issns.includes(i))) {
        throw new Error(`Journal (${r.fulljournalname || r.source}) is not on the venue whitelist`)
      }
    }
    const abstract = await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${parsed.value}&rettype=abstract&retmode=text`)
    const doi = (r.articleids || []).find(a => a.idtype === 'doi')?.value
    return `# ${r.title || '(untitled)'}\nJournal: ${r.fulljournalname || r.source} (${(r.pubdate || '').slice(0, 4)})${doi ? ` | doi:${doi}` : ''} | pmid:${parsed.value}\n\n${abstract.trim()}`
  }

  // DOI → OpenAlex (carries Crossref metadata + Unpaywall OA locations)
  const w = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(parsed.value)}`)
  const issns = (w.primary_location?.source?.issn || []).map(s => s.toUpperCase())
  if (filter.active && filter.issns.length && !issns.some(i => filter.issns.includes(i))) {
    throw new Error(`Journal (${w.primary_location?.source?.display_name || 'unknown'}) is not on the venue whitelist`)
  }
  const authors = (w.authorships || []).slice(0, 8).map(a => a.author?.display_name).filter(Boolean).join(', ')
  const abstract = reconstructAbstract(w.abstract_inverted_index)
  const oaPdf = w.best_oa_location?.pdf_url || w.primary_location?.pdf_url
  return `# ${w.title}\nAuthors: ${authors}\nVenue: ${w.primary_location?.source?.display_name || 'unknown'} (${w.publication_year ?? '?'}) | cited ${w.cited_by_count ?? 0}× | doi:${parsed.value}\nOpen-access PDF: ${oaPdf ? 'available (use scholar_save_pdf)' : w.open_access?.oa_url ? 'landing page only' : 'not found'}\n\nAbstract:\n${abstract || '(not available)'}`
}

// ---------------------------------------------------------------------------
// scholar_save_pdf — server-side OA resolution, saved into the Documents folder
// ---------------------------------------------------------------------------

function slugify(text) {
  const base = String(text || 'paper').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return base || 'paper'
}

async function resolvePdf(parsed, filter) {
  if (parsed.kind === 'arxiv') {
    if (filter.active && filter.cats.length) {
      // Category check requires metadata — reuse getWork's validation.
      await getWork(parsed, filter)
    }
    return { url: `https://arxiv.org/pdf/${parsed.value}`, name: `arxiv-${parsed.value.replace(/[^0-9v.]/g, '')}` }
  }

  let doi = parsed.value
  if (parsed.kind === 'pmid') {
    const summary = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${parsed.value}&retmode=json`)
    doi = (summary?.result?.[parsed.value]?.articleids || []).find(a => a.idtype === 'doi')?.value
    if (!doi) throw new Error('No DOI found for this PMID — cannot resolve an open-access PDF.')
  }

  const w = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`)
  const issns = (w.primary_location?.source?.issn || []).map(s => s.toUpperCase())
  if (filter.active && filter.issns.length && !issns.some(i => filter.issns.includes(i))) {
    throw new Error(`Journal (${w.primary_location?.source?.display_name || 'unknown'}) is not on the venue whitelist`)
  }
  const url = w.best_oa_location?.pdf_url || w.primary_location?.pdf_url
  if (!url) {
    throw new Error(`No open-access PDF is available for doi:${doi}${w.open_access?.oa_url ? ` (a landing page exists: ${w.open_access.oa_url})` : ''}`)
  }
  return { url, name: slugify(w.title) }
}

async function savePdf(saveDir, parsed, filter) {
  const { url, name } = await resolvePdf(parsed, filter)

  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(PDF_TIMEOUT_MS), redirect: 'follow' })
  if (!resp.ok) throw new Error(`PDF download failed: HTTP ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  if (buffer.length > MAX_PDF_BYTES) throw new Error(`PDF is larger than the ${MAX_PDF_BYTES / 1048576} MB limit`)
  if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('The open-access location did not return a PDF (publisher may require browser access).')
  }

  fs.mkdirSync(saveDir, { recursive: true })
  let filename = `${name}.pdf`
  let n = 2
  while (fs.existsSync(path.join(saveDir, filename))) filename = `${name}-${n++}.pdf`
  const outputPath = resolveWithinRoot(saveDir, filename)
  fs.writeFileSync(outputPath, buffer)
  return { outputPath, filename, bytes: buffer.length }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export function toolDefs(cfg) {
  if (!cfg?.scholar?.enabled) return []
  const filtered = parseVenueFilter(cfg.scholar.venueFilter).active
  const filterNote = filtered ? ' Results are restricted to the venues on the configured whitelist.' : ''
  const defs = [
    {
      name: 'scholar_search',
      description: `Search open academic literature. Sources: "openalex" (all fields — journals, citations), "arxiv" (preprints: CS, physics, math, stats), "pubmed" (biomedical). Returns titles with identifiers for scholar_get / scholar_save_pdf.${filterNote}`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          source: { type: 'string', enum: Object.keys(SEARCH_SOURCES), description: 'Which index to search (default "openalex")' },
        },
        required: ['query'],
      },
    },
    {
      name: 'scholar_get',
      description: `Get the abstract and metadata (authors, venue, year, citations, open-access availability) of a paper by identifier: "doi:10.xxxx/...", "arxiv:2401.12345", or "pmid:12345678".${filterNote}`,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Paper identifier (doi:/arxiv:/pmid:)' } },
        required: ['id'],
      },
    },
  ]
  if (cfg.scholar.saveDir) {
    defs.push({
      name: 'scholar_save_pdf',
      description: `Download the legal open-access PDF of a paper (by doi:/arxiv:/pmid: identifier) into the local documents folder, where read_document can then read it. Only works for papers with an open-access PDF.${filterNote}`,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Paper identifier (doi:/arxiv:/pmid:)' } },
        required: ['id'],
      },
    })
  }
  return defs
}

export async function callTool(name, args, cfg) {
  if (!TOOL_NAMES.includes(name)) return null

  const scholarCfg = cfg?.scholar
  if (!scholarCfg?.enabled) {
    return { isError: true, content: [{ type: 'text', text: 'Scholar is not configured or enabled.' }] }
  }
  const filter = parseVenueFilter(scholarCfg.venueFilter)

  try {
    if (name === 'scholar_search') {
      const { query, source } = args || {}
      if (!query || typeof query !== 'string' || !query.trim()) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required argument: query' }] }
      }
      const key = source && SEARCH_SOURCES[source] ? source : 'openalex'
      const results = await SEARCH_SOURCES[key](query.trim(), filter)
      if (!results.length) return { content: [{ type: 'text', text: `No results on ${key} for "${query}".` }] }
      return { content: [{ type: 'text', text: clip(results.join('\n\n') + '\n\nUse scholar_get with an id above for the abstract, or scholar_save_pdf to download an open-access PDF.') }] }
    }

    const parsed = parseId(args?.id)
    if (!parsed) {
      return { isError: true, content: [{ type: 'text', text: 'Unrecognized identifier. Use "doi:10.xxxx/...", "arxiv:2401.12345", or "pmid:12345678".' }] }
    }

    if (name === 'scholar_get') {
      return { content: [{ type: 'text', text: clip(await getWork(parsed, filter)) }] }
    }

    // scholar_save_pdf
    if (!scholarCfg.saveDir) {
      return { isError: true, content: [{ type: 'text', text: 'No documents folder is configured to save PDFs into.' }] }
    }
    const saved = await savePdf(scholarCfg.saveDir, parsed, filter)
    return { content: [{ type: 'text', text: `Saved: ${saved.filename} (${(saved.bytes / 1024).toFixed(0)} KB) in the documents folder. Use read_document with path "${saved.filename}" to read it.` }] }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Scholar error: ${err.message}` }] }
  }
}
