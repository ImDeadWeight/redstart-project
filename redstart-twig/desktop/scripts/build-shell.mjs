#!/usr/bin/env node
// `npm run build`'s last step: `tauri build` for this platform with the
// installer config. The updater signature needs TAURI_SIGNING_PRIVATE_KEY (and
// _PASSWORD) in the environment; without them the build fails rather than
// producing an installer that can never be updated.
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const shell = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell')
const bundles = process.platform === 'win32' ? 'nsis' : 'app,dmg'
// One fixed command string: npx is a .cmd on Windows, which needs a shell.
execSync(`npx tauri build --config tauri.bundle.conf.json --bundles ${bundles}`, { cwd: shell, stdio: 'inherit' })
