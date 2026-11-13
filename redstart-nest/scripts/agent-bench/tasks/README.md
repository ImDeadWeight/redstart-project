# Agent benchmark tasks

The 24 tasks of agent-runtime plan Phase 0.3, with the Phase 1 group revised
once ask_user and update_plan existed (2026-11-11), and one Phase 2 task (2026-11-12): 32 in six groups. Run them with
`node scripts/agent-bench/run.mjs --model-label "<model> <quant>"` against a
Nest with a model loaded (see the header of `run.mjs`).

Every check is deterministic and scores the outcome (a file, a number, a
refusal), never how many calls it took. `scripts/test-agent-bench-tasks.mjs`
(in CI) runs each check against a correct outcome and a plausible wrong one.

| task | group | needs | what a pass means |
|---|---|---|---|
| compute-arithmetic | compute | run_python | the exact product, not an estimate |
| compute-csv-summary | compute | run_python | all four region totals, and the right top region |
| compute-chart | compute | run_python | a .png was saved |
| compute-dates | compute | run_python | 1000 days, and Friday |
| compute-join | compute | run_python | the top customer by total amount, with the total |
| compute-convert | compute | run_python or create_document | people.csv, columns and row order as asked |
| docs-find-fact | documents | read_document or run_python | 21 days, and the cover colleague |
| docs-two-sources | documents | create_document | a markdown brief with the site, 18 beds and the 4,011 total |
| docs-rename | documents | run_python | three files renamed, contents intact, originals gone |
| docs-search | documents | search_documents | $250,000, not another vendor's cap |
| docs-missing-file | documents | — | says the file is not there, invents nothing |
| multi-three-deliverables | multi | run_python | totals.csv, a chart, and the overall total |
| multi-recover | multi | run_python | the average without the malformed rows (the first read errors) |
| multi-chain | multi | run_python or read_document | the end of a 13-file chain (one file per turn takes 14 turns; the limit was 10 until 2026-11-11, now 30) |
| multi-find-tool | multi | list_documents | counts the files without running code |
| multi-distractor | multi | read_document | the codename, despite the File System tools' different root |
| p1-sign-off-name | phase 1 | ask_user | thanks.md signed "Priya Natarajan", a full name in no file |
| p1-standard-discount | phase 1 | ask_user | every price in quote.csv cut by the 12% it was told, not a guessed rate |
| p1-pick-vendors | phase 1 | ask_user | asked which contracts, then only Kestrel (60 days) and Osprey (30), no Alder |
| p1-answer-steers | phase 1 | ask_user | asked the order, then sorted by the answer (age, oldest first), not by name |
| p1-skip-no-invent | phase 1 | — (a question is skipped) | the note written with a placeholder for the full name (or says it is needed), no made-up name |
| p1-resolved-in-file | phase 1 | — (a guard) | converted without asking: the column is temp_c |
| p1-simple-stays-simple | phase 1 | — (a guard) | 11,123 for North, with no ask_user and no update_plan |
| p1-five-steps | phase 1 | update_plan helps | all five steps, including the easy-to-forget fourth |
| p1-plan-eight-deliverables | phase 1 | update_plan helps | eight outputs over two files, ending with a manifest of every file made |
| p1-plan-missing-input | phase 1 | update_plan helps | steps 1 and 3 done, no net.csv made up, and says returns.csv is missing |
| p1-stop-and-report | phase 1 | — | the three new prices applied, SKU-9 left alone, and said so |
| p2-delete-confirmed | phase 2 | delete_file (approval-enforced) | p2-old-draft.txt deleted through delete_file after the approval exchange, p2-final.txt kept |
| p4-run-tests | phase 4 | run_command | names the failing test |
| p4-fix-test | phase 4 | run_command helps | math.mjs fixed, the test untouched |
| p4-git-log | phase 4 | run_command | the third most recent commit's author and message |
| p4-exit-code | phase 4 | run_command | reports failure, exit code 3, and why |

