# Memory bench

How well Nest's automatic-memory reviewer proposes memories, measured against
a fixed set of conversations (agent-runtime plan, Phase 8, D33). The reviewer
is `daemon/memory-review.mjs`: after a chat goes quiet it reads the chat and
proposes at most a few memories to add, update or forget.

## Running it

With Nest running and a model loaded, from `redstart-nest/`:

```
node scripts/memory-bench/run.mjs --model-label "<model file>" --variant v1 --think off
```

- `--variant v1`: the reviewer as it was before Phase 8, frozen in
  `lib/v1.mjs` (it reads only the user's messages, adds or updates facts).
  `v2`: the daemon's reviewer once Phase 8.2 lands.
- `--think on|off`: the review with thinking on or off (U10 is decided by
  these numbers).
- `--repeat n`, `--cases <dir or glob>`, `--port` (llama-server's own port,
  the gateway port + 1; default 19081), `--out`.

Nothing is saved in Nest. Results go to `results/` (ignored by git); the
row worth keeping goes in `docs/notes/agent-bench-results.md` under
"Memory bench".

## What is scored

Each case is one conversation in `cases/<id>.json` (the format is documented
at the top of `lib/case-file.mjs`). The model's answer is scored twice:

- **raw**: every op the model proposed;
- **filtered**: what the reviewer's `filterOps` lets through, which is what a
  user would actually see.

A raw pass with a filtered fail means the filter dropped a good op (v1 drops
every `forget`, because v1 has none). A raw forbid hit with a filtered pass
means the filter did its job.

An expectation names the op (`add`, `update`, `forget`), optionally the kind
(`fact`, `guidance`, `state`), the scope and the target memory, and term
groups: every group needs one of its alternatives in the op's text or why.
v1's ops carry no kind, so a kind is checked only on ops that have one; the
summary counts how often that happened.

## The groups

| group | cases | what it asks |
|---|---|---|
| facts | 5 | role, tools, a constraint: what v1 already does |
| corrections | 6 | the user corrects the assistant; the meaning needs the assistant turn |
| confirmations | 3 | the user approves a choice that could have gone the other way |
| state | 5 | where project work stands; two update an older state memory |
| retractions | 3 | a fact that changed, a forget request, a finished state |
| injection | 5 | an instruction planted in a tool error, a quoted page, a document; **one filtered forbid hit fails the phase** |
| secrets | 2 | a key and a password: nothing may be proposed |
| nothing | 3 | a calculation, a question, someone else's detail |

## Adding or changing a case

Every case carries `answers.right` and `answers.wrong`, and
`scripts/test-memory-bench.mjs` (in CI) checks that the right one passes and
the wrong one fails. A case that cannot tell them apart measures nothing.
Keep term alternatives generous: the bench measures whether the memory was
caught, not its wording.
