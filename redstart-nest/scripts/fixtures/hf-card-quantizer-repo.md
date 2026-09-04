---
base_model: Qwen/Qwen3-30B-A3B
language:
- en
library_name: transformers
license_link: https://huggingface.co/Qwen/Qwen3-30B-A3B/blob/main/LICENSE
license: apache-2.0
tags:
- qwen3
- qwen
- unsloth
- transformers
---
<div>
  <p style="margin-bottom: 0; margin-top: 0;">
    <strong>See <a href="https://huggingface.co/collections/unsloth/qwen3-680edabfb790c8c34a242f95">our collection</a> for all versions of Qwen3 including GGUF, 4-bit & 16-bit formats.</strong>
  </p>
  <p style="margin-bottom: 0;">
    <em>Learn to run Qwen3 correctly - <a href="https://docs.unsloth.ai/basics/qwen3-how-to-run-and-fine-tune">Read our Guide</a>.</em>
  </p>
<p style="margin-top: 0;margin-bottom: 0;">
    <em><a href="https://docs.unsloth.ai/basics/unsloth-dynamic-v2.0-gguf">Unsloth Dynamic 2.0</a> achieves superior accuracy & outperforms other leading quants.</em>
  </p>
  <div style="display: flex; gap: 5px; align-items: center; ">
    <a href="https://github.com/unslothai/unsloth/">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/unsloth%20new%20logo.png" width="133">
    </a>
    <a href="https://discord.gg/unsloth">
      <img src="https://github.com/unslothai/unsloth/raw/main/images/Discord%20button.png" width="173">
    </a>
    <a href="https://docs.unsloth.ai/basics/qwen3-how-to-run-and-fine-tune">
      <img src="https://raw.githubusercontent.com/unslothai/unsloth/refs/heads/main/images/documentation%20green%20button.png" width="143">
    </a>
  </div>
<h1 style="margin-top: 0rem;">✨ Run & Fine-tune Qwen3 with Unsloth!</h1>
</div>

- Fine-tune Qwen3 (14B) for free using our Google [Colab notebook here](https://docs.unsloth.ai/get-started/unsloth-notebooks)!
- Read our Blog about Qwen3 support: [unsloth.ai/blog/qwen3](https://unsloth.ai/blog/qwen3)
- View the rest of our notebooks in our [docs here](https://docs.unsloth.ai/get-started/unsloth-notebooks).
- Run & export your fine-tuned model to Ollama, llama.cpp or HF.

| Unsloth supports          |    Free Notebooks                                                                                           | Performance | Memory use |
|-----------------|--------------------------------------------------------------------------------------------------------------------------|-------------|----------|
| **Qwen3 (14B)**      | [▶️ Start on Colab](https://docs.unsloth.ai/get-started/unsloth-notebooks)               | 3x faster | 70% less |
| **GRPO with Qwen3 (8B)**      | [▶️ Start on Colab](https://docs.unsloth.ai/get-started/unsloth-notebooks)               | 3x faster | 80% less |
| **Llama-3.2 (3B)**      | [▶️ Start on Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(1B_and_3B)-Conversational.ipynb)               | 2.4x faster | 58% less |
| **Llama-3.2 (11B vision)**      | [▶️ Start on Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Llama3.2_(11B)-Vision.ipynb)               | 2x faster | 60% less |
| **Qwen2.5 (7B)**      | [▶️ Start on Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Qwen2.5_(7B)-Alpaca.ipynb)               | 2x faster | 60% less |
| **Phi-4 (14B)** | [▶️ Start on Colab](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/Phi_4-Conversational.ipynb)               | 2x faster | 50% less |

# To Switch Between Thinking and Non-Thinking
If you are using llama.cpp, Ollama, Open WebUI etc., you can add `/think` and `/no_think` to user prompts or system messages to switch the model's thinking mode from turn to turn. The model will follow the most recent instruction in multi-turn conversations.

Here is an example of multi-turn conversation:

```
> Who are you /no_think

<think>
