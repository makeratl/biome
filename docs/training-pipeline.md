# Biome Move-Policy Distillation — Training Pipeline

A portable, reproduce-from-scratch spec for the Biome Training Lab: how gameplay
becomes a fine-tuning dataset, how a local LLM is LoRA-distilled to play Biome,
and how the result is validated. Written to be ported to a new environment for
research — the *method* is the point; the in-repo plumbing is documented at the
end for reference but is not required to reproduce the idea.

> **Status note.** Everything below has been run end-to-end on the reference box
> (RTX 5090). A reference run is cited throughout with real numbers.

---

## 0. TL;DR

1. Every AI turn in Biome is a clean `(prompt → move-JSON)` pair. The prompt is
   built **deterministically** from the visible board; the move is the model's
   verbatim JSON answer.
2. The **simulation is a free, objective judge**: it scores each move with two
   engine-computed signals (did the player's score lead grow? did its food-web
   get healthier?). Those signals + match outcome assign a **medal** (gold /
   silver / bronze).
3. **Teacher = the reigning ELO champion.** Its winning, medal-validated moves
   become the gold dataset. **Student = any base model** — deliberately
   including weak ones (the headline experiment: distill a strong policy into a
   small/poor model and watch it climb the ladder).
4. Train a **LoRA** (Unsloth) on the assistant completion only, merge, export
   **GGUF**, register with **`ollama create`**, and **evaluate by ELO** — the
   ladder is the eval.

The loop:

```
GENERATE (self-play, any AI match)
   → CAPTURE (turn + round + outcome logs)
      → REWARD/MEDAL (engine signals → gold/silver/bronze)
         → CURATE (optional manual ★/✕)
            → EXPORT (tiered SFT dataset.jsonl)
               → TRAIN (LoRA, completions-only)
                  → MERGE → GGUF → ollama create
                     → EVALUATE (gauntlet vs base, ELO on the ladder)
                        ↑__________ champion improves, better data ___________|
```

---

## 1. Why this works (the design thesis)

Three properties make Biome unusually clean for imitation/distillation:

- **Deterministic prompt.** The same board state always yields the same prompt
  (`buildTurnPrompt`). So `(prompt, answer)` pairs are stable and de-dupable, and
  the training input exactly matches the inference input.
- **A free objective judge.** The ecosystem simulation resolves each turn and
  produces hard signals — no human labeling, no reward model. "Was this move
  good?" is answered by the engine, not a vibe.
- **A real eval.** The ELO ladder (matches between models) is the downstream
  metric. You don't have to trust training loss; you watch a tuned student win
  or lose against its own base.

This sidesteps the two usual distillation headaches: dataset labeling cost and
eval validity.

### Fog-of-war invariant (correctness, not just UX)

The turn record stores the **fog-honest** prompt — i.e. exactly what the model
could see. Full-board / opponent-current-round information lives only in the
*round/meta* records used for scoring, **never** in the training input. Preserve
this when porting: training on leaked full-board state would teach a policy that
can't run at inference.

---

## 2. Data pipeline

### 2.1 Capture (passive)

Any AI match logs three append-only JSONL streams, joined by a client-minted
`match_uid`:

| Stream | One row per | Holds |
|---|---|---|
| `turns.jsonl`   | model turn  | the verbatim prompt + the model's raw answer + parsed actions + execution result |
| `rounds.jsonl`  | round       | census, scores, **trophic** state, and the per-player quality **signals** |
| `outcomes.jsonl`| match       | winner, final scores, seed, map config (stamped at match end) |

**Turn record (the training-relevant fields):**

```jsonc
{
  "schema": 1,
  "match_uid": "m_<uuid>",      // joins turn ↔ round ↔ outcome
  "turn_uid": "<uuid>",         // unique; manual curation key
  "seed": 38872,                // map seed (data-diversity tracking)
  "model": "qwen2.5:14b",       // who played this turn (the teacher candidate)
  "player": 2, "round": 4, "total_rounds": 10,
  "prompt": {
    "system": "<~1.5k-token rules doc>",   // identical at train + inference
    "user":   "<fog-honest board state + candidate cells>"
  },
  "response_raw": { "content": "{\"reasoning\":\"…\",\"actions\":[…],\"banter\":\"…\"}" },
  "fallback_reason": null       // non-null ⇒ no usable answer ⇒ never a medal
}
```

### 2.2 Reward → medal (the gate)

For each turn the engine provides two boolean **signals** (captured live into
`rounds.jsonl`, so the in-game tally and the dataset can never drift):

