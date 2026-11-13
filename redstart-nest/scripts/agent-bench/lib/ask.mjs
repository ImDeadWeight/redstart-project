// =============================================================================
// Agent bench — answering ask_user from the task file (agent-runtime plan §4)
// =============================================================================
// A task's `answers` maps a piece of the question to the answer the person
// would give:
//
//   "answers": { "name": "Priya Natarajan", "where": "Save it here in this chat." }
//
// Matching is a case-insensitive substring of the question, tried in the
// file's order; "" matches any question. Key answers by topic: a catch-all
// answers every question with the same fact, and on 2026-11-12 the 35B asked
// "vault or documents folder?" three times and got "Priya Natarajan" each
// time. Use "" only where every question the task could raise has the one
// answer (p1-stop-and-report). No match is a dismissal, which the
// core turns into "The user did not answer. Continue with your best judgement
// ...". That is the right answer for the tasks that should never ask: an
// unneeded question costs the run a turn, and shows in the summary's count.
//
// When the question offered options and the answer names one (same text,
// case-insensitively), it comes back as a choice, exactly as a click on the
// card would; anything else is typed text.
//
// Several questions in one call (D43) are matched one by one, as the card
// would be filled in: `{ answers: [...] }`, null where nothing matched, and
// a dismissal only when nothing matched at all.
// =============================================================================

/**
 * @param {Record<string, string>} answers the task's answers
 * @param {{ question: string, options?: string[] }} q
 * @returns {{ chosen?: string[], text?: string } | null}
 */
function answerOne(answers, q) {
  const question = q.question.toLowerCase()
  for (const [needle, answer] of Object.entries(answers ?? {})) {
    if (!question.includes(needle.toLowerCase())) continue
    const option = q.options?.find((o) => o.trim().toLowerCase() === answer.trim().toLowerCase())
    return option ? { chosen: [option] } : { text: answer }
  }
  return null
}

/**
 * @param {Record<string, string>} answers the task's answers
 * @param {{ questions: Array<{ question: string, options?: string[] }> } | { question: string, options?: string[] }} request
 *   a parsed request, or one bare question (a question asked in reply text)
 * @returns {{ chosen?: string[], text?: string, answers?: Array<{ chosen?: string[], text?: string } | null> } | null} null: dismissed
 */
export function answerFromTask(answers, request) {
  const questions = 'questions' in request ? request.questions : [request]
  if (questions.length <= 1) return questions[0] ? answerOne(answers, questions[0]) : null
  const replies = questions.map((q) => answerOne(answers, q))
  return replies.some((r) => r !== null) ? { answers: replies } : null
}
