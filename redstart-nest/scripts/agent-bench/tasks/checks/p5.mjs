// =============================================================================
// Agent bench — p5 checks: discovery and drift (tool retrieval benchmarks B3-B5)
// =============================================================================
// The p5 tasks (tasks/p5/) reuse the main set's prompts and checks with a
// tool withheld, so a result compares with the same task un-withheld. Two
// things are new here:
//
// - A tool found by search may be used through call_tool (U4 option b).
//   withCallTool() turns such a call into a call of the tool it names, so a
//   check that asks "was list_documents called" counts both ways.
// - The checks for the tasks that are new: a File System config read with
//   vague words (p5-vague-config), and a drift task whose follow-up saves a
//   memory (p5-drift-python-to-memory).
// =============================================================================

import { allAssistantText, fail, fixture, mentionsNumber, numbersIn, pass, toolCallsNamed } from './lib.mjs'
import { arithmetic } from './compute.mjs'
import { listedWithoutCode } from './multi.mjs'

/** call_tool's target, or null. */
function target(argumentsText) {
  try {
    const a = typeof argumentsText === 'string' ? JSON.parse(argumentsText) : argumentsText
    return typeof a?.name === 'string' ? a.name : null
  } catch {
    return null
  }
}

/** The events with each call_tool call standing for the tool it named. */
export function withCallTool(events) {
  return (events ?? []).map((e) => (e.type === 'tool_call' && e.name === 'call_tool' && target(e.arguments)
    ? { ...e, name: target(e.arguments), viaCallTool: true }
    : e))
}

/** p5-count-docs: multi-find-tool's check, a call_tool(list_documents) counting. */
export function countedDocs(text, files, events, ctx) {
  return listedWithoutCode(text, files, withCallTool(events), ctx)
}

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
 * memory tools are always pinned, so this is the control: it must pass
 * under either growth setting.
 */
export function rememberedProduct(text, files, events, ctx) {
  const product = arithmetic(allAssistantText(text, events), files, events, ctx)
  if (!product.pass) return product
  const saves = toolCallsNamed(withCallTool(events), 'memory_save')
  if (saves.length === 0) return fail('the product is right, but nothing was saved with memory_save')
  const savedIt = saves.some((e) => /481[,.\s]?283[,.\s]?227/.test(String(e.arguments)))
  return savedIt ? pass('the product, saved') : fail('memory_save was called, but not with the product')
}
