// =============================================================================
// Point `import ... from 'electron'` at scripts/electron-stub.mjs, for tests
// =============================================================================
// Node 26 deprecates module.register() (off-thread loader hooks). The
// replacement is module.registerHooks(), synchronous and in-thread, which
// exists from Node 22.15. On anything older, this falls back to registering
// auth-test-loader.mjs the old way. The behaviour is identical either way:
// only the bare 'electron' specifier is redirected.
//
// Call it before the first dynamic import of a module that imports 'electron'.
// =============================================================================

import * as nodeModule from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const stubUrl = pathToFileURL(path.join(here, 'electron-stub.mjs')).href

export function registerElectronStub() {
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'electron') return { url: stubUrl, shortCircuit: true }
        return nextResolve(specifier, context)
      },
    })
    return
  }
  nodeModule.register('./auth-test-loader.mjs', import.meta.url)
}
