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
export async function searchRegistry({ query, cursor, signal }) {
  throw new Error('TODO(T18): searchRegistry not implemented')
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
export function verdictFor(serverEntry) {
  throw new Error('TODO(T18): verdictFor not implemented')
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
export function formFieldsFor(packageRef) {
  throw new Error('TODO(T18): formFieldsFor not implemented')
}
