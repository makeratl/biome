"""Training-data join + reward labeling for the Biome Training Lab.

Reads the three append-only capture logs written by server.py
(training-data/turns.jsonl, rounds.jsonl, outcomes.jsonl), joins them by
match_uid + round, scores each turn with an engine-grounded reward, and emits
provider-neutral SFT rows (messages + meta).

The reward is "engine-validated distillation". Each move carries two quality
signals the engine computed live — marginGrew (its score lead grew) and
trophicImproved (a healthier pyramid) — plus has_answer (a real model answer,
not a fallback) and won_match. The medal tier is driven by how many quality
signals a move has; the win only decides gold-vs-silver (see classify_medal,
mirrored from js/medal.js):

    2 signals -> GOLD if won, else SILVER
    1 signal  -> BRONZE (win-independent)
    0 signals -> no medal ;  fallbacks (no answer) never earn a medal.

Only GOLD is exported for training; silver/bronze are quality metrics.

Pure stdlib so it runs both inside the server and standalone for inspection:
    python3 traj.py            # summary of what's captured + would-be-gold count
    python3 traj.py export     # write training-data/dataset.jsonl + manifest.json
"""

import hashlib
import json
import os
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TRAINING_DIR = os.path.join(BASE_DIR, 'training-data')

# ── reward weights ──────────────────────────────────────────────────────────
# The medal tier (classify_medal) is the GATE for what trains. These weights now
# only drive `label_score`, a secondary continuous quality number kept for the
# curate UI's sort/scorebar; they no longer decide gold. Echoed into the manifest.
REWARD = {
    'w_won': 0.45,        # the move's side won the match
    'w_margin': 0.35,     # this round grew the player's score lead
    'w_trophic': 0.20,    # this round moved the player toward a balanced pyramid
    'margin_scale': 1000.0,   # score-margin delta that maps to a full +0.5 swing
}

# ── training tiers ───────────────────────────────────────────────────────────
# Which medals a training set draws from. Named to match the Training Lab
# dashboard's SET_TIERS (js: champion/contender/player). The export only ever
# imitates these; manual stars still force a turn in regardless of tier.
# Quality note: silver = a 2-signal move on the LOSING side, bronze = a single
# signal — both noisier teachers than gold, exposed deliberately as experiments.
TIERS = {
    'champion':  ('gold',),
    'contender': ('gold', 'silver'),
    'player':    ('gold', 'silver', 'bronze'),
}
DEFAULT_TIER = 'champion'


def classify_medal(real, won_match, margin_grew, trophic_improved):
    """Training medal tier — MIRROR of classifyMedal() in js/medal.js. Keep both
    in sync or the in-game end screen and the exported dataset will disagree.
    real gates everything; quality = marginGrew + trophicImproved; the win only
    decides gold vs silver.
        2 signals -> 'gold' if won else 'silver'
        1 signal  -> 'bronze'   (win-independent)
        0 signals -> None
    """
    if not real:
        return None
    q = (1 if margin_grew else 0) + (1 if trophic_improved else 0)
    if q == 2:
        return 'gold' if won_match else 'silver'
    if q == 1:
        return 'bronze'
    return None


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


def _signal(round_rec, player):
    """The engine's CAPTURED per-player quality booleans for a round, if present
    (logs written after the medal change). None for older logs → recompute."""
    if not round_rec:
        return None
    sg = round_rec.get('signals') or {}
    return sg.get(str(player)) or sg.get(player)


def score_turn(turn, rounds_idx, outcomes_idx):
    """Compute the reward breakdown + medal verdict for one turn record."""
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
    t_now = _trophic(this_r, player)

    # label_score: a secondary, continuous quality number for the curate UI's
    # sort/scorebar. Not the gate (the medal is).
    if m_now is None:
        margin_norm = 0.5
    else:
        delta = m_now - (m_prev if m_prev is not None else 0.0)
        margin_norm = _clamp(0.5 + delta / (2.0 * REWARD['margin_scale']))

    # Boolean quality signals — prefer the engine's CAPTURED booleans (zero drift
    # vs the in-game end screen); recompute from score/trophic deltas only for
    # pre-signals logs. Same rule as game.js._computeRoundSignals.
    sig = _signal(this_r, player)
    if sig is not None:
        margin_grew = bool(sig.get('marginGrew'))
        trophic_improved = bool(sig.get('trophicImproved'))
    else:
        margin_grew = (m_now is not None
                       and (m_now - (m_prev if m_prev is not None else 0.0)) > 0)
        t_prev = _trophic(prev_r, player) if prev_r else None
        h_now = (t_now or {}).get('health', 0)
        r_now = (t_now or {}).get('risk', 1)
        h_prev = (t_prev or {}).get('health', 0.0)
        r_prev = (t_prev or {}).get('risk', 1.0)
        trophic_improved = bool(t_now and h_now > h_prev and r_now <= r_prev
                                and t_now.get('state') != 'collapsing')

    medal = classify_medal(has_answer, won, margin_grew, trophic_improved)

    label_score = (REWARD['w_won'] * (1.0 if won else 0.0)
                   + REWARD['w_margin'] * margin_norm
                   + REWARD['w_trophic'] * (1.0 if trophic_improved else 0.0))

    return {
        'won_match': won,
        'has_answer': has_answer,
        'margin_now': m_now,
        'margin_norm': round(margin_norm, 3),
        'margin_grew': bool(margin_grew),
        'trophic_state': (t_now or {}).get('state'),
        'trophic_improved': bool(trophic_improved),
        'label_score': round(label_score, 3),
        'medal': medal,
        'gold': medal == 'gold',
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
        if filters.get('medal') and lbl['medal'] != filters['medal']:
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
        'medal': lbl['medal'],
        'trophic_state': lbl['trophic_state'],
    }


