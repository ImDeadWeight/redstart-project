// =============================================================================
// Agent bench — p5 checks: discovery and drift (tool retrieval benchmarks B3-B5)
// =============================================================================
// The checks for the p5 tasks the main set has none for: a File System
// config read with vague words, reached through the catalog
// (p5-vague-config), and a drift task whose follow-up saves a memory
// (p5-drift-python-to-memory). The tasks that withheld a tool went with
// per-turn selection (master plan 3.3).
// =============================================================================

import { allAssistantText, fail, fixture, mentionsNumber, numbersIn, pass, toolCallsNamed, withCallTool } from './lib.mjs'
import { arithmetic } from './compute.mjs'

// withCallTool lives in lib.mjs now (every check counts call_tool since
// 2026-11-18); re-exported here for the callers that import it from p5.
export { withCallTool }

/** The port in the p5-vague-config fixture, read from it. */
export const CONFIG_FILE = 'p5-app/settings.json'
const configPort = () => JSON.parse(fixture('p5-app-settings.json')).server.port

/** p5-vague-config: the port the settings file sets, not the readme's default. */
export function configuredPort(text, _files, events) {
  const port = configPort()
  const said = allAssistantText(text, events)
  if (mentionsNumber(said, port, 0)) return pass(`said ${port}`)
  return fail(`expected port ${port}, saw ${numbersIn(said).join(', ') || 'no numbers'}`)
}

/**
 * p5-drift-python-to-memory: the product is right, and the follow-up saved
 * it with memory_save (the bench removes the memory after the run). The
 * memory tools are core, in every list, so this is the control.
 */
export function rememberedProduct(text, files, events, ctx) {
  const product = arithmetic(allAssistantText(text, events), files, events, ctx)
  if (!product.pass) return product
  const saves = toolCallsNamed(withCallTool(events), 'memory_save')
  if (saves.length === 0) return fail('the product is right, but nothing was saved with memory_save')
  const savedIt = saves.some((e) => /481[,.\s]?283[,.\s]?227/.test(String(e.arguments)))
  return savedIt ? pass('the product, saved') : fail('memory_save was called, but not with the product')
}
