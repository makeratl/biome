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
        --tag  qwen2.5-7b-v1

The dataset rows are provider-neutral chat:
    {"messages":[{role:system},{role:user},{role:assistant}], "meta":{...}}
We train on the ASSISTANT completion only (the move JSON) — the long system+user
prompt is masked from the loss, so the model learns to *answer*, not to recite
the rules it's already given at inference.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATASET = os.path.join(ROOT, 'training-data', 'dataset.jsonl')


def parse_args():
    p = argparse.ArgumentParser(description='LoRA-tune a Biome student model.')
    p.add_argument('--dataset', default=DEFAULT_DATASET, help='dataset.jsonl from the Training Lab export')
    p.add_argument('--base', default='unsloth/Qwen2.5-7B-Instruct',
                   help='HF base model id (the STUDENT). A weak student is a fine experiment — '
                        'the champion is the teacher, distilled in via the data.')
    p.add_argument('--tag', default='qwen2.5-7b-v1', help='version tag → ollama model biome-<tag>')
    p.add_argument('--out', default=os.path.join(ROOT, 'training-data', 'runs'), help='output dir')
    p.add_argument('--epochs', type=float, default=2.0)
    p.add_argument('--lr', type=float, default=2e-4)
    p.add_argument('--lora-r', type=int, default=16)
    p.add_argument('--lora-alpha', type=int, default=32)
    p.add_argument('--max-seq', type=int, default=4096, help='prompts run ~2k tokens; 4096 leaves headroom')
    p.add_argument('--batch', type=int, default=2)
    p.add_argument('--grad-accum', type=int, default=4)
    p.add_argument('--load-4bit', action='store_true', help='QLoRA — needed for ~32B students, optional for 7-14B')
    p.add_argument('--quant', default='q4_k_m', help='GGUF quantization for the exported model')
    p.add_argument('--dry-run', action='store_true', help='validate the dataset + print the plan, then exit')
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


def main():
    args = parse_args()
    rows = load_rows(args.dataset)

    print('[plan]')
    print(f'  student base : {args.base}')
    print(f'  output model : biome-{args.tag}  (GGUF {args.quant})')
    print(f'  LoRA         : r={args.lora_r} alpha={args.lora_alpha}  epochs={args.epochs} lr={args.lr}')
    print(f'  seq/batch    : max_seq={args.max_seq} batch={args.batch} grad_accum={args.grad_accum} 4bit={args.load_4bit}')
    if args.dry_run:
        print('[dry-run] dataset valid; exiting before training.')
        return

    # Imports are deferred so --dry-run works without the heavy stack installed.
    try:
        import torch
        from unsloth import FastLanguageModel
        from unsloth.chat_templates import train_on_responses_only
        from datasets import Dataset
        from trl import SFTTrainer, SFTConfig
    except ImportError as e:
        sys.exit(f'missing training deps ({e}). See tools/README-training.md for the Blackwell/sm_120 setup.')

    os.makedirs(args.out, exist_ok=True)
    run_dir = os.path.join(args.out, f'biome-{args.tag}')

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base, max_seq_length=args.max_seq,
        load_in_4bit=args.load_4bit, dtype=None,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0, bias='none',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        use_gradient_checkpointing='unsloth', random_state=3407,
    )

    def fmt(batch):
        return {'text': [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False)
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
    # Train on the assistant move ONLY (mask the system+user prompt from the loss).
    # The markers are Qwen/Llama-style chat turn headers; adjust for other bases.
    trainer = train_on_responses_only(
        trainer,
        instruction_part='<|im_start|>user\n',
        response_part='<|im_start|>assistant\n',
    )

    trainer.train()

    print('[export] merging LoRA + writing GGUF…')
    model.save_pretrained_merged(os.path.join(run_dir, 'merged'), tokenizer, save_method='merged_16bit')
    model.save_pretrained_gguf(run_dir, tokenizer, quantization_method=args.quant)

    gguf = next((f for f in os.listdir(run_dir) if f.endswith('.gguf')), None)
    modelfile = os.path.join(run_dir, 'Modelfile')
    with open(modelfile, 'w') as f:
        f.write(f'FROM ./{gguf}\n'
                'PARAMETER temperature 0.7\n'
                'PARAMETER num_ctx 4096\n')
    print(f'\n[done] biome-{args.tag} built in {run_dir}')
    print('Enter it on the ladder with:')
    print(f'  cd {run_dir} && ollama create biome-{args.tag} -f Modelfile')
    print('Then run a challenger gauntlet (Training Lab → Generate → watch) of '
          f'biome-{args.tag} vs {args.base.split("/")[-1]} and watch the ELO on the dashboard.')


if __name__ == '__main__':
    main()
