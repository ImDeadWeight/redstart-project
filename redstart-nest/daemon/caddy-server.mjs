'use strict'

import { spawn as nodeSpawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'

import { logEvent } from './logger.mjs'
import { writePidFile, deletePidFile, reapStaleProcess, killByPid } from './process-supervision.mjs'

// =============================================================================
// Redstart Nest — the bundled Caddy, supervised (TLS plan C2)
// =============================================================================
// Caddy is Nest's LAN TLS front door. Certificates and renewal are Caddy's;
// Nest writes its configuration (caddy-config.mjs), holds the secrets,
// starts / stops / watches the process, and reports. Nest never parses a
// certificate request or touches a private key.
//
// INVARIANTS
//   - Never load-bearing for loopback. Every failure is a status, never a
//     throw: a dead Caddy stops LAN access and nothing else. (The same rule as
//     the embedding server.)
//   - Reports, does not decide (review R5). State changes go to onStateChange;
//     this module never rebinds the gateway or touches the firewall. The
//     network-mode owner (C2b) does that.
//   - Secrets by environment only. The config file holds {env.NAME}
//     placeholders; start() refuses a config whose text contains any secret
//     value, and every log line has the secret values scrubbed out before it
//     is kept or logged (DuckDNS carries its token in a URL query string, and
//     a plugin error may quote the URL).
//   - The child's environment is an allowlist plus those secrets, not Nest's
//     whole environment: a plugin's or a provider's key in Nest's env has no
//     business inside the process holding port 443.
//   - stop() resolves only once the process has EXITED. C2b's ordering rule
//     (a port is released before anything else binds it) depends on that.
//   - The binary is never configurable: bundled, dev tree, or an install's
//     own bin/. No settings override, no PATH lookup.
//
// Restart policy: unexpected exits restart after 1 s, 2 s, 5 s, then 30 s;
// the fifth failure inside 5 minutes gives up and reports `failed` with the
// last error line. A deliberate stop never restarts.
// =============================================================================

export const CADDY_PID_FILE = 'caddy.pid'

const RESTART_DELAYS_MS = [1000, 2000, 5000, 30000]
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const MAX_FAILURES_IN_WINDOW = 5
const STOP_TIMEOUT_MS = 5000
const TAIL_LINES = 50

/** Inherited from Nest's environment when set; everything else is dropped. */
const ENV_ALLOWLIST = [
  // Windows networking and the Go runtime need these to start at all.
  'SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'Path',
  // Caddy resolves its app-data directory at startup even with storage overridden.
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  // A managed network may need a proxy to reach the ACME CA and the DNS API.
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
]
const SECRET_NAME_RE = /^REDSTART_[A-Z0-9_]+$/

export function caddyBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'caddy.exe' : 'caddy'
}

/** Where the config file and Caddy's storage live, under Nest's config dir. */
export function caddyPaths(configDir) {
  const dir = path.join(configDir, 'caddy')
  return { dir, configFile: path.join(dir, 'caddy.json'), storageDir: path.join(dir, 'storage') }
}

/**
 * Where the binary may be, in order. Packaged: resources/bin, staged by
 * stage-shell-bundle.mjs. Dev: redstart-nest/deps/caddy (fetch-caddy.mjs).
 * Then an install's own bin/ beside its config, which is the only candidate a
 * headless nestd has (the same list resolveBinary() uses for llama-server).
 *
 * @param {{ packaged: boolean, resourcesDir?: string|null, nestRoot: string, configDir: string, platform?: string }} p
 */
export function caddyBinaryCandidates({ packaged, resourcesDir, nestRoot, configDir, platform = process.platform }) {
  const name = caddyBinaryName(platform)
  const out = []
  if (packaged && resourcesDir) out.push(path.join(resourcesDir, 'bin', name))
  else out.push(path.join(nestRoot, 'deps', 'caddy', name))
  out.push(path.join(configDir, 'bin', name))
  if (platform !== 'win32') out.push(path.join('/usr/lib/redstart/bin', name), path.join('/usr/local/lib/redstart/bin', name))
  return out
}

/**
 * The child's environment: the allowlist from `base`, plus the secrets.
 * @param {{ base?: Record<string,string|undefined>, secrets?: Record<string,string> }} p
 */
export function caddyEnv({ base = process.env, secrets = {} } = {}) {
  const env = {}
  for (const key of ENV_ALLOWLIST) if (typeof base[key] === 'string') env[key] = base[key]
  for (const [key, value] of Object.entries(secrets)) {
    if (!SECRET_NAME_RE.test(key)) throw new Error(`secret env name ${key} must match REDSTART_*`)
    if (typeof value !== 'string' || !value) throw new Error(`secret ${key} is empty`)
    env[key] = value
  }
  return env
}

/** Replace every secret value in a line. Values shorter than 4 chars are not secrets worth the false positives. */
export function scrub(line, secretValues) {
  let out = String(line)
  for (const v of secretValues) if (v && v.length >= 4) out = out.split(v).join('[redacted]')
  return out
}

