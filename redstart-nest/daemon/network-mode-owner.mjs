'use strict'

import { next, planSteps, factsFor, applyStep, INITIAL_FACTS } from './network-mode.mjs'
import { DEFAULT_GATEWAY_PORT } from './ports.mjs'
import { logEvent } from './logger.mjs'

// =============================================================================
// Redstart Nest — the network-mode owner: runs network-mode.mjs's steps
// =============================================================================
// The only thing that rebinds the gateway and MCP server, starts or stops the
// port-80 proxy, starts or stops Caddy, and adds the LAN firewall rules
// (TLS plan C2b, review R5). Everything else reports INPUTS to it: a launch
// (networkMode, port), boot (the last launch's record), Caddy's supervisor
// (its status), HTTPS settings (step 4), shutdown (stopping).
//
//   - One queue. Updates run one at a time in order, so two inputs arriving
//     together cannot interleave their steps.
//   - Stopping latches. After update({ stopping: true }) nothing turns it
//     back, so a late input during shutdown cannot restart anything.
//   - Facts per step. If a step fails, the owner knows exactly what is up,
//     tears down to `local` (best effort; always reachable) and then rebuilds
//     the state it was in before. If even that fails, it stays `local`:
//     loopback only, which is the safe place to be stuck.
//   - Caddy failing to bind is NOT a failed step. caddy:start resolves once
//     the supervisor is launched; "gave up" arrives as a status, latches
//     `caddyFailed`, and the next transition is the fallback (or, under
//     requireHttps, nothing).
//
// `effects` is the real world, injected so the executor is tested with fakes
// and with real sockets (test-network-mode-owner.mjs):
//   bindDataPlane(host), startPort80({ gatewayPort }), stopPort80(),
//   startCaddy({ serving }), stopCaddy(), ensureFirewall(rule, { gatewayPort })
// =============================================================================

const DEFAULT_INPUTS = Object.freeze({
  networkMode: false,
  tlsMode: 'off',
  caddyFailed: false,
  requireHttps: false,
  serving: false,
  caddyKey: '',
  stopping: false,
  gatewayPort: DEFAULT_GATEWAY_PORT,
})

/**
 * @param {{ effects: object, platform?: string, log?: typeof logEvent, onChange?: (s: object) => void }} deps
 */
export function createNetworkModeOwner({ effects, platform = process.platform, log = logEvent, onChange = () => {} }) {
  let inputs = { ...DEFAULT_INPUTS, platform }
  let state = 'local'
  let facts = INITIAL_FACTS
  let lastError = null
  let retries = 0
  let tail = Promise.resolve()

  const status = () => ({ state, host: facts.host, caddy: facts.caddy ? { ...facts.caddy } : null, port80Proxy: facts.port80Proxy, lastError, inputs: { ...inputs } })

  async function run(step) {
    const gatewayPort = inputs.gatewayPort
    switch (step.op) {
      case 'caddy:stop': return effects.stopCaddy()
      case 'port80:stop': return effects.stopPort80()
      case 'dataplane:bind': return effects.bindDataPlane(step.host)
      case 'port80:start': return effects.startPort80({ gatewayPort })
      case 'caddy:start': return effects.startCaddy({ serving: !!step.serving })
      case 'firewall:ensure': return effects.ensureFirewall(step.rule, { gatewayPort })
      default: throw new Error(`unknown step ${step.op}`)
    }
  }

  /** Run steps, updating facts after each; stop at the first failure. */
  async function runSteps(steps) {
    for (const step of steps) {
      await run(step)
      facts = applyStep(facts, step)
    }
  }

  /** Best effort: every step is tried, failures are logged and skipped. */
  async function runAll(steps) {
    for (const step of steps) {
      try { await run(step); facts = applyStep(facts, step) } catch (err) {
        log('network', 'rollback_step_failed', { op: step.op, message: err.message })
      }
    }
  }

  async function transition() {
    const plan = next(facts, inputs)
    if (plan.steps.length === 0) {
      if (plan.state !== state) { state = plan.state; onChange(status()) }
      return
    }
    const before = { state, facts }
    try {
      await runSteps(plan.steps)
      const from = state
      state = plan.state
      lastError = null
      log('network', 'state', { from, to: state, steps: plan.steps.map((s) => s.op) })
    } catch (err) {
      lastError = `${err.message}`
      log('network', 'step_failed', { to: plan.state, message: err.message })
      await runAll(planSteps(facts, factsFor('local', inputs)))
      state = 'local'
      if (before.state !== 'local' && before.state !== 'stopping') {
        try {
          await runSteps(planSteps(facts, before.facts))
          state = before.state
        } catch (again) {
          log('network', 'rollback_failed', { to: before.state, message: again.message })
          await runAll(planSteps(facts, factsFor('local', inputs)))
          state = 'local'
        }
      }
    }
    onChange(status())
  }

  /**
   * Change some inputs and converge. Serialised; resolves with the status
   * after this update's transition.
   * @param {Partial<typeof DEFAULT_INPUTS>} patch
   */
  function update(patch = {}) {
    const job = tail.then(async () => {
      const wasStopping = inputs.stopping
      inputs = { ...inputs, ...patch, platform }
      if (wasStopping) inputs.stopping = true
      // A new Caddy configuration, or HTTPS turned off, is a fresh start:
      // the failed latch belonged to the old one.
      if (('caddyKey' in patch && patch.caddyKey !== undefined) || inputs.tlsMode === 'off') {
        if (!('caddyFailed' in patch)) inputs.caddyFailed = false
      }
      await transition()
      return status()
    })
    tail = job.catch(() => {})
    return job
  }

  return {
    update,
    status,
    /** The bind host the gateway and MCP server must use when they start. */
    dataPlaneHost: () => facts.host ?? '127.0.0.1',
    /** The supervisor's onStateChange. "failed" latches; nothing else decides. */
    caddyStatus(s) {
      if (s?.state !== 'failed') return tail
      // Judged INSIDE the queue: a failure reported during caddy:start (a
      // missing binary fails synchronously) arrives before that step's facts
      // are recorded, and checking now would drop it.
      const job = tail.then(async () => {
        if (!facts.caddy || inputs.caddyFailed) return status()
        log('network', 'caddy_gave_up', { reason: s.reason ?? null })
        inputs = { ...inputs, caddyFailed: true }
        await transition()
        return status()
      })
      tail = job.catch(() => {})
      return job
    },
    /** "Try again" from the panel: a fresh attempt clears the latch. */
    retryCaddy() {
      retries++
      return update({ caddyFailed: false, caddyKey: `${String(inputs.caddyKey).replace(/#retry\d+$/, '')}#retry${retries}` })
    },
  }
}
