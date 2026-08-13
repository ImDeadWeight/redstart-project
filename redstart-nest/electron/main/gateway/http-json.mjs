'use strict'

// =============================================================================
// Redstart Nest — Gateway JSON wire helpers
// =============================================================================
// The two request/response primitives every gateway route module shares:
// write a JSON response with the CORS header the gateway always emits, and
// read a JSON request body.
//
// This module knows nothing about routes, auth, or config — it is the byte
// layer, extracted here only so the route modules do not each grow a private
// copy that can drift.
// =============================================================================

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

export async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try { return JSON.parse(raw || '{}') } catch { return null }
}