/**
 * Read one line of Caddy's output. Caddy's own log is JSON (caddy-config.mjs
 * sends it to stdout); startup errors before logging is up are plain text.
 *
 * @returns {{ kind: 'ready'|'cert_obtained'|'cert_renewed'|'acme_error'|'error'|'other', msg: string, json: object|null }}
 */
export function classifyCaddyLine(line) {
  let json = null
  try { json = JSON.parse(line) } catch { /* plain text */ }
  if (!json || typeof json !== 'object') {
    return { kind: /^Error:|\berror\b/i.test(line) ? 'error' : 'other', msg: String(line).trim(), json: null }
  }
  const msg = String(json.msg ?? '')
  const logger = String(json.logger ?? '')
  const level = String(json.level ?? '')
  if (msg === 'serving initial configuration') return { kind: 'ready', msg, json }
  if (msg === 'certificate obtained successfully') return { kind: 'cert_obtained', msg, json }
  if (msg === 'certificate renewed successfully') return { kind: 'cert_renewed', msg, json }
  if ((level === 'error' || level === 'warn') && logger.startsWith('tls')) {
    return { kind: 'acme_error', msg: json.error ? `${msg}: ${json.error}` : msg, json }
  }
  if (level === 'error' || level === 'fatal') return { kind: 'error', msg: json.error ? `${msg}: ${json.error}` : msg, json }
  return { kind: 'other', msg, json }
}

/**
 * One sentence an admin can act on, from Caddy's last error line.
 * @param {string|null} line
 */
export function explainFailure(line) {
  const text = String(line ?? '')
  const port = /listen tcp[46]? [^:]*:(\d+)/.exec(text)?.[1]
  if (port && /address already in use|Only one usage of each socket address|bind: address/i.test(text)) {
    return `Port ${port} is in use by another program`
  }
  if (port && /permission denied|access permissions|forbidden by its access/i.test(text)) {
    return `Caddy isn't allowed to use port ${port}`
  }
  return text ? `Caddy stopped: ${text.slice(0, 300)}` : 'Caddy stopped without saying why'
}

/**
 * The delay before the next restart, or null to give up.
 * @param {number[]} failureTimes  every unexpected exit so far (ms)
 * @param {number} now
 */
export function nextRestartDelay(failureTimes, now, delays = RESTART_DELAYS_MS) {
  const recent = failureTimes.filter((t) => now - t < FAILURE_WINDOW_MS).length
  if (recent >= MAX_FAILURES_IN_WINDOW) return null
  return delays[Math.min(Math.max(recent - 1, 0), delays.length - 1)]
}

/**
 * One supervisor per daemon.
 *
 * @param {{
 *   resolveBinary: () => string|null,
 *   configDir: string,
 *   onStateChange?: (status: object) => void,
 *   spawn?: typeof nodeSpawn,
 *   now?: () => number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   baseEnv?: Record<string,string|undefined>,
 *   stopTimeoutMs?: number,
 *   restartDelaysMs?: number[],   // tests only: the production backoff is the default
 * }} deps
 */
