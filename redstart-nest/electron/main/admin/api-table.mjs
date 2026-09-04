'use strict'

// =============================================================================
// Redstart Nest — assembling the control plane's handler table
// =============================================================================
// The one place that knows about every ipc/*.mjs namespace. Kept apart from
// api-routes.mjs so the dispatcher and the listener stay free of the `electron`
// import those modules still carry (dialog, shell) — the split is what lets the
// HTTP layer be loaded and tested on a platform that has no Electron at all,
// which is the platform HTTP-only exists for.
//
// The namespaces are listed in the same order as registerIpcHandlers() in
// index.mjs, and the two lists are checked against each other by
// scripts/test-admin-api.mjs: a namespace added to one and not the other is a
// set of methods reachable over one transport and silently absent from the
// other, which is exactly the drift this pass exists to remove.
//
// `browse` (admin/browse-routes.mjs — browse:roots/list/mkdir) was never
// registered over IPC, even before IPC was retired entirely: it existed
// specifically as the server-side stand-in for the native picker Electron
// used to have, so the only caller it was ever for was one without IPC
// access. Kept free of the `electron` import so it (and its test) run under
// plain Node. The parity check above only runs registered-over-IPC -> tabled,
// not the reverse, so a table-only namespace is not drift; it is the reason
// the check has a direction.
// =============================================================================

import { githubHandlers } from '../ipc/github.mjs'
import { hardwareHandlers } from '../ipc/hardware.mjs'
import { settingsHandlers } from '../ipc/settings.mjs'
import { authHandlers } from '../ipc/auth.mjs'
import { adminHandlers } from '../ipc/admin.mjs'
import { profilesHandlers } from '../ipc/profiles.mjs'
import { toolsHandlers } from '../ipc/tools.mjs'
import { mcpHandlers } from '../ipc/mcp.mjs'
import { capabilitiesHandlers } from '../ipc/capabilities.mjs'
import { serverHandlers } from '../ipc/server.mjs'
import { modelsHandlers } from '../ipc/models.mjs'
import { pluginsHandlers } from '../ipc/plugins.mjs'
import { browseRouteHandlers } from './browse-routes.mjs'

/**
 * Every control-plane method, keyed by channel.
 *
 * @param {object} deps the same collaborator bag registerIpcHandlers() is given.
 */
export function buildAdminApi(deps) {
  return {
    ...githubHandlers(),
    ...hardwareHandlers(deps),
    ...settingsHandlers(deps),
    ...authHandlers(),
    ...adminHandlers(deps),
    ...profilesHandlers(deps),
    ...toolsHandlers(deps),
    ...mcpHandlers(deps),
    ...capabilitiesHandlers(deps),
    ...serverHandlers(deps),
    ...modelsHandlers(deps),
    // No window dependency any more — plugins.mjs publishes install progress
    // to the shared event broker instead of pushing to a window handle it
    // used to be given.
    ...pluginsHandlers({ refreshLiveToolsConfig: deps.refreshLiveToolsConfig }),
    ...browseRouteHandlers(),
  }
}
