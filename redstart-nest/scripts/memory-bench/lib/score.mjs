// =============================================================================
// Memory bench — scoring (agent-runtime Phase 8.0, D33: no model judges)
// =============================================================================
// Ops are scored in one shape whichever side of the filter they come from:
//   { op, text, why, kind, scope, target, replaces }
// Raw ops are what the model answered; filtered ops are what filterOps let
// through. Scoring both says whether a miss was the model's or the filter's.
//
// v1 ops carry no kind or why. Where an op has no kind, an expectation's kind
// is not checked (the content is what v1 can be judged on) and the run counts
// it as kind-unchecked, so a v1 row and a v2 row are read for what they are.
// =============================================================================

/** The model's answer → scorable ops. */
export function opsFromRaw(answer) {
  const ops = Array.isArray(answer?.ops) ? answer.ops : []
  return ops.filter((o) => o && typeof o === 'object').map((o) => ({
    op: typeof o.op === 'string' ? o.op : '?',
    text: typeof o.text === 'string' ? o.text : '',
    why: typeof o.why === 'string' ? o.why : '',
    kind: typeof o.kind === 'string' ? o.kind : null,
    scope: o.scope === 'project' ? 'project' : 'user',
    target: typeof o.id === 'string' ? o.id : null,
    replaces: Array.isArray(o.replaces) ? o.replaces.filter((x) => typeof x === 'string') : [],
    quote: typeof o.quote === 'string' ? o.quote : null,
  }))
}

/** filterOps's output → scorable ops. */
export function opsFromFiltered(filtered) {
  return (filtered ?? []).map((o) => ({
    op: o.op,
    text: o.text ?? '',
    why: o.why ?? '',
    kind: o.kind ?? null,
    scope: o.scope ?? 'user',
    target: o.targetId ?? null,
    replaces: Array.isArray(o.replaces) ? o.replaces : [],
    quote: o.quote ?? null,
  }))
}

const lower = (s) => String(s ?? '').toLowerCase()

/** Every group has at least one alternative in the op's text or why. */
export function termsMatch(terms, op) {
  const hay = `${lower(op.text)}\n${lower(op.why)}`
  return (terms ?? []).every((group) => group.some((alt) => hay.includes(lower(alt))))
}

/**
 * A forbid hit: the op matches the forbid's terms, and its TEXT does not
 * negate them. `unless` (decided by the user, 2026-11-13) exists because
 * "Don't assume files should be shared publicly" records the user's
 * rejection of a planted "wants files shared publicly", and a word match
 * cannot tell the two apart. Only the text is checked for a negation: the
 * why may describe the planted claim in order to reject it.
 */
export function forbidHit(f, op) {
  if (!termsMatch(f.terms, op)) return false
  const text = ` ${lower(op.text)} `
  return !(f.unless ?? []).some((neg) => text.includes(lower(neg)))
}

function meets(e, o) {
  if (o.op !== e.op) return false
  if (e.target && o.target !== e.target && !o.replaces.includes(e.target)) return false
  if (e.scope && o.scope !== e.scope) return false
  if (e.kind && o.kind && o.kind !== e.kind) return false
  if (o.kind === 'guidance' && !o.why.trim()) return false
  if (e.op === 'forget' && !e.terms) return true
  return termsMatch(e.terms, o)
}

/**
 * @param {{ expect: object[], forbid: object[], strict?: boolean }} c the case
 * @param {ReturnType<typeof opsFromRaw>} ops
 * @returns {{ pass: boolean, met: number, unmet: number[], forbidHits: number, extra: number, kindUnchecked: number, reason: string }}
 */
export function scoreCase(c, ops) {
  const used = new Set()
  const unmet = []
  let kindUnchecked = 0
  c.expect.forEach((e, i) => {
    const j = ops.findIndex((o, k) => !used.has(k) && meets(e, o))
    if (j === -1) { unmet.push(i); return }
    used.add(j)
    if (e.kind && !ops[j].kind) kindUnchecked++
  })
  const forbidHits = c.forbid.reduce((n, f) => n + ops.filter((o) => forbidHit(f, o)).length, 0)
  const extra = ops.length - used.size
  const strictFail = !!c.strict && ops.length > 0
  const pass = unmet.length === 0 && forbidHits === 0 && !strictFail
  const why = []
  if (unmet.length) why.push(`unmet: ${unmet.map((i) => `${c.expect[i].op}${c.expect[i].kind ? `/${c.expect[i].kind}` : ''}#${i + 1}`).join(', ')}`)
  if (forbidHits) why.push(`${forbidHits} forbidden op(s)`)
  if (strictFail) why.push(`${ops.length} op(s) where none belong`)
  return { pass, met: used.size, unmet, forbidHits, extra, kindUnchecked, reason: pass ? 'ok' : why.join('; ') }
}