- `marginGrew` — the player's score lead (me − opponent) grew this round.
- `trophicImproved` — healthier food-web pyramid: `health↑ ∧ risk≤prev ∧ state≠collapsing`.

With `real` = a genuine (non-fallback) answer as the prerequisite:

```
medal = None              if not real
        'gold'            if 2 signals AND its side won the match
        'silver'          if 2 signals AND its side lost
        'bronze'          if exactly 1 signal
        None              if 0 signals
```

A secondary continuous `label_score ∈ [0,1]` (weights `w_won=0.45,
w_margin=0.35, w_trophic=0.20`, `margin_scale=1000`) is kept only for the curate
UI's sort bar — **it does not gate training**; the medal does.

> **Single source of truth.** This rule lives once in the engine (`js/medal.js`)
> and is mirrored in the exporter (`traj.py:classify_medal`). If you port it,
> keep one canonical definition.

### 2.3 Tiers

The export draws from a **tier** (named for the dataset you're building):

| Tier | Medals included | Character |
|---|---|---|
| **champion**  | gold                  | purest signal (winning + both quality signals) |
| **contender** | gold + silver         | adds strong moves from the *losing* side — broader, noisier |
| **player**    | gold + silver + bronze| highest volume, lowest purity — experimental |

Manual `★` (force-include) and `✕` (force-exclude) overrides win over the medal
in all tiers.

### 2.4 Exported SFT row

Provider-neutral chat format, one JSON object per line in `dataset.jsonl`:

```jsonc
{
  "messages": [
    { "role": "system",    "content": "<rules>" },
    { "role": "user",      "content": "<fog-honest board state>" },
    { "role": "assistant", "content": "{\"reasoning\":\"…\",\"actions\":[…],\"banter\":\"…\"}" }
  ],
  "meta": {
    "turn_uid": "…", "match_uid": "…", "seed": 38872,
    "teacher_model": "qwen2.5:14b",   // who generated this gold move
    "round": 4, "won_match": true,
    "medal": "gold", "label_score": 0.87, "label_source": "auto",
    "trophic_state": "balanced", "map_strategy": "mediated"
  }
}
```

Only `messages` is consumed by training; `meta` is for provenance/analysis.

### 2.5 Reference dataset (champion tier, as run)

- **857 gold rows** · **341 distinct map seeds** · **37 distinct teacher models**.
- Gold ⊆ contender (1,488) ⊆ player (4,334) on the same capture set.
- Diversity matters more than raw count: many seeds + a varied, *reliable*
  teacher pool generalizes better than a flood from one flaky model (flaky →
  mostly fallback → no medals).

---

## 3. Training environment

### 3.1 Hardware / driver (reference box)

- **GPU:** NVIDIA RTX 5090, 32 GB (Blackwell, compute capability **sm_120**).
- **CUDA:** 12.8-capable driver. Blackwell needs a recent toolchain — PyTorch on
  **cu128**. (On older/other GPUs, use the matching `cuXXX` torch build.)
- **Python:** 3.12.

### 3.2 Pinned stack (verified working together)

```
torch==2.10.0+cu128       # the load-bearing, hard-won piece on Blackwell
unsloth==2026.6.7
unsloth_zoo==2026.6.5
trl==0.24.0
datasets==4.3.0
transformers==5.5.0
peft==0.19.1
accelerate==1.14.0
bitsandbytes==0.49.2
xformers==0.0.35
triton==3.6.0
```

> Record the exact torch build that works for your GPU once and pin it. On
> Blackwell the torch/CUDA layer is the fragile part; everything above it is
> ordinary.

### 3.3 venv recipe (PEP 668 externally-managed systems)

Debian/Ubuntu mark the system Python "externally managed" — a system-wide
`pip install` is refused. Use an **isolated venv**. If a working `torch` already
exists in the user site (e.g. installed via `pip --user`), **reuse it** rather
than rebuilding the painful CUDA stack:

```bash
# 1) isolated venv
python3 -m venv .venv-train

# 2) (optional) link to an EXISTING cu128 torch in the user site so it isn't rebuilt
echo "$(python3 -c 'import site; print(site.getusersitepackages())')" \
  > .venv-train/lib/python3.12/site-packages/usersite.pth

# 3) verify torch is visible + CUDA is live inside the venv
.venv-train/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"

# 4) add the training libs (torch is seen as satisfied → not reinstalled)
.venv-train/bin/python -m pip install unsloth trl datasets
```

In a **truly fresh** environment (no preexisting torch), skip step 2 and instead
install the GPU-matched torch first:

```bash
.venv-train/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-train/bin/pip install unsloth trl datasets
```

> A `pip install --dry-run unsloth trl datasets` is worth running first — confirm
> torch is **not** in the "Would install" list (i.e. it won't clobber your build).

---

## 4. Training recipe (LoRA, completions-only)

One command per generation. `--base` is a **HuggingFace id** (the student
weights), not an ollama tag; `--tag` names the output `biome-<tag>`.

```bash
.venv-train/bin/python tools/train_biome.py \
    --dataset training-data/dataset.jsonl \
    --base    unsloth/Qwen2.5-7B-Instruct \
    --tag     qwen2.5-7b-v1
```

### 4.1 Hyperparameters (and why)

| Knob | Value | Rationale |
|---|---|---|
| LoRA `r` / `alpha` | 16 / 32 | standard 2× alpha\:r; enough capacity for a narrow policy |
| `lora_dropout` / `bias` | 0 / none | Unsloth fast path |
| target modules | `q,k,v,o,gate,up,down_proj` | full attention + MLP adaptation |
| `max_seq_length` | 4096 | prompts run ~2k tokens; headroom for the rules doc |
| batch / grad-accum | 2 / 4 | effective batch 8 |
| epochs | 2.0 | enough to imitate; more risks overfitting a small set |
| lr / scheduler | 2e-4 / linear, 5 warmup | typical LoRA SFT |
| optimizer | `adamw_8bit`, wd 0.01 | memory-light |
| quant (export) | `q4_k_m` | small, fast GGUF for ollama serving |
| `--load-4bit` | off (on for ~32B) | QLoRA only needed for the big students |

### 4.2 Completions-only masking — **the load-bearing detail**

Train on the **assistant move only**; mask the (long) system+user prompt from the
loss so the model learns to *answer*, not to recite the rules it's always given:

```python
train_on_responses_only(
    trainer,
    instruction_part='<|im_start|>user\n',
    response_part='<|im_start|>assistant\n',
)
```

> ⚠️ **Chat-template coupling.** These markers are **ChatML** (`<|im_start|>`),
> which the **Qwen2.5** family uses. Llama-3 (`<|start_header_id|>`), Gemma, Phi,
> etc. use *different* turn markers — train them with these markers and the loss
> masks the wrong span (or nothing). **Porting to a non-Qwen base requires
> changing these two strings to that family's markers.** This is the single most
> common silent failure.

### 4.3 Reference run (0.5B student, champion tier)

- Student `unsloth/Qwen2.5-0.5B-Instruct`, 857 rows, 2 epochs → **214 steps**.
- `train_runtime ≈ 184 s`, ~9.2 samples/s, **final train_loss 1.527**.
- Output GGUF `Q4_K_M` ≈ **397 MB**.
- Total wall-clock incl. first-time llama.cpp install + GGUF convert ≈ a few min.

---

## 5. Export & registration (GGUF → ollama)

`train_biome.py` does: merge LoRA → 16-bit → convert to GGUF → write a Modelfile.

### 5.1 GGUF output-path gotcha (important)

Unsloth **≥ 2026.x** writes the GGUF **and** a correct Ollama `Modelfile` into a
**sibling** directory `"<run_dir>_gguf/"`, named after the *base* model — **not**
into `run_dir`:

```
training-data/runs/biome-<tag>/         # merged 16-bit weights, checkpoints, logs
training-data/runs/biome-<tag>_gguf/    # ← the GGUF + the REAL Modelfile live HERE
    Qwen2.5-0.5B-Instruct.Q4_K_M.gguf
    Modelfile                           # FROM <gguf> + full ChatML TEMPLATE + stops
```

(`train_biome.py`'s own `run_dir/Modelfile` may be a `FROM ./None` stub from an
older layout assumption — ignore it; use the `_gguf/Modelfile`.) Any automation
that registers the model must look in `*_gguf/` (fall back to `run_dir` for older
Unsloth).

### 5.2 Register on the ladder

```bash
cd training-data/runs/biome-<tag>_gguf
ollama create biome-<tag> -f Modelfile
ollama list | grep biome-<tag>          # now serveable / selectable
```

The generated Modelfile carries the correct ChatML template and stop tokens. Note
Unsloth's default `PARAMETER temperature 1.5` — high for a deterministic policy;
override per-call at inference (or edit the Modelfile) if the model plays
erratically.

---

## 6. Evaluation — the eval is the ladder

Distillation "worked" iff the tuned student beats its **own base** and climbs:

1. Run a gauntlet of `biome-<tag>` vs the stock base over many matches/seeds.
2. Each match posts a result; ELO updates incrementally (K=32, base 1000).
3. **Pass:** tuned beats stock > 50% and its ELO rises above the baseline.

This is the feedback that closes the loop: a student that climbs past the current
champion *becomes* the next teacher, and its verified moves seed the next dataset.

---

## 7. Reproducing in a fresh environment (minimal)

You need: (a) a dataset of `{messages:[system,user,assistant]}` rows, (b) the
venv, (c) the trainer, (d) ollama.

```bash
# 0) GPU + driver (CUDA-capable; cu128 for Blackwell)

# 1) venv + stack  (see §3.3 for the externally-managed / torch-reuse variants)
python3 -m venv .venv-train
.venv-train/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-train/bin/pip install unsloth trl datasets

# 2) dataset: produce dataset.jsonl of completions-only chat rows (see §2.4)

# 3) train (Qwen2.5 base → ChatML markers already correct)
.venv-train/bin/python tools/train_biome.py \
    --dataset dataset.jsonl --base unsloth/Qwen2.5-7B-Instruct --tag exp-v1

# 4) register (note the _gguf sibling dir — §5.1)
cd training-data/runs/biome-exp-v1_gguf && ollama create biome-exp-v1 -f Modelfile

# 5) evaluate: gauntlet biome-exp-v1 vs Qwen2.5-7B-Instruct; watch win-rate/ELO
```

Non-Qwen base? Change the two markers in §4.2 first.

---

## 8. Gotchas & non-obvious decisions (field notes)

- **ChatML markers are base-family-specific.** §4.2 — the top porting hazard.
- **GGUF lands in `*_gguf/`, not `run_dir`.** §5.1 — auto-registration must look there.
- **PEP 668.** System Python refuses installs; use a venv. Reusing an existing
  user-site torch via a `.pth` avoids rebuilding the CUDA stack (§3.3).
- **Dep-probe cost.** Checking "is unsloth installed?" by *importing* it runs the
  full torch/CUDA patch (seconds). Use `importlib.util.find_spec` to probe
  without importing.
- **GPU exclusivity.** A training run claims the whole card; an inference server
  (e.g. ollama serving matches) can't share it. Serialize them.
- **Tag prefixing.** The output is `biome-<tag>`; don't include `biome-` in the
  tag or you get `biome-biome-…`.
- **Default temperature.** Unsloth's Modelfile defaults to `temperature 1.5`;
  override for a policy model.
- **Reward ≠ gate.** The continuous `label_score` is UI-only; the **medal** is
  what selects training rows.
- **Diversity > volume.** Many seeds + reliable teachers beat a flood from one model.
- **Replay caveat.** Terrain is seeded but the simulation uses unseeded RNG, so a
  seed reproduces the *board*, not bit-for-bit biology — blocks a pure
  engine-as-judge replay oracle until sim RNG is seeded.

---

## 9. Reference: in-repo implementation map

For continuing this *inside* Biome (not needed to port the method):

| Concern | Where |
|---|---|
| Capture (client) | `js/capture.js` → `POST /trajectory/turn`,`/round`; outcome stamped by `/tournament-result` |
| Reward / medal / tiered export | `traj.py` (`classify_medal`, `score_turn`, `build_dataset`, `TIERS`, `dataset_counts_by_tier`, `write_dataset`) |
| Shared engine eval | `js/trophic.js` (`trophicRead`) — same source feeds health UI, AI prompt, and reward |
| Trainer (offline GPU) | `tools/train_biome.py` (Unsloth LoRA → merge → GGUF → Modelfile) |
| One-click in-tool workflow | Training Lab **Train tab** (`lab/train.html` / `lab/train.js`) |
| Managed run executor + endpoints | `server.py`: `_run_training`, `/training/{preflight,start,status,cancel,runs}`; GPU-exclusive vs the tournament scheduler; ledger at `training-data/runs/ledger.json` |
| Training Python resolution | `BIOME_TRAIN_PYTHON` env → repo `.venv-train/bin/python` → server's python |
| Capture/dataset storage | `training-data/` (gitignored): `turns/rounds/outcomes.jsonl`, `dataset.jsonl`, `runs/biome-<tag>/` |

---

*Generated for porting to a research environment. The reference run, version
pins, and gotchas reflect an actual end-to-end execution on the RTX 5090 box.*