**p2-delete-confirmed needs File System deletes allowed** (Nest → Tools →
File System → Allow destructive operations, server-wide); run.mjs warns at
the start when delete_file is not offered (a task's `requires`). Its two
files are seeded into the account's File System folder (a fixture with
`"space": "files"`, not an attachment) after the bench's snapshot of that
folder, so whatever the run leaves is removed afterwards.

Phase 1 and Phase 4 tasks are expected to fail until those phases land; that
is how a phase shows it helped. p4-fix-test can pass early, by editing the
file with run_python.

**The Phase 1 group was revised on 2026-11-11**, after the first runs and the
ask_user probe (`probe-ask.mjs`). Four tasks went because a model could pass
or fail them for the wrong reason: p1-ambiguous-units (the value range settles
Celsius, so guessing was fair), p1-which-draft (fixing both drafts is a
defensible reading), p1-assume-on-skip (judged on how the reply was worded)
and p1-plan-per-city (both models passed it with no plan). Their results from
before then do not carry over. The rules the group now follows:

- **Must-ask tasks need a fact that is in no file and cannot be guessed** (a
  name, a rate, a preference). A guess gives a wrong file, so passing means
  the model asked.
- **Two guards fail on a question that was not needed**: p1-resolved-in-file
  (the file settles it) and p1-simple-stays-simple (also fails on a plan). A
  change that makes the model ask or plan on everything shows up there.
- **A skipped question must not become an invention** (p1-skip-no-invent),
  judged on the file, not the reply's wording.
- **Planning tasks are long, or contain a step that cannot be done**, so a plan
  and the completion check have something to do. p1-five-steps,
  p1-plan-eight-deliverables and p1-plan-missing-input can all pass without a
  plan; what `--plan off` against `--plan full` shows is whether it helps.

**Revised again on 2026-11-12**, after the first runs of the set (results in
`docs/notes/agent-bench-results.md`), whose Phase 1 rows are void:

- **Answers are keyed by topic** (`"name"`, `"where"`, `"discount"`...).
  A catch-all `""` answered every question with the same fact: asked where to
  save, the 35B got "Priya Natarajan". Keep `""` for a task whose every
  possible question has the one answer (p1-stop-and-report only).
- **A task that saves a file attaches one**, so the attachment note tells the
  model where files go. The two note tasks had none, and two models spent 30
  turns looking for somewhere to save.
- **Nothing the user could be called is guessable**: the bench account is
  named bench, so the note tasks ask for "my full name".
- **Checks read every assistant message**, as the chat shows them, where the
  task is about saying something (a missing file).
- **The bench removes what a run saves with memory_save**, and deletes
  conversations an earlier, stopped bench left behind. Memories already on
  the account are warned about, not deleted: clear them by hand.

To run only this group: `--tasks "scripts/agent-bench/tasks/p1-*.json"`.

A model often asks in its reply text instead of calling ask_user. By default
that ends the run, and the must-ask tasks fail. `--text-asks answer` has the
bench answer such a question from the task's `answers`, as a chat user would,
and the checks count it as asking. The summary reports tool asks and text asks
separately, so the two can be compared.

**Tool retrieval (second pass, 2026-11-13).** A task may name `expectTools`:
the tools a sensible first call would use. It is never a pass criterion. The
summary reports how many runs' first call (ask_user and update_plan aside) was
one of them, which is how "the File System tools came first on attachment
tasks" is counted. The bench also asks the gateway which tools it sent on
every turn and records llama-server's `cache_n` and `prompt_ms`, so each task
row shows retrieval on or off, the tools on the first turn, the distinct tool
sets, the cache-miss turns and the prefill time. `--retrieval off` runs a task
with every post-ban tool (the request opts out, so Nest's setting can stay as
it is). Neither works with `--runtime`, where the daemon makes the requests.

`fixtures/` is byte-stable (`.gitattributes`: `-text`). The data files were
generated with a fixed seed. Checks compute their expected answers from these
files, so edit a fixture and its check follows.
