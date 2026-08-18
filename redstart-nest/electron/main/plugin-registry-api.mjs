'use strict'

// =============================================================================
// Redstart Nest — Official MCP Registry client
// =============================================================================
// SKELETON. Every function throws until implemented — see
// docs/notes/mcp-plugin-system-tasks.md task T18.
//
// Read-only client for the community registry at registry.modelcontextprotocol.io,
// used to populate the Add-tool browse step and to pre-fill the settings form.
//
// WHY THIS IS NOT OPTIONAL POLISH. Nothing in the MCP handshake tells us which
// environment variables a server needs — a plugin missing its API key installs
// cleanly, handshakes cleanly, lists its tools, and then fails every call at
// runtime. The registry's environmentVariables[] metadata is the only machine
// -readable source for that, which is why browsing ships WITH the installer
// (Phase 4b) rather than after it.
// =============================================================================

/**
 * A CONSTANT, never a setting. An admin-editable registry URL is a
 * supply-chain redirect with a friendly text field.
 */
export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io'

/** Verdict states. Every search result gets exactly one — nothing is hidden. */
export const VERDICT = {
  installable: 'installable',     // ready to install
  needsSetup: 'needs-setup',      // installable, but a human must supply values
  needsRuntime: 'needs-runtime',  // we could support this, but not yet / not here
  unsupported: 'unsupported',     // we will not run this
}

/**
 * TODO(T18): search the registry.
 *
 * GET /v0.1/servers?version=latest&search=<query>&cursor=<cursor>
 * No auth. Cursor-paginated via metadata.nextCursor.
 *
 * NO CACHING in v1. On any network failure return { error } and let the UI say
 * "registry unavailable — install by package name instead". Browsing is
 * optional; install-by-name must keep working with this panel never opened.
 *
 * @returns {Promise<{entries: object[], nextCursor: string|null} | {error: string}>}
 */
export async function searchRegistry({ query, cursor, signal } = {}) {
  const url = new URL('/v0.1/servers', REGISTRY_BASE)
  url.searchParams.set('version', 'latest')
  if (query) url.searchParams.set('search', query)
  if (cursor) url.searchParams.set('cursor', cursor)

  let res
  try {
    res = await fetch(url, { signal })
  } catch (err) {
    // Network down, DNS failure, aborted — all the same to the caller: the
    // panel degrades to "unavailable, install by package name instead"
    // (plan Registry API notes, constraint 5). Never a hard dependency.
    return { error: err.message }
  }
  if (!res.ok) return { error: `registry returned HTTP ${res.status}` }

  let data
  try {
    data = await res.json()
  } catch (err) {
    return { error: `registry response was not valid JSON: ${err.message}` }
  }

  // A missing `servers` array is "not installable from here", not an error
  // (plan constraint 4 — tolerate schema drift, never throw on a shape we
  // don't recognise).
  const entries = Array.isArray(data?.servers) ? data.servers : []
  const nextCursor = typeof data?.metadata?.nextCursor === 'string' ? data.metadata.nextCursor : null
  return { entries, nextCursor }
}

/**
 * TODO(T18): can we install this, and if not, why not?
 *
 * DO NOT FILTER RESULTS SILENTLY. An admin who searches for a Docker-based
 * server and finds nothing concludes Redstart is broken; one who reads "Not
 * supported: needs Docker" understands the product. Silent filtering
 * manufactures its own support burden.
 *
 * Order of checks, first match wins:
 *   no stdio package        -> unsupported, reason 'remote'
 *   registryType 'oci'      -> unsupported, reason 'docker'
 *   registryType 'mcpb'     -> unsupported, reason 'bundle'
 *   registryType 'pypi'     -> needsRuntime, reason 'python'   (Phase 7)
 *   registryType not 'npm'  -> unsupported, reason 'unknown-runtime'
 *   no version pin          -> unsupported, reason 'unpinned'  (D5)
 *   status not 'active'     -> unsupported, reason 'inactive'
 *   any isRequired env/arg  -> needsSetup
 *   otherwise               -> installable
 *
 * Distribution in an 800-entry sample: 81% of entries are remote-only; of 150
 * stdio packages, npm 121 / pypi 21 / oci 6 / mcpb 2. So `unsupported` is the
 * common answer, and it must read as an explanation rather than a shrug.
 *
 * PARSE DEFENSIVELY. Publisher-written data with a moving schema: entries in a
 * single response have carried different $schema dates. Tolerate unknown
 * fields, treat a missing `packages` array as unsupported rather than an error,
 * and never throw — one malformed row must not empty the list.
 *
 * @param {object} serverEntry one element of searchRegistry().entries
 * @returns {{state: string, reason?: string, packageRef?: object}}
 */
