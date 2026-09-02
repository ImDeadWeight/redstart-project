// =============================================================================
// Unit tests for electron/main/event-broker.mjs (Phase 5 §5.1).
// =============================================================================
// Pure Node, no Electron dependency.
//
// Run:  node scripts/test-event-broker.mjs
// =============================================================================

import { publish, subscribeToEvents, subscriberCount } from '../electron/main/event-broker.mjs'

const results = []

async function test(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, pass: true, detail })
    console.log(`  ok  - ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    results.push({ name, pass: false, detail: err.message })
    console.log(`FAIL  - ${name}\n        ${err.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

console.log('\n--- publish / subscribe ---')

await test('a published event reaches a subscriber', () => {
  const received = []
  const unsub = subscribeToEvents((channel, payload) => received.push([channel, payload]))
  publish('server:log', 'hello')
  unsub()
  assert(received.length === 1, `expected 1 event, got ${received.length}`)
  assert(received[0][0] === 'server:log' && received[0][1] === 'hello', 'wrong channel/payload')
})

await test('multiple subscribers all receive the same event', () => {
  const a = [], b = []
  const unsubA = subscribeToEvents((c, p) => a.push([c, p]))
  const unsubB = subscribeToEvents((c, p) => b.push([c, p]))
  publish('server:tpm', 42)
  unsubA(); unsubB()
  assert(a.length === 1 && b.length === 1, 'not all subscribers received the event')
})

await test('unsubscribe actually stops delivery', () => {
  const received = []
  const unsub = subscribeToEvents((c, p) => received.push([c, p]))
  unsub()
  publish('server:stopped', null)
  assert(received.length === 0, 'a call arrived after unsubscribe')
})

await test('a throwing subscriber does not stop the next one', () => {
  const received = []
  const unsubBad = subscribeToEvents(() => { throw new Error('boom') })
  const unsubGood = subscribeToEvents((c, p) => received.push([c, p]))
  publish('server:log', 'still works')
  unsubBad(); unsubGood()
  assert(received.length === 1, 'the good subscriber never ran')
})

await test('subscriberCount reflects live subscriptions', () => {
  const before = subscriberCount()
  const unsub = subscribeToEvents(() => {})
  assert(subscriberCount() === before + 1, 'count did not increase on subscribe')
  unsub()
  assert(subscriberCount() === before, 'count did not decrease on unsubscribe')
})

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
