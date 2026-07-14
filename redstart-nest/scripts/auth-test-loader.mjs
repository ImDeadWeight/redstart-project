// Node ESM resolve hook — redirects `import ... from 'electron'` to the
// stub in electron-stub.mjs. Registered by scripts/test-auth.mjs before it
// imports any of the real electron/main/*.mjs auth modules.

import { fileURLToPath, pathToFileURL } from 'node:url'
import * as path from 'node:path'

const stubUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'electron-stub.mjs')
).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
