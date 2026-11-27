// =============================================================================
// Free ports for a test's servers
// =============================================================================
// Chosen at run time rather than fixed. A fixed port in the 48000s sits in
// Linux's ephemeral range (32768-60999), where a CI runner's own outgoing
// sockets live, and a runner took one more than once (EADDRINUSE before a
// single case ran: 48180 in test-gateway-routes, 48082 in test-contracts).
// This picks a block below that range and checks every port in it is free.
// =============================================================================

import * as net from 'node:net'
import { randomInt } from 'node:crypto'

function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/** The first of `size` free ports in a row, between 20000 and 32000. */
export async function freeBlock(size = 3) {
  for (let attempt = 0; attempt < 50; attempt++) {
    // crypto.randomInt rather than Math.random: nothing here needs to be
    // unpredictable, but CodeQL flags Math.random and this costs nothing.
    const base = randomInt(20000, 32000 - size)
    let ok = true
    for (let i = 0; i < size && ok; i++) ok = await canBind(base + i)
    if (ok) return base
  }
  throw new Error(`no ${size} free ports in a row between 20000 and 32000`)
}
