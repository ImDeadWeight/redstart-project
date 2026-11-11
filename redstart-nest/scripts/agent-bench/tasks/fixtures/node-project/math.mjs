// Small arithmetic helpers.

export function add(a, b) {
  return Math.abs(a) + Math.abs(b)
}

export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}