// v1 support priority when a server offers more than one runtime (rare — 2 of
// several hundred entries sampled, see plan "Runtime support"): prefer npm,
// since that's what we can actually install; pypi is next (Phase 7), then the
// two deferred kinds, in the order the plan itself gives up on them.
const STDIO_PRIORITY = ['npm', 'pypi', 'oci', 'mcpb']

function hasRequiredField(list) {
  return Array.isArray(list) && list.some((f) => f && f.isRequired === true)
}

export function verdictFor(serverEntry) {
  try {
    const server = serverEntry?.server
    const packages = Array.isArray(server?.packages) ? server.packages : []
    // `remotes[]` (streamable-http/SSE servers) is a different feature this
    // system does not install (Trap 10) — packages is the only source of a
    // stdio candidate, so an entry with none is 'remote' regardless of what
    // else it declares.
    const stdioPackages = packages.filter((p) => p?.transport?.type === 'stdio')
    if (stdioPackages.length === 0) {
      return { state: VERDICT.unsupported, reason: 'remote' }
    }

    let chosen = null
    for (const type of STDIO_PRIORITY) {
      chosen = stdioPackages.find((p) => p.registryType === type)
      if (chosen) break
    }
    // An unrecognised registryType is still surfaced, never dropped — the
    // whole point of a verdict is that nothing goes silently missing.
    if (!chosen) chosen = stdioPackages[0]

    if (chosen.registryType === 'oci') return { state: VERDICT.unsupported, reason: 'docker', packageRef: chosen }
    if (chosen.registryType === 'mcpb') return { state: VERDICT.unsupported, reason: 'bundle', packageRef: chosen }
    if (chosen.registryType === 'pypi') return { state: VERDICT.needsRuntime, reason: 'python', packageRef: chosen }
    if (chosen.registryType !== 'npm') return { state: VERDICT.unsupported, reason: 'unknown-runtime', packageRef: chosen }

    // registryType npm from here on.
    const version = chosen.version
    if (!version || String(version).toLowerCase() === 'latest') {
      return { state: VERDICT.unsupported, reason: 'unpinned', packageRef: chosen }
    }

    // Missing status metadata is tolerated, not treated as inactive — an
    // entry this system cannot classify is not the same as one it has
    // positively identified as deprecated (plan constraint 4).
    const status = serverEntry?._meta?.['io.modelcontextprotocol.registry/official']?.status
    if (status && status !== 'active') {
      return { state: VERDICT.unsupported, reason: 'inactive', packageRef: chosen }
    }

    const needsSetup = hasRequiredField(chosen.environmentVariables) || hasRequiredField(chosen.packageArguments)
    return { state: needsSetup ? VERDICT.needsSetup : VERDICT.installable, packageRef: chosen }
  } catch {
    // One malformed row must not empty the list (plan constraint 4) — surface
    // it as unsupported rather than letting the whole search blow up.
    return { state: VERDICT.unsupported, reason: 'unknown-runtime' }
  }
}

/**
 * TODO(T18): reduce a package's environmentVariables[] + packageArguments[] to
 * the fields the Add-tool form renders.
 *
 * Pass through: name, description, format, isRequired, isSecret, default,
 * placeholder.
 *
 * ##########################################################################
 * # FAIL-SAFE MASKING. isSecret is publisher-set and appears on only about  #
 * # a third of declarations in the wild. Mark a field secret when isSecret  #
 * # is true OR its name matches /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.    #
 * #                                                                        #
 * # Over-masking costs an admin one annoyance. Under-masking puts a live    #
 * # credential in a plaintext box AND outside the encrypted storage path    #
 * # (D-f), because the form is what decides which values get encrypted.     #
 * ##########################################################################
 *
 * @returns {{fields: object[]}}
 */
const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export function formFieldsFor(packageRef) {
  try {
    const envVars = Array.isArray(packageRef?.environmentVariables) ? packageRef.environmentVariables : []
    const pkgArgs = Array.isArray(packageRef?.packageArguments) ? packageRef.packageArguments : []
    // A packageArgument with no `name` is a fixed positional value (e.g. the
    // literal "-y" npx always needs) baked into the install command, not
    // something an admin fills in — it has nothing to render a field for.
    const fields = [...envVars, ...pkgArgs]
      .filter((raw) => raw && typeof raw.name === 'string' && raw.name)
      .map((raw) => ({
        name: raw.name,
        description: typeof raw.description === 'string' ? raw.description : '',
        format: typeof raw.format === 'string' ? raw.format : 'string',
        isRequired: raw.isRequired === true,
        // FAIL-SAFE MASKING (see the comment above): isSecret is publisher-set
        // and present on only ~1/3 of declarations in the wild. Mask on the
        // flag OR the name pattern — never rely on the flag alone.
        isSecret: raw.isSecret === true || SECRET_NAME_PATTERN.test(raw.name),
        default: raw.default,
        placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
      }))
    return { fields }
  } catch {
    return { fields: [] }
  }
}
