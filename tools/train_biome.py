#!/usr/bin/env python3
"""LoRA-fine-tune a local LLM to play Biome from a captured-gameplay dataset.

Pipeline:  training-data/dataset.jsonl  →  LoRA SFT (Unsloth)  →  merged GGUF
           →  a Modelfile + the `ollama create` command to enter it on the ladder.

This is the offline half of the Training Lab — run it on a CUDA box (your 5090).
It does NOT run as part of the game/server. See tools/README-training.md for the
environment setup (Blackwell / sm_120 needs PyTorch nightly on CUDA 12.8+).

Quick start (after the env is set up):
    python3 tools/train_biome.py \
        --base unsloth/Qwen2.5-7B-Instruct \
        --tag  qwen2.5-7b-c1

The dataset rows are provider-neutral chat:
    {"messages":[{role:system},{role:user},{role:assistant}], "meta":{...}}
We train on the ASSISTANT completion only (the move JSON) — the long system+user
prompt is masked from the loss, so the model learns to *answer*, not to recite
the rules it's already given at inference.

MULTI-FAMILY: the loss-masking markers + stop token are DERIVED from the base
tokenizer's own chat template (the same one the dataset is rendered with), so any
ChatML/Llama/Gemma/Phi family works without hardcoding. Every run is gated by a
masking assertion that proves only the assistant move-JSON is supervised — the
#1 silent failure when a marker is wrong. Use --check-masking for a fast,
GPU-free go/no-go on a new family, and --family to force markers if needed.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATASET = os.path.join(ROOT, 'training-data', 'dataset.jsonl')

# Fallback / override marker table (handoff §2). NEVER the primary path —
# auto-derivation from the tokenizer is default; this only fires with --family.
FAMILY_OVERRIDES = {
    'qwen':    dict(instruction_part='<|im_start|>user\n', response_part='<|im_start|>assistant\n', stop='<|im_end|>'),
    'llama3':  dict(instruction_part='<|start_header_id|>user<|end_header_id|>\n\n',
                    response_part='<|start_header_id|>assistant<|end_header_id|>\n\n', stop='<|eot_id|>'),
    'gemma':   dict(instruction_part='<start_of_turn>user\n', response_part='<start_of_turn>model\n', stop='<end_of_turn>'),
    'phi':     dict(instruction_part='<|user|>\n', response_part='<|assistant|>\n', stop='<|end|>'),
    'mistral': dict(instruction_part='[INST]', response_part='[/INST]', stop='</s>'),
}
# base-id substring → FAMILY_OVERRIDES key (also used for the family_label in logs)
_FAMILY_HINTS = [('qwen', 'qwen'), ('llama', 'llama3'), ('gemma', 'gemma'),
                 ('phi', 'phi'), ('mistral', 'mistral')]


# ── offline resilience ──────────────────────────────────────────────────────
# Training kept dying when HuggingFace was unreachable (DNS blips, a 120s telemetry
# timeout) even though the base model was already fully cached. When the base is
# cached we set HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE so Unsloth skips every Hub and
# telemetry call (loader.py honors these live from os.environ; get_statistics()
# returns early). This MUST happen before unsloth/transformers/huggingface_hub are
# imported — they're deferred into main(), and the probe below is import-free, so
# nothing pins the offline constant before we set it. Everything here is defensive:
# any failure falls through to normal online behavior.

def _scan_opt(argv, name):
    """Read `--name VALUE` or `--name=VALUE` straight from argv. The env must be set
    before argparse runs, so we can't use parse_args() for this."""
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(name + '='):
            return a.split('=', 1)[1]
    return None


