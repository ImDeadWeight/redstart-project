# Chat template overrides

Drop-in Jinja chat templates to pass to llama-server via `--chat-template-file`
(wired through a profile's `chatTemplateFile` config field in `buildArgs`).

`--jinja` uses the template **embedded in the GGUF** by default. Some models ship
a template that renders tool calls with constructs Python's Jinja allows but
llama.cpp's C++ Jinja engine (minja) does not — when that happens, llama-server
errors on the tool-call render and falls back to emitting the model's call as
plain assistant `content` (a raw JSON blob) instead of a structured `tool_calls`
field. Overriding the template with a minja-compatible one fixes it.

## `qwen3.6-tools.jinja`

For the **Qwen3.6 / Qwen3.5 35B-A3B** family, whose official template breaks tool
calling under llama.cpp: it iterates tool-call arguments with the `| items`
*filter* and uses other Python-only constructs that minja rejects.

- **Source:** [froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
  (`chat_template.jinja`), a faithful fix of the official Qwen 3.5/3.6 template
  tested on llama.cpp / LM Studio / MLX / vLLM. Fetched verbatim.
- **What it fixes:** replaces the `| items` filter with the `.items()` method
  (minja-supported), keeps the native `<tool_call><function=…><parameter=…>`
  format the model was trained on (so llama.cpp's parser recognizes it), and
  guards every optional template variable with an `is defined` default.

### Use it
Point a profile at it. Either set `chatTemplateFile` in the profile config
(handles paths with spaces), or add to the profile's **Additional Arguments**:

```
--chat-template-file <abs-path>/redstart-nest/chat-templates/qwen3.6-tools.jinja
```

Then fully restart the app (main-process arg changes need a real restart, not
HMR) and launch the server. Confirm success: a tool request returns a populated
`tool_calls` field with empty `content`, not a ```json block in the message.

> If llama-server logs a template **render error** at startup, the model's args
> hit a construct minja still rejects; the `barubary` / `allanchan339` fixed
> templates are alternatives with different trade-offs.
