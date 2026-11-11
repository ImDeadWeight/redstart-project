// Checks for the harness's own fixture tasks (scripts/test-agent-bench.mjs).
// A check is (finalText, workspaceFiles, events) => { pass, reason }.

export function answerFile(_text, files) {
  return files['out/answer.txt'] === '42'
    ? { pass: true, reason: 'out/answer.txt holds 42' }
    : { pass: false, reason: `out/answer.txt is ${JSON.stringify(files['out/answer.txt'] ?? null)}` }
}

export function saysSeven(text) {
  return /\b7\b/.test(text) ? { pass: true, reason: 'the answer names 7' } : { pass: false, reason: 'no 7 in the answer' }
}

export function neverPasses() {
  return { pass: false, reason: 'by design' }
}

export function throws() {
  throw new Error('check exploded')
}