def _repo_cached(repo_id):
    """Local snapshot dir if repo_id is already on disk (a local model dir, or a
    complete-enough snapshot in the HF cache), else None. Import-free + network-free
    so it can run before the heavy stack is imported."""
    if not repo_id:
        return None
    if os.path.isdir(repo_id) and os.path.exists(os.path.join(repo_id, 'config.json')):
        return repo_id
    try:
        cache = (os.environ.get('HF_HUB_CACHE')
                 or os.environ.get('HUGGINGFACE_HUB_CACHE')
                 or os.path.join(os.environ.get('HF_HOME')
                                 or os.path.expanduser('~/.cache/huggingface'), 'hub'))
        model_dir = os.path.join(cache, 'models--' + repo_id.replace('/', '--'))
        ref = os.path.join(model_dir, 'refs', 'main')
        if not os.path.exists(ref):
            return None
        with open(ref, encoding='utf-8') as f:
            rev = f.read().strip()
        snap = os.path.join(model_dir, 'snapshots', rev)
        # config.json is a symlink into blobs/ — os.path.exists follows it, so a
        # broken (missing-blob) link reads as not-cached → online refresh allowed.
        return snap if os.path.exists(os.path.join(snap, 'config.json')) else None
    except Exception:
        return None


def _bnb_4bit_candidates(base):
    b = (base or '').rstrip('/')
    return [b + '-unsloth-bnb-4bit', b + '-bnb-4bit']


def _early_offline_setup(argv):
    """Pre-scan argv, probe the HF cache, and go offline when the base is cached.
    Returns a decisions dict consumed by main()'s [plan] block."""
    info = {'auto_offline': False, 'forced_offline': False, 'base_swap': None,
            'base_swap_risky': False, 'cached_dir': None, 'note': ''}
    try:
        base = _scan_opt(argv, '--base') or 'unsloth/Qwen2.5-7B-Instruct'  # mirror parse_args default
        load_4bit = '--load-4bit' in argv
        load_8bit = '--load-8bit' in argv
        force_offline = '--offline' in argv
        no_auto = '--no-auto-offline' in argv

        cached_dir = _repo_cached(base)
        wants_4bit = load_4bit and not load_8bit
        bnb_cached = bool(wants_4bit and cached_dir is not None
                          and any(_repo_cached(c) for c in _bnb_4bit_candidates(base)))
        # 4-bit's SAFE path is Unsloth's pre-quantized -bnb-4bit repo. Quantizing a
        # full 16-bit checkpoint to 4-bit on the fly (the base_swap) produced a BROKEN
        # gemma-2 model once (train loss started ~17 vs a healthy ~1.5) — so it's a
        # forced-offline LAST RESORT only. When the -bnb-4bit variant isn't cached and
        # we're not forced offline, STAY ONLINE to download the blessed variant rather
        # than silently quantizing on the fly.
        needs_bnb_download = wants_4bit and cached_dir is not None and not bnb_cached

        if force_offline:
            go_offline = True
        elif no_auto:
            go_offline = False
        elif needs_bnb_download:
            go_offline = False  # stay online to fetch the blessed -bnb-4bit
        else:
            go_offline = cached_dir is not None

        if go_offline:
            os.environ['HF_HUB_OFFLINE'] = '1'
            os.environ['TRANSFORMERS_OFFLINE'] = '1'
            info['forced_offline'] = bool(force_offline)
            info['auto_offline'] = not force_offline
            info['cached_dir'] = cached_dir
            # base_swap only as a forced-offline last resort (network truly unavailable),
            # and flagged risky so [plan] warns the user to verify the result.
            if wants_4bit and cached_dir is not None and not bnb_cached:
                info['base_swap'] = cached_dir
                info['base_swap_risky'] = True
    except Exception as e:  # never let offline logic break a run
        info['note'] = 'offline probe skipped: ' + str(e)
    return info


_OFFLINE_INFO = _early_offline_setup(sys.argv[1:])


