"""Training-data join + reward labeling for the Biome Training Lab.

Reads the three append-only capture logs written by server.py
(training-data/turns.jsonl, rounds.jsonl, outcomes.jsonl), joins them by
match_uid + round, scores each turn with an engine-grounded reward, and emits
provider-neutral SFT rows (messages + meta).

The reward is "engine-validated distillation": a turn is GOLD only if the
simulation confirms it worked — its side WON the match (hard gate), and the
weighted signal clears a threshold. Winners' moves that also improved their
score margin and trophic balance score highest. Fallback turns (the model
failed to answer) are never gold — they aren't model answers to imitate.

Pure stdlib so it runs both inside the server and standalone for inspection:
    python3 traj.py            # summary of what's captured + would-be-gold count
    python3 traj.py export     # write training-data/dataset.jsonl + manifest.json
"""

import json
import os
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TRAINING_DIR = os.path.join(BASE_DIR, 'training-data')

# ── reward weights (tunable; echoed into the dataset manifest) ──────────────
# won_match is also a HARD GATE — non-winning turns are never gold regardless.
REWARD = {
    'w_won': 0.45,        # the move's side won the match
    'w_margin': 0.35,     # this round grew the player's score lead
    'w_trophic': 0.20,    # this round moved the player toward a balanced pyramid
    'margin_scale': 1000.0,   # score-margin delta that maps to a full +0.5 swing
    'gold_threshold': 0.60,
}


def _read_jsonl(name):
    path = os.path.join(TRAINING_DIR, name)
    out = []
    if not os.path.exists(path):
        return out
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def load():
    """Load + index the capture logs. Returns (turns, rounds_idx, outcomes_idx)."""
    turns = _read_jsonl('turns.jsonl')
    rounds = _read_jsonl('rounds.jsonl')
    outcomes = _read_jsonl('outcomes.jsonl')
    rounds_idx = {}          # (match_uid, round) -> round record
    for r in rounds:
        rounds_idx[(r.get('match_uid'), r.get('round'))] = r
    outcomes_idx = {}        # match_uid -> outcome record
    for o in outcomes:
        outcomes_idx[o.get('match_uid')] = o
    return turns, rounds_idx, outcomes_idx


def load_labels():
    """Manual curate overrides {turn_uid: 'gold'|'reject'} from labels.jsonl
    (last write wins). A star forces a turn in; a reject pulls it out."""
    out = {}
    for rec in _read_jsonl('labels.jsonl'):
        uid = rec.get('turn_uid')
        if uid:
            out[uid] = rec.get('decision')
    return out


def _clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def _margin(round_rec, player):
    """Score lead (me - opponent) for `player` at a round, from final_score."""
    if not round_rec:
        return None
    fs = round_rec.get('final_score') or {}
    other = 2 if player == 1 else 1
    me = (fs.get(str(player)) or fs.get(player) or {}).get('finalScore')
    op = (fs.get(str(other)) or fs.get(other) or {}).get('finalScore')
    if me is None or op is None:
        return None
    return me - op


def _trophic(round_rec, player):
    if not round_rec:
        return None
    tr = round_rec.get('trophic') or {}
    return tr.get(str(player)) or tr.get(player)


def score_turn(turn, rounds_idx, outcomes_idx):
    """Compute the reward breakdown + gold verdict for one turn record."""
    muid = turn.get('match_uid')
    player = turn.get('player')
    rnd = turn.get('round')
    outcome = outcomes_idx.get(muid)

    won = bool(outcome and outcome.get('winner') == turn.get('model'))
    has_answer = bool(turn.get('response_raw') and (turn['response_raw'].get('content'))
                      and not turn.get('fallback_reason'))

    # round score-margin delta: this round's lead minus the previous round's.
    this_r = rounds_idx.get((muid, rnd))
    prev_r = rounds_idx.get((muid, rnd - 1)) if rnd else None
    m_now = _margin(this_r, player)
    m_prev = _margin(prev_r, player) if prev_r else 0.0
    if m_now is None:
        margin_norm = 0.5
    else:
        delta = m_now - (m_prev if m_prev is not None else 0.0)
        margin_norm = _clamp(0.5 + delta / (2.0 * REWARD['margin_scale']))

    # trophic improvement: health up / risk down / not collapsing this round.
    t_now = _trophic(this_r, player)
    t_prev = _trophic(prev_r, player) if prev_r else None
    if not t_now:
        trophic_improved = 0.0
    elif t_prev:
        better = (t_now.get('health', 0) >= t_prev.get('health', 0)
                  and t_now.get('risk', 1) <= t_prev.get('risk', 1))
        trophic_improved = 1.0 if better and t_now.get('state') != 'collapsing' else 0.0
    else:
        trophic_improved = 1.0 if (t_now.get('risk', 1) < 0.4 and t_now.get('state') != 'collapsing') else 0.0

    label_score = (REWARD['w_won'] * (1.0 if won else 0.0)
                   + REWARD['w_margin'] * margin_norm
                   + REWARD['w_trophic'] * trophic_improved)
    gold = won and has_answer and label_score >= REWARD['gold_threshold']

    return {
        'won_match': won,
        'has_answer': has_answer,
        'margin_now': m_now,
        'margin_norm': round(margin_norm, 3),
        'trophic_state': (t_now or {}).get('state'),
        'trophic_improved': bool(trophic_improved),
        'label_score': round(label_score, 3),
        'gold': bool(gold),
    }


