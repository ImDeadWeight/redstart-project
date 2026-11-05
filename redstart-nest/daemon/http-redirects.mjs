// =============================================================================
// Manual redirect walk — one policy, shared by every outbound fetch.
// =============================================================================
// Follows redirects MANUALLY so every hop is re-validated against the caller's
// policy. With redirect:'follow', an approved URL could bounce the fetch to any
// domain (consent pages, shorteners — or a public URL redirecting to a LAN
// address) without the destination ever being checked. Each Location is
// validated BEFORE it is requested, so a disallowed hop never generates
// network traffic.
//
// Extracted from web-fetch-tool.mjs's fetchPage() when the Hugging Face model
// downloader needed the same guarantee. The downloader cannot reuse fetchPage
// itself — that function consumes the body as text with a token limit, which is
// wrong for a streamed multi-gigabyte binary — but it must not get a second,
// weaker redirect policy either. So the walk lives here and both callers get
// the identical hop check; only body handling differs.
//
// Guarded by scripts/test-model-download.mjs (hop validation, cap) alongside
// the web_fetch suites that covered the original.
// =============================================================================

export const MAX_REDIRECTS = 5

// Returns the first non-redirect Response. The body is untouched — the caller
// owns it, and is responsible for consuming or cancelling it.
//
//   isUrlAllowed  (url) => boolean | Promise<boolean>, applied to every hop.
//                 Awaited, because web_fetch's whitelist-off predicate does a
//                 DNS lookup — the hop is judged by what it RESOLVES to, not
//                 just what it is named. A sync predicate works unchanged.
//   headers       sent on each hop
//   signal        abort signal, shared across hops
//   maxRedirects  hop cap; exceeding it throws rather than returning a 3xx
//   checkInitial  also validate the starting URL. Defaults true so a new caller
//                 is safe by omission. web_fetch passes false: it already
//                 validated, and owns a specific denial message that a generic
//                 throw here would replace — plus its predicate does DNS, so a
//                 re-check would be a second lookup for no gain.
//
// Throws on a disallowed hop or too many redirects. Does NOT throw on a non-OK
// status — status handling belongs to the caller, which knows whether a 401 or
// a 416 is fatal or expected.
export async function fetchFollowingRedirects(url, {
  isUrlAllowed,
  headers = {},
  signal,
  maxRedirects = MAX_REDIRECTS,
  checkInitial = true,
} = {}) {
  if (typeof isUrlAllowed !== 'function') {
    throw new Error('fetchFollowingRedirects requires an isUrlAllowed policy')
  }
  if (checkInitial && !(await isUrlAllowed(url))) {
    throw new Error(`Refusing to request "${url}", which is not an approved address`)
  }

  let current = url
  let resp
  for (let hop = 0; ; hop++) {
    resp = await fetch(current, { headers, signal, redirect: 'manual' })
    if (resp.status < 300 || resp.status >= 400) break
    const location = resp.headers.get('location')
    if (!location) break
    if (hop >= maxRedirects) throw new Error('Too many redirects')
    const next = new URL(location, current).href
    if (!(await isUrlAllowed(next))) {
      throw new Error(`The page redirects to "${next}", which is not an approved address`)
    }
    // Discard the redirect body so the socket can be reused rather than left
    // hanging — matters on a download that walks several CDN hops.
    resp.body?.cancel().catch(() => {})
    current = next
  }
  return { response: resp, finalUrl: current }
}
