'use strict'

// ---------------------------------------------------------------------------
// KV-cache quantization — which -ctk/-ctv a "Memory saving" preset becomes
// ---------------------------------------------------------------------------
// The bundled engine is upstream llama.cpp (ggml-org's own release builds).
// A profile picks a preset (off / conservative / balanced / aggressive); this
// module turns it into the cache types the binary that will actually run
// accepts:
//
//   preset         upstream llama.cpp     TurboQuant+ binary (custom path)
//   conservative   K q8_0  V q8_0         K q8_0  V turbo4
//   balanced       K q8_0  V q4_0         K q8_0  V turbo3
//   aggressive     K q4_0  V q4_0         K q8_0  V turbo2
//
// Roughly, against the f16 default (K+V together): q8_0/q8_0 holds ~1.9x the
// context, q8_0/q4_0 ~2.5x, q4_0/q4_0 ~3.5x. The turbo V types squeeze V
// further (turbo3 ~3.5 bits a value), so a TurboQuant+ binary gains a little
// on top. The rule from the fork's papers is kept where it can be: K stays
// q8_0 and only V drops. Upstream has nothing below q4_0 for V, so its
// aggressive tier is the one place K goes down too — which is why the UI
// tells you to check answers on your model there.
//
// A quantized V cache needs flash attention. Both builds' default
// `--flash-attn auto` turns it on by itself for a quantized V cache, so
// nothing is added for that.
//
// DETECTION. `llama-server --help` prints, under -ctv/--cache-type-v, the
// line "allowed values: f32, f16, ..., q5_1" (common/arg.cpp,
// get_all_kv_cache_types). A TurboQuant+ build lists turbo2/turbo3/turbo4
// there as well. server-help.mjs's probeServerHelp() reads that list (with
// parseCacheTypes below) once per binary. If the probe fails, the upstream
// mapping is used: q8_0 and q4_0 exist in every build of either project, so
// the fallback cannot ask for a type the binary lacks.
// ---------------------------------------------------------------------------

export const KV_CACHE_PRESETS = {
  conservative: { upstream: { k: 'q8_0', v: 'q8_0' }, turbo: { k: 'q8_0', v: 'turbo4' } },
  balanced:     { upstream: { k: 'q8_0', v: 'q4_0' }, turbo: { k: 'q8_0', v: 'turbo3' } },
  aggressive:   { upstream: { k: 'q4_0', v: 'q4_0' }, turbo: { k: 'q8_0', v: 'turbo2' } },
}


/**
 * The cache types a `llama-server --help` text says -ctv accepts, or null when
 * the text has no such list (not llama-server, or a format this does not know).
 */
export function parseCacheTypes(helpText) {
  if (typeof helpText !== 'string' || !helpText) return null
  const lines = helpText.split(/\r?\n/)
  const at = lines.findIndex(l => /--cache-type-v\b/.test(l))
  if (at === -1) return null
  // The allowed-values line follows the flag within its own help entry; stop
  // at the next flag so another option's list is never read by mistake.
  for (let i = at; i < Math.min(lines.length, at + 6); i++) {
    if (i > at && /^\s*-{1,2}[a-z]/i.test(lines[i])) break
    const m = lines[i].match(/allowed values:\s*(.+)$/i)
    if (m) {
      const types = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      return types.length ? new Set(types) : null
    }
  }
  return null
}

/**
 * The -ctk/-ctv pair for a preset against what the binary accepts.
 *   null                         → preset is off/unknown: pass no cache flags
 *   { k, v, codec: 'turbo' }     → the binary lists the turbo types
 *   { k, v, codec: 'upstream' }  → everything else, including an unknown binary
 */
export function kvCacheTypes(preset, supported) {
  // Own keys only: a profile's kvCache is file data, and '__proto__' or
  // 'constructor' must not resolve to anything.
  if (typeof preset !== 'string' || !Object.hasOwn(KV_CACHE_PRESETS, preset)) return null
  const p = KV_CACHE_PRESETS[preset]
  if (supported && supported.has(p.turbo.k) && supported.has(p.turbo.v)) return { ...p.turbo, codec: 'turbo' }
  return { ...p.upstream, codec: 'upstream' }
}

/**
 * Apply a profile's kvCache preset: returns the config with `kvCacheTypes`
 * set — { k, v } for buildArgs to emit as -ctk/-ctv, or null for "decided:
 * no cache flags" — and a line for the run log. `supported` is
 * probeServerHelp()'s cacheTypes (a Set, or null if unknown).
 */
export function resolveKvCache(config, supported) {
  const preset = config?.kvCache
  const types = kvCacheTypes(preset, supported)
  // null, not absent: buildArgs maps a config with no kvCacheTypes at all
  // itself, and must not undo a decision made here.
  const next = { ...config, kvCacheTypes: null }
  if (!types) {
    return { config: next, logLine: '[redstart] KV cache: f16 (memory saving off)' }
  }
  if (supported && !(supported.has(types.k) && supported.has(types.v))) {
    // A binary that lists cache types but not these: launch at f16 rather
    // than hand llama-server a value it will refuse at startup.
    return {
      config: next,
      logLine: `[redstart] KV cache: f16 — this llama-server does not accept ${types.k}/${types.v} (allowed: ${[...supported].join(', ')})`,
    }
  }
  next.kvCacheTypes = { k: types.k, v: types.v }
  const source = types.codec === 'turbo'
    ? 'TurboQuant+ types, listed by this llama-server'
    : supported ? 'llama.cpp types' : 'llama.cpp types; the binary could not be asked'
  return { config: next, logLine: `[redstart] KV cache: ${preset} → K ${types.k}, V ${types.v} (${source})` }
}
