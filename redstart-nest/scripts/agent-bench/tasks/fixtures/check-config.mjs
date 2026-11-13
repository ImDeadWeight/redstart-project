// Exits non-zero when the configuration file is missing.
import { existsSync } from 'node:fs'

if (!existsSync('app.config.json')) {
  console.error('config missing: app.config.json was not found in the working directory')
  process.exit(3)
}
console.log('config ok')