def labeled_turns(filters=None):
    """Yield (turn, label) pairs, optionally filtered by model / gold / match_uid."""
    filters = filters or {}
    turns, rounds_idx, outcomes_idx = load()
    for t in turns:
        if filters.get('model') and t.get('model') != filters['model']:
            continue
        if filters.get('match_uid') and t.get('match_uid') != filters['match_uid']:
            continue
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        if filters.get('gold') and not lbl['gold']:
            continue
        yield t, lbl


def summarize(turn, lbl):
    """Compact per-turn row for the curate UI (no big prompt/response blobs)."""
    rp = turn.get('response_parsed') or {}
    return {
        'turn_uid': turn.get('turn_uid'),
        'match_uid': turn.get('match_uid'),
        'round': turn.get('round'),
        'player': turn.get('player'),
        'model': turn.get('model'),
        'opponent_model': turn.get('opponent_model'),
        'reasoning': (rp.get('reasoning') or '')[:160],
        'exec_ok': sum(1 for e in (turn.get('exec') or []) if e.get('ok')),
        'fallback_reason': turn.get('fallback_reason'),
        'won_match': lbl['won_match'],
        'label_score': lbl['label_score'],
        'gold': lbl['gold'],
        'trophic_state': lbl['trophic_state'],
    }


def build_dataset(filters=None, manual=None):
    """Build SFT rows for GOLD turns (+manual stars). Returns (rows, manifest).

    `manual` is an optional {turn_uid: 'gold'|'reject'} override map from the
    curate UI: a star forces inclusion (if it has an answer), a reject removes it.
    """
    filters = filters or {}
    manual = manual if manual is not None else load_labels()
    turns, rounds_idx, outcomes_idx = load()
    rows = []
    src_models = {}
    seeds = set()
    for t in turns:
        if filters.get('model') and t.get('model') != filters['model']:
            continue
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        decision = manual.get(t.get('turn_uid'))
        include = (lbl['gold'] or decision == 'gold') and decision != 'reject'
        if not include:
            continue
        # Must have a verbatim answer to imitate.
        raw = t.get('response_raw') or {}
        content = raw.get('content')
        if not content:
            continue
        prompt = t.get('prompt') or {}
        rows.append({
            'messages': [
                {'role': 'system', 'content': prompt.get('system', '')},
                {'role': 'user', 'content': prompt.get('user', '')},
                {'role': 'assistant', 'content': content},
            ],
            'meta': {
                'turn_uid': t.get('turn_uid'),
                'match_uid': t.get('match_uid'),
                'seed': t.get('seed'),
                'teacher_model': t.get('model'),
                'round': t.get('round'),
                'won_match': lbl['won_match'],
                'label_score': lbl['label_score'],
                'label_source': 'manual' if decision == 'gold' else 'auto',
                'trophic_state': lbl['trophic_state'],
                'map_strategy': t.get('map_strategy'),
            },
        })
        src_models[t.get('model')] = src_models.get(t.get('model'), 0) + 1
        if t.get('seed') is not None:
            seeds.add(t.get('seed'))

    manifest = {
        'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'rows': len(rows),
        'reward': REWARD,
        'filters': filters,
        'source_models': src_models,
        'distinct_seeds': len(seeds),
    }
    return rows, manifest