def build_dataset(filters=None, manual=None):
    """Build SFT rows for a training TIER (+manual stars). Returns (rows, manifest).

    `filters['tier']` (champion|contender|player, default champion) picks which
    medals are imitated — champion=gold only, contender=+silver, player=+bronze.
    `manual` is an optional {turn_uid: 'gold'|'reject'} override map from the
    curate UI: a star forces inclusion (if it has an answer), a reject removes it.
    """
    filters = filters or {}
    tier = filters.get('tier') or DEFAULT_TIER
    allowed = set(TIERS.get(tier, TIERS[DEFAULT_TIER]))
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
        include = ((lbl['medal'] in allowed) or decision == 'gold') and decision != 'reject'
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
                'medal': lbl['medal'],
                'trophic_state': lbl['trophic_state'],
                'map_strategy': t.get('map_strategy'),
            },
        })
        src_models[t.get('model')] = src_models.get(t.get('model'), 0) + 1
        if t.get('seed') is not None:
            seeds.add(t.get('seed'))

    # Canonical content fingerprint: stable across re-exports + row order / file
    # formatting (sorted turn_uids + shape). Two runs with the same gold set get the
    # same fingerprint → lets cross-family runs PROVE they trained on identical data.
    uids = sorted(r['meta'].get('turn_uid') or '' for r in rows)
    canon = '\n'.join(uids) + f'|rows={len(rows)}|seeds={len(seeds)}|teachers={len(src_models)}'
    fingerprint = hashlib.sha256(canon.encode('utf-8')).hexdigest()

    manifest = {
        'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'rows': len(rows),
        'tier': tier,
        'medals': sorted(allowed),
        'reward': REWARD,
        'filters': filters,
        'source_models': src_models,
        'teacher_count': len(src_models),
        'distinct_seeds': len(seeds),
        'fingerprint': fingerprint,
    }
    return rows, manifest


def write_dataset(filters=None, manual=None, out_path=None):
    """Write the SFT rows to dataset.jsonl + a manifest sidecar. `out_path` lets a
    training run keep its own dataset (e.g. training-data/runs/<tag>/dataset.jsonl)
    instead of clobbering the shared training-data/dataset.jsonl."""
    rows, manifest = build_dataset(filters, manual)
    ds_path = out_path or os.path.join(TRAINING_DIR, 'dataset.jsonl')
    os.makedirs(os.path.dirname(ds_path), exist_ok=True)
    with open(ds_path, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, separators=(',', ':')) + '\n')
    # Byte-exact hash of the written file (complements the canonical fingerprint).
    with open(ds_path, 'rb') as f:
        manifest['file_sha256'] = hashlib.sha256(f.read()).hexdigest()
    # Manifest sits beside the dataset (shared one keeps its canonical name).
    mf_path = (os.path.join(os.path.dirname(ds_path), 'manifest.json')
               if out_path else os.path.join(TRAINING_DIR, 'manifest.json'))
    with open(mf_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)
    manifest['dataset_path'] = ds_path
    return manifest


def dataset_counts_by_tier():
    """Row counts each tier would export right now — champion ⊆ contender ⊆ player —
    honoring manual stars/rejects. Mirrors build_dataset's include rule exactly in a
    single pass (the logs are large; don't reload per tier). Drives the Train tab."""
    manual = load_labels()
    turns, rounds_idx, outcomes_idx = load()
    counts = {t: 0 for t in TIERS}
    for t in turns:
        decision = manual.get(t.get('turn_uid'))
        if decision == 'reject':
            continue
        if not (t.get('response_raw') or {}).get('content'):
            continue
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        for tier, allowed in TIERS.items():
            if (lbl['medal'] in allowed) or decision == 'gold':
                counts[tier] += 1
    return counts


def stats():
    """Dashboard metrics: capture totals, medal counts, and progress to goals."""
    turns, rounds_idx, outcomes_idx = load()
    gold = silver = bronze = won = fallback = 0
    by_model = {}        # gold per model (the trainable tier)
    silver_by_model = {}
    bronze_by_model = {}
    seeds = set()
    for t in turns:
        if t.get('fallback_reason'):
            fallback += 1
        lbl = score_turn(t, rounds_idx, outcomes_idx)
        if lbl['won_match']:
            won += 1
        model = t.get('model')
        if lbl['medal'] == 'gold':
            gold += 1
            by_model[model] = by_model.get(model, 0) + 1
        elif lbl['medal'] == 'silver':
            silver += 1
            silver_by_model[model] = silver_by_model.get(model, 0) + 1
        elif lbl['medal'] == 'bronze':
            bronze += 1
            bronze_by_model[model] = bronze_by_model.get(model, 0) + 1
        if t.get('seed') is not None:
            seeds.add(t.get('seed'))
    _sort = lambda d: dict(sorted(d.items(), key=lambda kv: -kv[1]))
    return {
        'gold': gold,
        'silver': silver,
        'bronze': bronze,
        'turns': len(turns),
        'rounds': len(rounds_idx),
        'matches': len(outcomes_idx),
        'won_turns': won,
        'fallback_turns': fallback,
        'distinct_seeds': len(seeds),
        'gold_by_model': _sort(by_model),
        'silver_by_model': _sort(silver_by_model),
        'bronze_by_model': _sort(bronze_by_model),
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