def parse_args():
    p = argparse.ArgumentParser(description='LoRA-tune a Biome student model.')
    p.add_argument('--dataset', default=DEFAULT_DATASET, help='dataset.jsonl from the Training Lab export')
    p.add_argument('--base', default='unsloth/Qwen2.5-7B-Instruct',
                   help='HF base model id (the STUDENT). A weak student is a fine experiment — '
                        'the champion is the teacher, distilled in via the data.')
    p.add_argument('--tag', default='qwen2.5-7b-c1', help='version tag → ollama model biome-<tag>')
    p.add_argument('--out', default=os.path.join(ROOT, 'training-data', 'runs'), help='output dir')
    p.add_argument('--epochs', type=float, default=2.0)
    p.add_argument('--lr', type=float, default=2e-4)
    p.add_argument('--lora-r', type=int, default=16)
    p.add_argument('--lora-alpha', type=int, default=32)
    p.add_argument('--max-seq', type=int, default=4096, help='prompts run ~2k tokens; 4096 leaves headroom')
    p.add_argument('--batch', type=int, default=2)
    p.add_argument('--grad-accum', type=int, default=4)
    p.add_argument('--load-4bit', action='store_true', help='QLoRA — needed for ~32B students, optional for 7-14B')
    p.add_argument('--load-8bit', action='store_true',
                   help='8-bit base — higher fidelity than 4-bit, ~2x the VRAM. Fits ~14B on 32GB; '
                        'a 32B will not (use --load-4bit there). Mutually exclusive with --load-4bit.')
    p.add_argument('--quant', default='q4_k_m', help='GGUF quantization for the exported model')
    p.add_argument('--family', choices=sorted(FAMILY_OVERRIDES), default=None,
                   help='force the chat-template family markers (default: auto-derive from the tokenizer)')
    p.add_argument('--chat-template', default=None,
                   help='last resort: install a named unsloth chat template onto the tokenizer before deriving')
    p.add_argument('--check-masking', action='store_true',
                   help='GPU-free: load only the tokenizer, derive markers, assert masking on row 0, exit')
    p.add_argument('--dry-run', action='store_true', help='validate the dataset + print the plan, then exit')
    p.add_argument('--offline', action='store_true',
                   help='force HF offline (skip all Hub/telemetry calls) even if the cache probe is '
                        'unsure — for when the model is present but the network is down')
    p.add_argument('--no-auto-offline', action='store_true',
                   help='disable the default "go offline when the base is fully cached" behavior, '
                        'e.g. to force an online re-download/refresh')
    return p.parse_args()


def load_rows(path):
    if not os.path.exists(path):
        sys.exit(f'dataset not found: {path}\nExport one from the Training Lab (Export tab) first.')
    rows, bad = [], 0
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                msgs = r['messages']
                roles = [m['role'] for m in msgs]
                assert roles == ['system', 'user', 'assistant'], f'unexpected roles {roles}'
                assert msgs[2]['content'].strip(), 'empty assistant target'
                rows.append({'messages': msgs})
            except (json.JSONDecodeError, KeyError, AssertionError):
                bad += 1
    if not rows:
        sys.exit('dataset has 0 usable rows — capture + curate more gold turns first.')
    print(f'[data] {len(rows)} rows usable, {bad} skipped, from {path}')
    return rows


# ── family / chat-template handling ─────────────────────────────────────────

def guess_family(base):
    """Map a base HF id to a FAMILY_OVERRIDES key for the log label (best-effort)."""
    b = (base or '').lower()
    for needle, key in _FAMILY_HINTS:
        if needle in b:
            return key
    return 'auto'


