# Agent benchmark tasks

The 24 tasks of agent-runtime plan Phase 0.3, plus five Phase 1 tasks added
once ask_user and update_plan existed (2026-11-11): 29 in five groups. Run them with
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
| p1-ambiguous-units | phase 1 | ask_user | asked which unit, then converted |
| p1-which-draft | phase 1 | ask_user | asked which draft, fixed only that one |
| p1-five-steps | phase 1 | update_plan helps | all five steps, including the easy-to-forget fourth |
| p1-stop-and-report | phase 1 | — | did not guess SKU-9's price, and said so |
| p1-answer-steers | phase 1 | ask_user | asked the order, then sorted by the answer (age, oldest first), not by name |
| p1-pick-vendors | phase 1 | ask_user | asked which contracts, then only Kestrel (60 days) and Osprey (30), no Alder |
| p1-assume-on-skip | phase 1 | — (a question is skipped) | converted anyway, either direction, and said which unit it assumed |
| p1-plan-per-city | phase 1 | update_plan helps | four city files, cities.csv, and the average age (50.2) |
| p1-simple-stays-simple | phase 1 | — (a guard) | 11,123 for North, with no ask_user and no update_plan |
| p4-run-tests | phase 4 | run_command | names the failing test |
| p4-fix-test | phase 4 | run_command helps | math.mjs fixed, the test untouched |
| p4-git-log | phase 4 | run_command | the third most recent commit's author and message |
| p4-exit-code | phase 4 | run_command | reports failure, exit code 3, and why |

Phase 1 and Phase 4 tasks are expected to fail until those phases land; that
is how a phase shows it helped. Of the five added later, p1-assume-on-skip,
p1-plan-per-city and p1-simple-stays-simple can pass with no Phase 1 tool at
all. The last is the guard the other way: it fails if the tools are used
where they add nothing, so a Phase 1 change that makes the model ask or plan
on everything shows up as a regression there (and in the summary's
`ask_user: ... unanswered` and `update_plan` counts across the 20 tasks that
never need either). Three can pass early, and the results say so
when they do: p1-five-steps and p1-stop-and-report are solvable today, and
p4-fix-test can be done by editing the file with run_python.

`fixtures/` is byte-stable (`.gitattributes`: `-text`). The data files were
generated with a fixed seed. Checks compute their expected answers from these
files, so edit a fixture and its check follows.