def write_dataset(filters=None, manual=None):
    rows, manifest = build_dataset(filters, manual)
    os.makedirs(TRAINING_DIR, exist_ok=True)
    ds_path = os.path.join(TRAINING_DIR, 'dataset.jsonl')
    with open(ds_path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, separators=(',', ':')) + '\n')
    with open(os.path.join(TRAINING_DIR, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    manifest['dataset_path'] = ds_path
    return manifest


def stats():
    """Dashboard metrics: capture totals, gold count, and progress to goals."""
    turns, rounds_idx, outcomes_idx = load()
    gold = won = fallback = 0
    by_model = {}
    seeds = set()
    for t in turns:
        if t.get('fallback_reason'):
            fallback += 1
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        if lbl['won_match']:
            won += 1
        if lbl['gold']:
            gold += 1
            by_model[t.get('model')] = by_model.get(t.get('model'), 0) + 1
        if t.get('seed') is not None:
            seeds.add(t.get('seed'))
    return {
        'gold': gold,
        'turns': len(turns),
        'rounds': len(rounds_idx),
        'matches': len(outcomes_idx),
        'won_turns': won,
        'fallback_turns': fallback,
        'distinct_seeds': len(seeds),
        'gold_by_model': dict(sorted(by_model.items(), key=lambda kv: -kv[1])),
        'goals': {'smoke': 300, 'ladder': 2000, 'robust': 10000},
    }


def purge(mode='curatable'):
    """Compact the capture logs so they don't backfill indefinitely.

    Always drops manually REJECTED turns. Then, for SEALED matches:
      - mode='curatable' (default, safe): keep gold + any winner-with-an-answer
        turn (still star-able later); drop losers' turns and fallbacks — those
        can NEVER be gold (won_match is a hard gate, fallbacks have no answer).
      - mode='gold': keep ONLY current gold + manual stars. Smallest; you lose
        the ability to re-curate sub-threshold winner turns.
    In-flight matches (no outcome yet) are always kept. Rounds/labels are pruned
    to the surviving matches; originals are backed up to *.jsonl.bak first.
    """
    turns, rounds_idx, outcomes_idx = load()
    labels = load_labels()
    before = len(turns)
    keep = []
    for t in turns:
        uid, muid = t.get('turn_uid'), t.get('match_uid')
        if labels.get(uid) == 'reject':
            continue
        if muid not in outcomes_idx:        # in-flight — never drop
            keep.append(t)
            continue
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        starred = labels.get(uid) == 'gold'
        if mode == 'gold':
            if lbl['gold'] or starred:
                keep.append(t)
        else:  # curatable
            if lbl['gold'] or starred or (lbl['won_match'] and lbl['has_answer']):
                keep.append(t)

    kept_uids = {t.get('turn_uid') for t in keep}
    kept_muids = {t.get('match_uid') for t in keep}
    rounds = [r for r in _read_jsonl('rounds.jsonl') if r.get('match_uid') in kept_muids]
    keep_labels = [{'turn_uid': u, 'decision': d} for u, d in labels.items() if u in kept_uids]

    def rewrite(name, rows):
        path = os.path.join(TRAINING_DIR, name)
        if os.path.exists(path):
            os.replace(path, path + '.bak')
        with open(path, 'w', encoding='utf-8') as f:
            for r in rows:
                f.write(json.dumps(r, separators=(',', ':')) + '\n')

    rewrite('turns.jsonl', keep)
    rewrite('rounds.jsonl', rounds)
    if os.path.exists(os.path.join(TRAINING_DIR, 'labels.jsonl')):
        rewrite('labels.jsonl', keep_labels)

    return {'mode': mode, 'turns_before': before, 'turns_after': len(keep),
            'dropped': before - len(keep), 'rounds_after': len(rounds)}


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'purge':
        m = sys.argv[2] if len(sys.argv) > 2 else 'curatable'
        print(json.dumps(purge(m), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == 'export':
        m = write_dataset()
        print(json.dumps(m, indent=2))
    else:
        turns, rounds_idx, outcomes_idx = load()
        gold = 0
        won = 0
        for t in turns:
            lbl = score_turn(t, rounds_idx, outcomes_idx)
            gold += 1 if lbl['gold'] else 0
            won += 1 if lbl['won_match'] else 0
        print(f"turns={len(turns)} rounds={len(rounds_idx)} outcomes={len(outcomes_idx)} "
              f"won_turns={won} gold={gold}")