def template_supports_system(tokenizer):
    """Does this family's chat template accept a `system` role? Gemma raises."""
    try:
        tokenizer.apply_chat_template(
            [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'}],
            tokenize=False, add_generation_prompt=True)
        return True
    except Exception:
        return False


def normalize_messages(messages, supports_system):
    """Make a message list renderable by templates with no system role: fold the
    system rules doc into the head of the first user turn (content unchanged, so
    the fog-honest prompt is preserved). For Gemma we keep role 'assistant' — the
    template maps it to 'model' itself. No-op when the family supports system."""
    if supports_system or not messages or messages[0]['role'] != 'system':
        return messages
    sys_txt = messages[0]['content']
    rest, out, folded = messages[1:], [], False
    for m in rest:
        if not folded and m['role'] == 'user':
            out.append({'role': 'user', 'content': f'{sys_txt}\n\n{m["content"]}'})
            folded = True
        else:
            out.append(m)
    if not folded:
        out.insert(0, {'role': 'user', 'content': sys_txt})
    return out


def derive_markers(tokenizer, supports_system, override=None):
    """Derive (instruction_part, response_part, stop) from the tokenizer's OWN chat
    template — the same one the dataset is rendered with, so masking and rendering
    can never disagree. response_part is taken precisely from the add_generation_prompt
    diff (the assistant header), which is what governs single-turn masking."""
    if override:
        return override['instruction_part'], override['response_part'], override['stop']
    SYS, USR, ASST = 'ZZSYSZZ', 'ZZUSRZZ', 'ZZASSTZZ'
    base = normalize_messages([{'role': 'system', 'content': SYS},
                               {'role': 'user', 'content': USR}], supports_system)
    full = normalize_messages([{'role': 'system', 'content': SYS},
                               {'role': 'user', 'content': USR},
                               {'role': 'assistant', 'content': ASST}], supports_system)
    p_false = tokenizer.apply_chat_template(base, tokenize=False, add_generation_prompt=False)
    p_true = tokenizer.apply_chat_template(base, tokenize=False, add_generation_prompt=True)
    rendered_full = tokenizer.apply_chat_template(full, tokenize=False, add_generation_prompt=False)
    response_part = p_true[len(p_false):]                     # usually exactly the assistant header
    if len(response_part.strip()) < 2:
        # Some templates (Phi) emit the assistant header even WITHOUT a generation
        # prompt, so the diff degenerates. Fall back to slicing the assistant header
        # (incl. the preceding turn-close) out of the full render before ASST.
        pre = rendered_full.split(ASST, 1)[0]
        response_part = pre.split(USR, 1)[1] if USR in pre else pre
    if supports_system:
        before = rendered_full.split(USR)[0]                 # …<sys>SYS<sys_close><user_header>
        instruction_part = before.split(SYS, 1)[1] if SYS in before else before
    else:
        u_only = tokenizer.apply_chat_template(
            normalize_messages([{'role': 'user', 'content': USR}], supports_system),
            tokenize=False, add_generation_prompt=False)
        instruction_part = u_only.split(USR)[0]              # …<bos?><user_header>
    after = rendered_full.split(ASST, 1)
    stop = (after[1].strip() if len(after) > 1 else '') or (tokenizer.eos_token or '')
    return instruction_part, response_part, stop


def assert_masking(tokenizer, messages, supports_system, instr_part, resp_part, family_label):
    """Gate (handoff §4): prove the trained span is ONLY the assistant move-JSON.
    String-level — locate the response marker in a real rendered row and check the
    text after it is the assistant content (+ a trailing stop marker), nothing more.
    Needs only the tokenizer, so it's a fast GPU-free preflight. The real
    train_on_responses_only uses the SAME resp_part, so this is faithful."""
    text = tokenizer.apply_chat_template(normalize_messages(messages, supports_system),
                                         tokenize=False, add_generation_prompt=False)
    if not resp_part or resp_part not in text:
        sys.exit(f'[FATAL] response marker not found in a rendered row for family "{family_label}".\n'
                 f'  response_part={resp_part!r}\n'
                 f'  Auto-derivation failed for this base — pass --family <name> to force markers.')
    sup = text[text.rfind(resp_part) + len(resp_part):].strip()
    target = messages[2]['content'].strip()
    if target not in sup:
        sys.exit(f'[FATAL] masking span mismatch for family "{family_label}": the trained span does NOT '
                 f'contain the assistant move-JSON — markers wrong, prompt is leaking into the loss.\n'
                 f'  trained span ≈ {sup[:180]!r}\n  expected     ≈ {target[:180]!r}\n'
                 f'  Pass --family {family_label} to override.')
    extra = len(sup) - len(target)
    if extra > 80:                                           # slack for a trailing stop marker
        sys.exit(f'[FATAL] trained span for "{family_label}" is {extra} chars longer than the assistant '
                 f'move-JSON — system/user prompt text is likely leaking past the response marker.\n'
                 f'  Pass --family {family_label} to override.')
    print(f'[preflight] masking OK — trained span is the assistant move-JSON '
          f'(+{extra} marker chars), family={family_label}.')


def verify_exported_modelfile(run_dir, resp_part, stop, family_label):
    """Post-export: confirm the exported Modelfile wraps inference the same way we
    trained — its TEMPLATE carries the assistant marker and a stop param for the
    family stop token. Unsloth writes the real GGUF + Modelfile into <run_dir>_gguf/
    (run_dir's own Modelfile may be a dead FROM ./None stub)."""
    marker = (resp_part.strip().splitlines() or [''])[-1].strip()
    for d in (run_dir + '_gguf', run_dir):
        mf = os.path.join(d, 'Modelfile')
        if not os.path.exists(mf):
            continue
        text = open(mf, encoding='utf-8').read()
        if text.lstrip().startswith('FROM ./None'):
            continue
        if marker and marker not in text:
            print(f'[WARN] exported Modelfile in {d} lacks the {family_label} assistant marker '
                  f'{marker!r} — inference wrapping may not match training. Inspect before ollama create.')
        if stop and f'stop "{stop}"' not in text and stop not in text:
            print(f'[WARN] exported Modelfile in {d} has no stop param for {stop!r} '
                  f'({family_label}) — the model may not stop cleanly at inference.')
        print(f'[export] verified {family_label} Modelfile in {d}')
        return
    print('[WARN] no non-stub Modelfile found to verify.')


def sanitize_quant_config(model):
    """Strip non-serializable callables off the model's quantization_config.

    Unsloth's 8-bit load path (FastBaseModel.from_pretrained) monkeypatches a
    lambda onto config.quantization_config (`get_loading_attributes`). It rides
    into to_diff_dict() and crashes save_pretrained_merged's JSON dump with
    'Object of type function is not JSON serializable'. The 4-bit path doesn't
    attach it, which is why only --load-8bit runs hit this. We keep the quant
    config (so the merge still knows it's dequantizing 8-bit) and remove only the
    callable attrs — defensively, any of them, not just the known lambda.
    """
    cfg = getattr(model, 'config', None) or getattr(getattr(model, 'model', None), 'config', None)
    qc = getattr(cfg, 'quantization_config', None) if cfg is not None else None
    if qc is None or not hasattr(qc, '__dict__'):
        return
    for attr in list(vars(qc)):
        if callable(getattr(qc, attr, None)):
            try:
                delattr(qc, attr)
                print(f'[export] stripped non-serializable quant-config attr: {attr}')
            except Exception:
                pass


def prune_export_intermediates(run_dir, gguf_dir):
    """After a verified GGUF export, delete the redundant 16-bit copies.

    The export leaves TWO throwaway full-precision copies: save_pretrained_merged
    writes run_dir/merged, and save_pretrained_gguf dumps a second loose copy of
    the HF shards into run_dir itself before converting. For a 14B that's ~56 GB;
    for a 32B ~124 GB. Both are dead weight once the GGUF + Modelfile exist in
    <run_dir>_gguf (and get registered via ollama create). We keep checkpoints/
    (the LoRA adapter) so a re-export never requires retraining.

    Guarded: prunes only when a .gguf is actually present in gguf_dir, so a failed
    conversion never costs you the 16-bit weights.
    """
    import shutil
    has_gguf = os.path.isdir(gguf_dir) and any(f.endswith('.gguf') for f in os.listdir(gguf_dir))
    if not has_gguf:
        print(f'[export] skip prune — no GGUF found in {gguf_dir}')
        return
    freed = []
    merged = os.path.join(run_dir, 'merged')
    if os.path.isdir(merged):
        shutil.rmtree(merged, ignore_errors=True)
        freed.append('merged/')
    for name in os.listdir(run_dir):
        if (name.startswith('model-') and name.endswith('.safetensors')) \
                or name == 'model.safetensors.index.json':
            try:
                os.remove(os.path.join(run_dir, name))
                freed.append(name)
            except OSError:
                pass
    if freed:
        head = ', '.join(freed[:3]) + (f' (+{len(freed) - 3} more)' if len(freed) > 3 else '')
        print(f'[export] pruned redundant 16-bit intermediates: {head}')


def main():
    args = parse_args()
    if args.load_4bit and args.load_8bit:
        sys.exit('--load-4bit and --load-8bit are mutually exclusive — pick one quantization.')
    if args.offline and args.no_auto_offline:
        sys.exit('--offline and --no-auto-offline are contradictory — pick one.')
    rows = load_rows(args.dataset)
    family_label = args.family or guess_family(args.base)

    # Fast GPU-free path: derive markers + assert masking using only the tokenizer.
    if args.check_masking:
        try:
            from transformers import AutoTokenizer
        except ImportError as e:
            sys.exit(f'--check-masking needs transformers ({e}). Install the training venv.')
        tok = AutoTokenizer.from_pretrained(args.base)
        if args.chat_template:
            from unsloth.chat_templates import get_chat_template
            tok = get_chat_template(tok, chat_template=args.chat_template)
        supports = template_supports_system(tok)
        instr, resp, stop = derive_markers(tok, supports, override=FAMILY_OVERRIDES.get(args.family))
        print(f'[markers] family={family_label} supports_system={supports}')
        print(f'  instruction_part={instr!r}')
        print(f'  response_part   ={resp!r}')
        print(f'  stop            ={stop!r}')
        assert_masking(tok, rows[0]['messages'], supports, instr, resp, family_label)
        print('[check-masking] OK — markers + masking valid; exiting before training.')
        return

    print('[plan]')
    print(f'  student base : {args.base}  (family {family_label})')
    print(f'  output model : biome-{args.tag}  (GGUF {args.quant})')
    print(f'  LoRA         : r={args.lora_r} alpha={args.lora_alpha}  epochs={args.epochs} lr={args.lr}')
    quant_label = '4bit' if args.load_4bit else '8bit' if args.load_8bit else '16bit (no base quant)'
    print(f'  seq/batch    : max_seq={args.max_seq} batch={args.batch} grad_accum={args.grad_accum} base={quant_label}')
    if _OFFLINE_INFO.get('forced_offline'):
        print('  offline      : FORCED (--offline) — HF Hub + telemetry calls disabled')
    elif _OFFLINE_INFO.get('auto_offline'):
        print(f'  offline      : auto (base cached at {_OFFLINE_INFO["cached_dir"]}) — Hub + telemetry disabled')
    if _OFFLINE_INFO.get('base_swap'):
        print(f'  4bit base    : {args.base}-bnb-4bit not cached → loading full cached weights from '
              f'{_OFFLINE_INFO["base_swap"]} and quantizing 4-bit on the fly')
        if _OFFLINE_INFO.get('base_swap_risky'):
            print('  [WARN] on-the-fly 4-bit from a full checkpoint is UNVERIFIED for some '
                  'architectures (it produced a broken gemma-2 once). Re-run online to fetch the '
                  'pre-quantized -bnb-4bit base, or check the [sanity] loss line below.')
    if _OFFLINE_INFO.get('note'):
        print(f'  offline note : {_OFFLINE_INFO["note"]}')
    if args.dry_run:
        print('[dry-run] dataset valid; exiting before training.')
        return

    # Imports are deferred so --dry-run works without the heavy stack installed.
    try:
        import torch  # noqa: F401
        from unsloth import FastLanguageModel
        from unsloth.chat_templates import train_on_responses_only
        from datasets import Dataset
        from trl import SFTTrainer, SFTConfig
    except ImportError as e:
        sys.exit(f'missing training deps ({e}). See tools/README-training.md for the Blackwell/sm_120 setup.')

    os.makedirs(args.out, exist_ok=True)
    run_dir = os.path.join(args.out, f'biome-{args.tag}')

    # When offline + 4-bit + the -bnb-4bit variant isn't cached, load the full
    # cached weights from the local snapshot path (bypasses Unsloth's remap).
    load_base = _OFFLINE_INFO.get('base_swap') or args.base
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=load_base, max_seq_length=args.max_seq,
        load_in_4bit=args.load_4bit, load_in_8bit=args.load_8bit, dtype=None,
    )
    if args.chat_template:
        from unsloth.chat_templates import get_chat_template
        tokenizer = get_chat_template(tokenizer, chat_template=args.chat_template)
    model = FastLanguageModel.get_peft_model(
        model, r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0, bias='none',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        use_gradient_checkpointing='unsloth', random_state=3407,
    )

    # Derive the masking markers from THIS tokenizer's template, then gate on the
    # masking assertion BEFORE the expensive training step.
    supports_system = template_supports_system(tokenizer)
    instr_part, resp_part, stop = derive_markers(
        tokenizer, supports_system, override=FAMILY_OVERRIDES.get(args.family))
    print(f'[markers] family={family_label} supports_system={supports_system}')
    print(f'  instruction_part={instr_part!r}')
    print(f'  response_part   ={resp_part!r}')
    print(f'  stop            ={stop!r}')
    assert_masking(tokenizer, rows[0]['messages'], supports_system, instr_part, resp_part, family_label)

    def fmt(batch):
        return {'text': [tokenizer.apply_chat_template(normalize_messages(m, supports_system),
                                                       tokenize=False, add_generation_prompt=False)
                         for m in batch['messages']]}
    ds = Dataset.from_list(rows).map(fmt, batched=True)

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=ds,
        args=SFTConfig(
            per_device_train_batch_size=args.batch, gradient_accumulation_steps=args.grad_accum,
            warmup_steps=5, num_train_epochs=args.epochs, learning_rate=args.lr,
            logging_steps=1, optim='adamw_8bit', weight_decay=0.01, lr_scheduler_type='linear',
            seed=3407, output_dir=os.path.join(run_dir, 'checkpoints'), report_to='none',
            dataset_text_field='text', max_seq_length=args.max_seq,
        ),
    )
    # Train on the assistant move ONLY (mask system+user from the loss), using the
    # SAME markers the assertion just validated.
    trainer = train_on_responses_only(
        trainer, instruction_part=instr_part, response_part=resp_part)

    trainer.train()

    # Loss sanity check — a healthy SFT starts ~1-3 and ends <1. A double-digit start
    # means the base loaded with a broken forward pass (e.g. on-the-fly 4-bit from a
    # full checkpoint) and the merged model will be word-salad. Warn loudly; the export
    # still runs so the artifacts exist, but don't trust the model without testing.
    try:
        losses = [e['loss'] for e in trainer.state.log_history if 'loss' in e]
        if losses:
            print(f'[sanity] train loss {losses[0]:.2f} → {losses[-1]:.2f}')
            if losses[0] > 5.0 or losses[-1] > 3.0:
                print('  [WARN] loss is implausibly high (healthy runs start ~1.5, end <1). The '
                      'base likely loaded wrong — TEST before deploying: a fresh prompt should '
                      'return coherent JSON, not word-salad. Do NOT enter this on the ladder blind.')
    except Exception:
        pass

    print('[export] merging LoRA + writing GGUF…')
    sanitize_quant_config(model)  # 8-bit loads leak a lambda into the config → JSON dump crash
    model.save_pretrained_merged(os.path.join(run_dir, 'merged'), tokenizer, save_method='merged_16bit')
    model.save_pretrained_gguf(run_dir, tokenizer, quantization_method=args.quant)
    verify_exported_modelfile(run_dir, resp_part, stop, family_label)

    gguf_dir = run_dir + '_gguf'
    prune_export_intermediates(run_dir, gguf_dir)  # drop the ~56 GB (32B: ~124 GB) of dead 16-bit copies
    print(f'\n[done] biome-{args.tag} built (artifacts in {gguf_dir})')
    print('Enter it on the ladder with:')
    print(f'  cd {gguf_dir} && ollama create biome-{args.tag} -f Modelfile')
    print('Then run a challenger gauntlet (Training Lab → Generate → watch) of '
          f'biome-{args.tag} vs {args.base.split("/")[-1]} and watch the ELO on the dashboard.')


if __name__ == '__main__':
    main()