export function createCaddySupervisor({
  resolveBinary, configDir, onStateChange = () => {}, spawn = nodeSpawn,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, baseEnv = process.env,
  stopTimeoutMs = STOP_TIMEOUT_MS, restartDelaysMs = RESTART_DELAYS_MS,
}) {
  const st = {
    state: 'stopped',
    reason: null,
    pid: null,
    startedAt: null,
    restarts: 0,
    lastAcmeError: null,
    lastCertificateAt: null,
  }
  let child = null
  let exited = null          // promise resolving when `child` exits
  let wanted = null          // { config, secrets } while Caddy should be running
  let restartTimer = null
  let failures = []
  let tail = []
  let secretValues = []

  const status = () => ({ ...st })
  function set(patch) {
    const before = `${st.state}|${st.reason}`
    Object.assign(st, patch)
    if (`${st.state}|${st.reason}` !== before) {
      try { onStateChange(status()) } catch { /* a listener's bug is not Caddy's failure */ }
    }
  }

  function keep(line) {
    tail.push(line)
    if (tail.length > TAIL_LINES) tail.shift()
  }

  function onLine(raw) {
    const line = scrub(raw, secretValues)
    keep(line)
    const c = classifyCaddyLine(line)
    if (c.kind === 'ready') {
      if (st.state === 'starting') set({ state: 'running', reason: null })
      logEvent('tls', 'caddy_ready', { pid: st.pid })
    } else if (c.kind === 'cert_obtained' || c.kind === 'cert_renewed') {
      st.lastAcmeError = null
      st.lastCertificateAt = now()
      logEvent('tls', c.kind === 'cert_obtained' ? 'certificate_obtained' : 'certificate_renewed', { identifier: c.json?.identifier })
    } else if (c.kind === 'acme_error') {
      st.lastAcmeError = c.msg.slice(0, 500)
      logEvent('tls', 'acme_error', { message: st.lastAcmeError })
    }
  }

  function lastErrorLine() {
    for (let i = tail.length - 1; i >= 0; i--) {
      const c = classifyCaddyLine(tail[i])
      if (c.kind === 'error' || c.kind === 'acme_error') return c.msg
    }
    return tail.length ? classifyCaddyLine(tail[tail.length - 1]).msg : null
  }

  function launch() {
    restartTimer = null
    if (!wanted) return
    const { configFile } = caddyPaths(configDir)
    let binaryPath
    try { binaryPath = resolveBinary() } catch { binaryPath = null }
    if (!binaryPath || !fs.existsSync(binaryPath)) {
      wanted = null
      set({ state: 'failed', reason: 'The bundled Caddy was not found', pid: null, startedAt: null })
      return
    }
    let env
    try { env = caddyEnv({ base: baseEnv, secrets: wanted.secrets }) } catch (err) {
      wanted = null
      set({ state: 'failed', reason: err.message })
      return
    }
    tail = []
    let proc
    try {
      proc = spawn(binaryPath, ['run', '--config', configFile], {
        env,
        cwd: path.dirname(configFile),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      return onExit(null, null, `Caddy could not be started: ${err.message}`)
    }
    child = proc
    let resolveExit
    exited = new Promise((r) => { resolveExit = r })
    for (const stream of [proc.stdout, proc.stderr]) {
      if (stream) readline.createInterface({ input: stream }).on('line', onLine)
    }
    let done = false
    const finish = (code, signal, err) => {
      if (done) return
      done = true
      deletePidFile(configDir, { name: CADDY_PID_FILE })
      if (child === proc) { child = null }
      resolveExit()
      onExit(code, signal, err)
    }
    proc.on('error', (err) => finish(null, null, `Caddy could not be started: ${err.message}`))
    proc.on('exit', (code, signal) => finish(code, signal, null))
    const startedAt = now()
    if (proc.pid) writePidFile(configDir, { pid: proc.pid, binaryPath, startedAt }, { name: CADDY_PID_FILE })
    set({ state: 'starting', reason: null, pid: proc.pid ?? null, startedAt })
    logEvent('tls', 'caddy_started', { pid: proc.pid ?? null })
  }

  function onExit(code, signal, spawnError) {
    st.pid = null
    st.startedAt = null
    if (!wanted) return   // a deliberate stop: stop() sets the state
    const t = now()
    failures = failures.filter((f) => t - f < FAILURE_WINDOW_MS)
    failures.push(t)
    const reason = spawnError ?? explainFailure(lastErrorLine())
    logEvent('tls', 'caddy_exited', { code, signal, reason })
    const delay = nextRestartDelay(failures, t, restartDelaysMs)
    if (delay == null) {
      wanted = null
      set({ state: 'failed', reason: `${reason} (gave up after ${failures.length} failures in 5 minutes)` })
      return
    }
    st.restarts++
    set({ state: 'starting', reason: `${reason} — restarting in ${Math.round(delay / 1000)} s` })
    restartTimer = setTimer(launch, delay)
  }

  /**
   * Start, or restart with a new configuration. Never throws.
   * @param {{ config: object, secrets?: Record<string,string> }} p
   */
  async function start({ config, secrets = {} }) {
    await stop()
    const text = JSON.stringify(config, null, 2)
    const values = Object.values(secrets).filter((v) => typeof v === 'string' && v)
    // Defence in depth over caddy-config.mjs's own check: whatever built the
    // config, a secret value never reaches the disk.
    if (values.some((v) => text.includes(v))) {
      set({ state: 'failed', reason: 'Refused: the Caddy configuration contained a secret value' })
      logEvent('security', 'caddy_config_secret_refused', {})
      return status()
    }
    const { configFile, storageDir } = caddyPaths(configDir)
    try {
      await reapStaleProcess(configDir, { name: CADDY_PID_FILE })
    } catch { /* best effort */ }
    try {
      fs.mkdirSync(storageDir, { recursive: true })
      fs.writeFileSync(configFile, text, { mode: 0o600 })
    } catch (err) {
      set({ state: 'failed', reason: `Could not write ${path.relative(configDir, configFile)}: ${err.message}` })
      return status()
    }
    secretValues = values
    wanted = { config, secrets }
    failures = []
    st.restarts = 0
    launch()
    return status()
  }

  /** Stop and wait for the process to exit (or be killed). Idempotent. */
  async function stop() {
    wanted = null
    if (restartTimer) { clearTimer(restartTimer); restartTimer = null }
    const proc = child
    const gone = exited
    if (proc) {
      const pid = proc.pid
      try { proc.kill() } catch { /* already gone */ }
      const timedOut = await Promise.race([
        gone.then(() => false),
        new Promise((r) => setTimer(() => r(true), stopTimeoutMs)),
      ])
      if (timedOut && pid) {
        await killByPid(pid, { tree: true }).catch(() => {})
        await Promise.race([gone, new Promise((r) => setTimer(r, stopTimeoutMs))])
      }
      child = null
      deletePidFile(configDir, { name: CADDY_PID_FILE })
    }
    set({ state: 'stopped', reason: null, pid: null, startedAt: null })
  }

  return { start, stop, status, tail: () => [...tail] }
}
