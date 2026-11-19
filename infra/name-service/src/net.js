// Which addresses an install may publish (TLS plan C12, invariant 7).
// Only private ones: the names point at machines on a home network, and a
// public address would turn the service into free dynamic DNS for anything
// on the internet, a different threat model (D7).

const PRIVATE_V4 = [
  [0x0a000000, 0xff000000], // 10/8
  [0xac100000, 0xfff00000], // 172.16/12
  [0xc0a80000, 0xffff0000], // 192.168/16
  [0x64400000, 0xffc00000], // 100.64/10 (CGNAT, Tailscale)
]

export function isPrivateIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip))
  if (!m) return false
  const p = m.slice(1).map(Number)
  if (p.some((x) => x > 255) || m.slice(1).some((s) => s.length > 1 && s.startsWith('0'))) return false
  const n = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
  return PRIVATE_V4.some(([net, mask]) => ((n & mask) >>> 0) === net)
}

/**
 * A unique-local IPv6 address in fd00::/8 (the locally assigned half of
 * fc00::/7). Never a global address: that is reachable from outside.
 * Returns the address in canonical lower case, or null.
 */
export function ulaIPv6(ip) {
  const s = String(ip ?? '').trim().toLowerCase()
  if (!/^fd[0-9a-f]{2}:[0-9a-f:]+$/.test(s)) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (h) => (h ? h.split(':') : [])
  const [a, b = null] = halves.map(groups)
  const all = b === null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return s
}
