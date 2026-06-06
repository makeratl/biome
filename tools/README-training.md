# Biome Training Lab — training the student

The Training Lab turns gameplay into data and fine-tunes a local model to play
Biome. The loop:

```
 GENERATE ──► CURATE ──► EXPORT ──► TRAIN (this dir) ──► ollama create ──► EVALUATE
 (self-play)  (gold)    dataset.jsonl   LoRA on 5090     new ladder model   gauntlet
     ▲                                                                          │
     └──────────────────── champion improves → better data ────────────────────┘
```

Generate / curate / export happen in the browser at **`/lab/train.html`**. This
folder is the one offline, GPU step: `train_biome.py`.

## The headline experiment

Teacher ≠ student. The **teacher** is whoever leads the ELO ladder (its winning,
engine-validated moves become the gold data). The **student** is any base model
you point `--base` at — *including a deliberately weak one*. Distilling the
champion's verified-good play into a small/poor model and watching it climb the
ladder is the whole point. Start with a 7B student; once the loop works, try
elevating a weaker base.

## One-time environment (RTX 5090 / Blackwell, sm_120)

⚠️ **This is the highest-risk setup step.** Stable PyTorch wheels predate the
5090's `sm_120`; you need a CUDA 12.8+ nightly. Use a fresh venv:

```bash
python3 -m venv ~/.venvs/biome-train && source ~/.venvs/biome-train/bin/activate
pip install --upgrade pip

# PyTorch nightly built for CUDA 12.8 (sm_120 / Blackwell). Pin once it works.
pip install --pre torch torchvision --index-url https://download.pytorch.org/whl/nightly/cu128

# Unsloth (LoRA), TRL, datasets. Install AFTER torch so it builds against it.
pip install "unsloth[cu128] @ git+https://github.com/unslothai/unsloth.git"
pip install trl datasets

# Sanity: must print True and the 5090.
python3 -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Notes:
- `bitsandbytes`, `triton`, and `xformers` must each be sm_120-capable builds, or
  4-bit/QLoRA (`--load-4bit`) will fail at model load. If a `--load-4bit` run
  errors on load, retry without it first (a 7-14B LoRA fits 32 GB in 16-bit).
- If nightly torch breaks Unsloth, pin to the last known-good pair and record it
  here. Treat versions as load-bearing.

## Train

```bash
# 0. Validate the exported dataset without touching the GPU:
python3 tools/train_biome.py --dry-run

# 1. LoRA-tune a 7B student (fits 32 GB comfortably in 16-bit):
python3 tools/train_biome.py --base unsloth/Qwen2.5-7B-Instruct --tag qwen2.5-7b-v1

# Bigger students:
#   14B LoRA:  --base unsloth/Qwen2.5-14B-Instruct
#   32B QLoRA: --base unsloth/Qwen2.5-32B-Instruct --load-4bit
```

What it does: loads `training-data/dataset.jsonl`, applies the base model's chat
template, LoRA-fine-tunes **on the assistant move only** (the prompt is masked
from the loss), merges, exports a `q4_k_m` **GGUF**, and writes a `Modelfile`.

> The response-masking markers in `train_biome.py` are Qwen/Llama `<|im_start|>`
> turn headers. For a base with a different chat template, adjust
> `instruction_part` / `response_part` accordingly.

## Enter it on the ladder + evaluate

```bash
cd training-data/runs/biome-qwen2.5-7b-v1
ollama create biome-qwen2.5-7b-v1 -f Modelfile
```

It now appears in the model list (via the server's Ollama proxy). Run a
**challenger gauntlet** — the student vs its own stock base over many matches:

```bash
# from the project root, with the dev server reachable:
BIOME_GEN=watch BIOME_P1="biome-qwen2.5-7b-v1" BIOME_P2="qwen2.5:7b-instruct" \
  BIOME_MATCHES=40 BIOME_TIMEOUT=7200 \
  node .claude/skills/run-biome/dev-session.mjs generate
```

Each match posts to the ELO backend, so win-rate, head-to-head, and rating show
up on **`/dashboard.html`**. **Pass:** the tuned student beats its stock base
above 50% and climbs above it. Then it can become the next champion/teacher and
the loop tightens.

## Tuning knobs

- **Reward / what counts as gold:** `traj.py` → `REWARD` (weights + threshold).
  Stricter threshold = fewer, higher-quality rows.
- **Data diversity:** generate over a varied, *reliable* model pool and many
  seeds; a flaky model produces mostly fallback (non-gold) turns and wastes time.
- **Student size:** bigger isn't always better for a first win — a clean 7B
  result proves the pipeline faster than a finicky 32B run.
