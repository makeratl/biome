#!/usr/bin/env python3
"""SQLite data layer for Biome's tournament/ELO history.

Replaces the flat `tournament_log.json` (which recomputed ELO from scratch on
every read) with a real, queryable store that *keeps* history. The headline win
is `rating_events`: one row per player per match recording the elo_before →
elo_after transition, which is the time-series every dashboard chart is built on.

Design notes:
  * Stdlib `sqlite3` only — no new dependency, single file (`biome.db`), in
    keeping with the project's zero-deps philosophy.
  * ELO is computed once, incrementally, on insert (O(1) per match) and stored —
    not replayed from the whole log on every request. The math is identical to
    the old _compute_rankings (K=32, base 1000), so standings are unchanged.
  * First boot migrates the existing JSON log by replaying it in chronological
    order, reconstructing a complete ELO timeline. The JSON file is left
    untouched as a backup.
  * The server is threaded, so every write goes through a module lock and a
    single shared connection (check_same_thread=False). Traffic is tiny.
"""

import json
import os
import re
import shutil
import sqlite3
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, 'biome.db')
LEGACY_LOG = os.path.join(BASE_DIR, 'tournament_log.json')

DEFAULT_ELO = 1000
K_FACTOR = 32

_lock = threading.Lock()
_conn = None


# ── connection + schema ──────────────────────────────────────

def _connect():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute('PRAGMA journal_mode=WAL')
        _conn.execute('PRAGMA foreign_keys=ON')
    return _conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    played_at     TEXT    NOT NULL,
    tournament_id TEXT,
    round         INTEGER,
    mode          TEXT    DEFAULT 'standard',
    format        TEXT,
    map_size      TEXT,
    map_strategy  TEXT,
    rounds        INTEGER,
    p1            TEXT    NOT NULL,
    p2            TEXT    NOT NULL,
    p1_score      REAL    DEFAULT 0,
    p2_score      REAL    DEFAULT 0,
    winner        TEXT    NOT NULL,
    loser         TEXT    NOT NULL,
    margin        REAL    DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rating_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    played_at    TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    opponent     TEXT    NOT NULL,
    result       TEXT    NOT NULL,          -- 'W' | 'L'
    elo_before   INTEGER NOT NULL,
    elo_after    INTEGER NOT NULL,
    delta        INTEGER NOT NULL,
    win_prob     REAL    NOT NULL,          -- expected score before the match
    match_number INTEGER NOT NULL           -- this model's running game count
);

CREATE TABLE IF NOT EXISTS models (
    model      TEXT PRIMARY KEY,
    elo        INTEGER NOT NULL DEFAULT 1000,
    peak_elo   INTEGER NOT NULL DEFAULT 1000,
    peak_at    TEXT,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    matches    INTEGER NOT NULL DEFAULT 0,
    streak     INTEGER NOT NULL DEFAULT 0,   -- signed: +n wins / -n losses
    first_seen TEXT,
    last_seen  TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_model ON rating_events(model, id);
CREATE INDEX IF NOT EXISTS idx_matches_played ON matches(played_at);
"""


def init_db():
    """Create the schema if needed and migrate the legacy JSON log once."""
    with _lock:
        conn = _connect()
        conn.executescript(SCHEMA)
        _add_column_if_missing(conn, 'matches', 'map_strategy', 'TEXT')
        _add_column_if_missing(conn, 'matches', 'seed', 'INTEGER')
        conn.commit()
        count = conn.execute('SELECT COUNT(*) AS c FROM matches').fetchone()['c']
        if count == 0 and os.path.exists(LEGACY_LOG):
            _migrate_legacy(conn)


def _add_column_if_missing(conn, table, column, decl):
    """Additive migration: add a column to an existing table if it isn't there
    yet (CREATE TABLE IF NOT EXISTS won't alter a table that already exists)."""
    cols = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})').fetchall()}
    if column not in cols:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {column} {decl}')


def _migrate_legacy(conn):
    """Replay tournament_log.json in order to seed matches + ELO history."""
    try:
        with open(LEGACY_LOG) as f:
            log = json.load(f)
    except (json.JSONDecodeError, IOError):
        return
    migrated = 0
    for entry in log:
        if not all(k in entry for k in ('p1', 'p2', 'winner')):
            continue
        _insert_match(conn, {
            'tournament_id': entry.get('tournament_id'),
            'round': entry.get('round'),
            'mode': entry.get('mode', 'standard'),
            'format': entry.get('format'),
            'map_size': entry.get('map_size'),
            'map_strategy': entry.get('map_strategy'),
            'rounds': entry.get('rounds'),
            'p1': entry['p1'],
            'p2': entry['p2'],
            'p1_score': entry.get('p1_score', 0),
            'p2_score': entry.get('p2_score', 0),
            'winner': entry['winner'],
        }, played_at=entry.get('timestamp'))
        migrated += 1
    conn.commit()
    print(f'[db] migrated {migrated} matches from tournament_log.json')


# ── ELO ──────────────────────────────────────────────────────

def _expected(r_a, r_b):
    return 1 / (1 + 10 ** ((r_b - r_a) / 400))


def _model_row(conn, name):
    row = conn.execute('SELECT * FROM models WHERE model=?', (name,)).fetchone()
    if row:
        return dict(row)
    return {'model': name, 'elo': DEFAULT_ELO, 'peak_elo': DEFAULT_ELO,
            'peak_at': None, 'wins': 0, 'losses': 0, 'matches': 0,
            'streak': 0, 'first_seen': None, 'last_seen': None}


def _rank_map(conn):
    """model -> 1-based rank by current ELO (desc)."""
    rows = conn.execute('SELECT model FROM models ORDER BY elo DESC, model ASC').fetchall()
    return {r['model']: i + 1 for i, r in enumerate(rows)}


def _insert_match(conn, body, played_at=None):
    """Insert one match, apply incremental ELO, write rating_events + model rows.

    Returns the response payload (same shape the old server produced): per-player
    deltas + winner win-probability, plus the new match id.
    """
    p1, p2, winner = body['p1'], body['p2'], body['winner']
    loser = p2 if winner == p1 else p1
    played_at = played_at or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    m1, m2 = _model_row(conn, p1), _model_row(conn, p2)
    r1, r2 = m1['elo'], m2['elo']
    ranks_before = _rank_map(conn)
    total_before = len(ranks_before)

    e1 = _expected(r1, r2)
    e2 = 1 - e1
    s1 = 1 if winner == p1 else 0
    s2 = 1 - s1
    new_r1 = round(r1 + K_FACTOR * (s1 - e1))
    new_r2 = round(r2 + K_FACTOR * (s2 - e2))

    p1_score = body.get('p1_score', 0) or 0
    p2_score = body.get('p2_score', 0) or 0
    margin = abs((p1_score or 0) - (p2_score or 0))

    cur = conn.execute(
        """INSERT INTO matches
           (played_at, tournament_id, round, mode, format, map_size, map_strategy, rounds,
            p1, p2, p1_score, p2_score, winner, loser, margin, seed)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (played_at, body.get('tournament_id'), body.get('round'),
         body.get('mode', 'standard'), body.get('format'), body.get('map_size'),
         body.get('map_strategy'), body.get('rounds'),
         p1, p2, p1_score, p2_score, winner, loser, margin, body.get('seed')))
    match_id = cur.lastrowid

    _apply_player(conn, match_id, played_at, m1, p2, new_r1, e1, s1 == 1)
    _apply_player(conn, match_id, played_at, m2, p1, new_r2, e2, s2 == 1)

    ranks_after = _rank_map(conn)
    total_after = len(ranks_after)

    def delta(name, before_elo, after_elo):
        return {
            'name': name,
            'eloBefore': before_elo,
            'eloAfter': after_elo,
            'rankBefore': ranks_before.get(name),       # None = wasn't ranked yet
            'rankAfter': ranks_after.get(name, total_after),
            'total': total_after,
        }

    win_prob = _expected(r1 if winner == p1 else r2,
                         r2 if winner == p1 else r1)

    return {
        'match_id': match_id,
        'result': {
            'p1': delta(p1, r1, new_r1),
            'p2': delta(p2, r2, new_r2),
            'winner': winner,
            'winnerWinProb': win_prob,
        },
    }


def _apply_player(conn, match_id, played_at, m, opponent, new_elo, expected, won):
    """Write one rating_event and upsert the model's cached standing."""
    before = m['elo']
    matches = m['matches'] + 1
    wins = m['wins'] + (1 if won else 0)
    losses = m['losses'] + (0 if won else 1)
    if won:
        streak = m['streak'] + 1 if m['streak'] > 0 else 1
    else:
        streak = m['streak'] - 1 if m['streak'] < 0 else -1
    peak_elo = max(m['peak_elo'], new_elo)
    peak_at = played_at if new_elo > m['peak_elo'] else m['peak_at']
    first_seen = m['first_seen'] or played_at

    conn.execute(
        """INSERT INTO rating_events
           (match_id, played_at, model, opponent, result, elo_before, elo_after,
            delta, win_prob, match_number)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (match_id, played_at, m['model'], opponent, 'W' if won else 'L',
         before, new_elo, new_elo - before, expected, matches))

    conn.execute(
        """INSERT INTO models
             (model, elo, peak_elo, peak_at, wins, losses, matches, streak, first_seen, last_seen)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(model) DO UPDATE SET
             elo=excluded.elo, peak_elo=excluded.peak_elo, peak_at=excluded.peak_at,
             wins=excluded.wins, losses=excluded.losses, matches=excluded.matches,
             streak=excluded.streak, last_seen=excluded.last_seen""",
        (m['model'], new_elo, peak_elo, peak_at, wins, losses, matches, streak,
         first_seen, played_at))


# ── public API (used by server.py) ───────────────────────────

def record_match(body):
    """Record a completed match and return the delta/result payload."""
    with _lock:
        conn = _connect()
        out = _insert_match(conn, body)
        conn.commit()
        out['total_matches'] = conn.execute('SELECT COUNT(*) AS c FROM matches').fetchone()['c']
        out['rankings'] = _rankings(conn)
        return out


def get_rankings():
    """Back-compat shape: { name: {elo, wins, losses, matches} } ordered by ELO."""
    with _lock:
        return _rankings(_connect())


def _rankings(conn):
    rows = conn.execute(
        'SELECT model, elo, wins, losses, matches FROM models ORDER BY elo DESC, model ASC'
    ).fetchall()
    return {r['model']: {'elo': r['elo'], 'wins': r['wins'],
                         'losses': r['losses'], 'matches': r['matches']} for r in rows}


def get_history():
    """Back-compat shape for /history: chronological list of match dicts (with
    the new factor fields added — purely additive, old readers ignore them)."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            """SELECT played_at AS timestamp, tournament_id, round, mode, format,
                      map_size, map_strategy, rounds, p1, p2, p1_score, p2_score, winner, loser, margin
               FROM matches ORDER BY id ASC""").fetchall()
        return [dict(r) for r in rows]


def reset():
    """Archive biome.db to a timestamped backup, then recreate an empty store."""
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None
        archived = None
        if os.path.exists(DB_FILE):
            ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
            backup = os.path.join(BASE_DIR, f'biome.{ts}.db.bak')
            try:
                shutil.copy2(DB_FILE, backup)
                archived = os.path.basename(backup)
            except OSError:
                pass
            for ext in ('', '-wal', '-shm'):
                try:
                    os.remove(DB_FILE + ext)
                except OSError:
                    pass
        conn = _connect()
        conn.executescript(SCHEMA)
        conn.commit()
        return {'ok': True, 'archived': archived}


# ── dashboard payload ────────────────────────────────────────

def get_dashboard():
    """One fat payload the live dashboard polls: standings, ELO timelines,
    head-to-head, factor breakdowns, recent matches, and headline highlights."""
    with _lock:
        conn = _connect()
        return {
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'totals': _totals(conn),
            'leaderboard': _leaderboard(conn),
            'timeline': _timeline(conn),
            'head_to_head': _head_to_head(conn),
            'factors': _factors(conn),
            'recent': _recent(conn),
            'match_points': _match_points(conn),
            'highlights': _highlights(conn),
            'vision_ladders': _vision_ladders(conn),
        }


# ── derived per-vision ELO ladders ───────────────────────────
# The canonical `models` ELO mixes every map vision together. These ladders ask a
# narrower question — "how would the table look if only <vision> matches counted?"
# — by replaying just that vision's matches from a fresh 1000 with the same K and
# expected-score formula the live rating uses. Purely derived (no schema, no live
# rating change); recomputed each poll. Match volume is small, so the 3 replays
# are cheap. Shapes mirror _leaderboard()/_timeline() so the client reuses them.

def _vision_ladders(conn):
    # Untagged legacy matches (NULL/'') count as 'mediated' — before per-vision
    # tracking existed the regional-summary (mediated) view was the *only* board
    # presentation, so those matches belong to the default "Standard" ladder.
    effective = "COALESCE(NULLIF(map_strategy, ''), 'mediated')"
    strategies = [r['v'] for r in conn.execute(
        f"SELECT DISTINCT {effective} AS v FROM matches").fetchall()]
    out = {}
    for strat in strategies:
        rows = conn.execute(
            f"""SELECT p1, p2, winner, played_at FROM matches
                WHERE {effective}=? ORDER BY played_at ASC, id ASC""", (strat,)).fetchall()
        out[strat] = _replay_ladder(rows)
    return out


def _replay_ladder(rows):
    elo, peak, wins, losses, games, streak = {}, {}, {}, {}, {}, {}
    timeline = {}
    for r in rows:
        p1, p2, winner = r['p1'], r['p2'], r['winner']
        if not (p1 and p2 and winner):
            continue
        r1 = elo.get(p1, DEFAULT_ELO)
        r2 = elo.get(p2, DEFAULT_ELO)
        e1 = _expected(r1, r2)
        s1 = 1 if winner == p1 else 0
        n1 = round(r1 + K_FACTOR * (s1 - e1))
        n2 = round(r2 + K_FACTOR * ((1 - s1) - (1 - e1)))
        elo[p1], elo[p2] = n1, n2
        for model, won, newr, opp in ((p1, s1 == 1, n1, p2), (p2, s1 == 0, n2, p1)):
            games[model] = games.get(model, 0) + 1
            if won:
                wins[model] = wins.get(model, 0) + 1
                streak[model] = streak.get(model, 0) + 1 if streak.get(model, 0) > 0 else 1
            else:
                losses[model] = losses.get(model, 0) + 1
                streak[model] = streak.get(model, 0) - 1 if streak.get(model, 0) < 0 else -1
            peak[model] = max(peak.get(model, DEFAULT_ELO), newr)
            timeline.setdefault(model, []).append(
                {'n': games[model], 't': r['played_at'], 'elo': newr,
                 'result': 'W' if won else 'L', 'opponent': opp})
    models = sorted(elo.keys(), key=lambda m: (-elo[m], m))
    leaderboard = []
    for i, m in enumerate(models):
        g, w = games.get(m, 0), wins.get(m, 0)
        leaderboard.append({
            'model': m, 'elo': elo[m], 'peak_elo': peak.get(m, DEFAULT_ELO),
            'wins': w, 'losses': losses.get(m, 0), 'matches': g, 'streak': streak.get(m, 0),
            'winrate': round(w / g * 100) if g else 0, 'rank': i + 1,
        })
    return {'leaderboard': leaderboard, 'timeline': timeline}


def _match_points(conn, limit=1500):
    """Compact per-match feed for the particle-field panels (biome scores, match
    conditions, decisiveness). Scores are the players' final ecosystem totals."""
    rows = conn.execute(
        """SELECT winner, loser, p1, p2, p1_score, p2_score, margin,
                  map_size, map_strategy, rounds, mode, played_at
           FROM matches ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
    return [dict(r) for r in rows]


def _totals(conn):
    row = conn.execute(
        """SELECT COUNT(*) AS matches,
                  MIN(played_at) AS first_match,
                  MAX(played_at) AS last_match FROM matches""").fetchone()
    models = conn.execute('SELECT COUNT(*) AS c FROM models').fetchone()['c']
    return {'matches': row['matches'], 'models': models,
            'first_match': row['first_match'], 'last_match': row['last_match']}


def _leaderboard(conn):
    rows = conn.execute(
        """SELECT model, elo, peak_elo, peak_at, wins, losses, matches, streak,
                  first_seen, last_seen
           FROM models ORDER BY elo DESC, model ASC""").fetchall()
    out = []
    for i, r in enumerate(rows):
        d = dict(r)
        d['rank'] = i + 1
        d['winrate'] = round(d['wins'] / d['matches'] * 100) if d['matches'] else 0
        out.append(d)
    return out


def _timeline(conn):
    """model -> [ {n, t, elo, delta, result, opponent}, ... ] in match order."""
    rows = conn.execute(
        """SELECT model, match_number AS n, played_at AS t, elo_after AS elo,
                  delta, result, opponent
           FROM rating_events ORDER BY model ASC, id ASC""").fetchall()
    series = {}
    for r in rows:
        series.setdefault(r['model'], []).append(
            {'n': r['n'], 't': r['t'], 'elo': r['elo'], 'delta': r['delta'],
             'result': r['result'], 'opponent': r['opponent']})
    return series


def _head_to_head(conn):
    """List of {a, b, a_wins, b_wins, games} for every pair that has met."""
    rows = conn.execute('SELECT winner, loser FROM matches').fetchall()
    pairs = {}
    for r in rows:
        w, l = r['winner'], r['loser']
        key = tuple(sorted((w, l)))
        rec = pairs.setdefault(key, {'a': key[0], 'b': key[1], 'a_wins': 0, 'b_wins': 0})
        if w == key[0]:
            rec['a_wins'] += 1
        else:
            rec['b_wins'] += 1
    out = []
    for rec in pairs.values():
        rec['games'] = rec['a_wins'] + rec['b_wins']
        out.append(rec)
    return out


def _factors(conn):
    """Match-factor breakdowns: how do map size / round count / mode shake out."""
    def by(col):
        rows = conn.execute(
            f"""SELECT {col} AS key, COUNT(*) AS matches, AVG(margin) AS avg_margin
                FROM matches WHERE {col} IS NOT NULL
                GROUP BY {col} ORDER BY matches DESC""").fetchall()
        return [{'key': r['key'], 'matches': r['matches'],
                 'avg_margin': round(r['avg_margin'], 1) if r['avg_margin'] is not None else 0}
                for r in rows]
    return {'map_size': by('map_size'), 'rounds': by('rounds'), 'mode': by('mode'),
            'map_strategy': by('map_strategy')}


def _recent(conn, limit=14):
    rows = conn.execute(
        """SELECT m.id, m.played_at, m.mode, m.map_size, m.map_strategy, m.rounds, m.winner, m.loser,
                  m.p1, m.p2, m.p1_score, m.p2_score, m.margin
           FROM matches m ORDER BY m.id DESC LIMIT ?""", (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        ev = conn.execute(
            'SELECT model, delta, elo_after FROM rating_events WHERE match_id=?',
            (r['id'],)).fetchall()
        d['deltas'] = {e['model']: {'delta': e['delta'], 'elo': e['elo_after']} for e in ev}
        out.append(d)
    return out


def get_matches(limit=2000):
    """Full match log (most-recent first) with per-player ELO deltas. Powers the
    expandable match-log detail view — same row shape as _recent, just unbounded."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            """SELECT id, played_at, mode, map_size, map_strategy, rounds, format, tournament_id,
                      round, winner, loser, p1, p2, p1_score, p2_score, margin
               FROM matches ORDER BY id DESC LIMIT ?""", (limit,)).fetchall()
        ids = [r['id'] for r in rows]
        ev_by_match = {}
        if ids:
            placeholders = ','.join('?' * len(ids))
            for e in conn.execute(
                f"""SELECT match_id, model, delta, elo_after
                    FROM rating_events WHERE match_id IN ({placeholders})""", ids).fetchall():
                ev_by_match.setdefault(e['match_id'], {})[e['model']] = {
                    'delta': e['delta'], 'elo': e['elo_after']}
        out = []
        for r in rows:
            d = dict(r)
            d['deltas'] = ev_by_match.get(r['id'], {})
            out.append(d)
        return out


# ── tournament history ───────────────────────────────────────
# Brackets are reconstructable from `matches`: every tournament match carries
# `tournament_id` and `round` — where `round` is the FLAT bracket index the
# client posts (match.id: 0..N-1 across the whole tree), not the depth. A clean
# single-elim bracket of P players has N = P-1 matches; the flat indices fill the
# rounds in order (P/2 quarter-type matches, then P/4, … then 1 final). We use
# that to derive each match's depth and "participants entering" for placement.

def _participants_at(flat_index, total_matches):
    """Players entering the round that the flat-index match belongs to (8→QF,
    4→SF, 2→Final). Returns None when the tournament isn't a clean power-of-two
    single-elim bracket (then callers fall back to a flat, untiered view)."""
    P = total_matches + 1
    if P < 2 or (P & (P - 1)) != 0:
        return None
    boundary = 0
    participants = P
    while participants >= 2:
        matches_in_round = participants // 2
        if flat_index < boundary + matches_in_round:
            return participants
        boundary += matches_in_round
        participants //= 2
    return 2


def _placement_label(participants):
    """Human label for being eliminated in the round of `participants`."""
    return {2: 'Runner-up', 4: 'Semi-finalist', 8: 'Quarter-finalist'}.get(
        participants, f'Round of {participants}')


def get_tournaments(limit=100):
    """One row per real tournament (a multi-match bracket — single ranked games
    carry a one-off id and a single match, filtered out here): champion, when it
    ran, format/mode, and how many distinct models competed. Newest first."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            """SELECT tournament_id,
                      MIN(played_at) AS started_at,
                      MAX(played_at) AS played_at,
                      COUNT(*)       AS match_count,
                      MAX(format)    AS format,
                      MAX(mode)      AS mode
               FROM matches
               WHERE tournament_id IS NOT NULL
               GROUP BY tournament_id
               HAVING match_count > 1
               ORDER BY played_at DESC
               LIMIT ?""", (limit,)).fetchall()
        out = []
        for r in rows:
            tid = r['tournament_id']
            final = conn.execute(
                """SELECT winner FROM matches
                   WHERE tournament_id=? ORDER BY round DESC, id DESC LIMIT 1""",
                (tid,)).fetchone()
            model_count = conn.execute(
                """SELECT COUNT(*) AS c FROM
                       (SELECT p1 AS m FROM matches WHERE tournament_id=?
                        UNION SELECT p2 FROM matches WHERE tournament_id=?)""",
                (tid, tid)).fetchone()['c']
            out.append({
                'tournament_id': tid,
                'champion': final['winner'] if final else None,
                'started_at': r['started_at'],
                'played_at': r['played_at'],
                'match_count': r['match_count'],
                'model_count': model_count,
                'format': r['format'],
                'mode': r['mode'],
            })
        return out


def get_tournament(tournament_id):
    """One tournament's matches in bracket order, each with the ELO both players
    carried into the match → out of it (from rating_events). Shaped so the client
    can feed it straight into the match dashboard. Rank-at-time isn't stored, so
    the per-side rank fields are null (historical views show ELO + delta only)."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            """SELECT id, played_at, round, mode, format, map_size, map_strategy,
                      rounds, p1, p2, p1_score, p2_score, winner, loser, margin, seed
               FROM matches WHERE tournament_id=?
               ORDER BY round ASC, id ASC""", (tournament_id,)).fetchall()
        if not rows:
            return {'tournament_id': tournament_id, 'found': False, 'matches': []}

        ids = [r['id'] for r in rows]
        ev_by_match = {}
        placeholders = ','.join('?' * len(ids))
        for e in conn.execute(
            f"""SELECT match_id, model, elo_before, elo_after, delta, win_prob
                FROM rating_events WHERE match_id IN ({placeholders})""", ids).fetchall():
            ev_by_match.setdefault(e['match_id'], {})[e['model']] = {
                'eloBefore': e['elo_before'], 'eloAfter': e['elo_after'],
                'delta': e['delta'], 'winProb': e['win_prob']}

        total = len(rows)
        matches = []
        for r in rows:
            d = dict(r)
            ev = ev_by_match.get(r['id'], {})

            def side(name):
                s = ev.get(name)
                return {'name': name, 'eloBefore': s['eloBefore'], 'eloAfter': s['eloAfter'],
                        'rankBefore': None, 'rankAfter': None} if s else \
                       {'name': name, 'eloBefore': None, 'eloAfter': None,
                        'rankBefore': None, 'rankAfter': None}

            d['eloResult'] = {'winner': r['winner'], 'p1': side(r['p1']), 'p2': side(r['p2'])}
            d['participants'] = _participants_at(r['round'], total)
            matches.append(d)

        final = matches[-1] if matches else None
        return {
            'tournament_id': tournament_id,
            'found': True,
            'champion': final['winner'] if final else None,
            'match_count': total,
            'matches': matches,
        }


def get_model_tournaments(name, limit=12):
    """The tournaments a model competed in, newest first, with how far it got
    (Champion / Runner-up / Semi-finalist / …) and its win count that bracket.
    Powers the 'Recent Tournaments' strip on the model's profile card."""
    with _lock:
        conn = _connect()
        tids = conn.execute(
            """SELECT tournament_id, MAX(played_at) AS played_at, COUNT(*) AS match_count
               FROM matches
               WHERE tournament_id IS NOT NULL AND (p1=? OR p2=?)
               GROUP BY tournament_id
               HAVING (SELECT COUNT(*) FROM matches m2 WHERE m2.tournament_id = matches.tournament_id) > 1
               ORDER BY played_at DESC
               LIMIT ?""", (name, name, limit)).fetchall()
        out = []
        for t in tids:
            tid = t['tournament_id']
            total = conn.execute(
                'SELECT COUNT(*) AS c FROM matches WHERE tournament_id=?', (tid,)).fetchone()['c']
            final = conn.execute(
                """SELECT winner FROM matches
                   WHERE tournament_id=? ORDER BY round DESC, id DESC LIMIT 1""",
                (tid,)).fetchone()
            champion = final['winner'] if final else None
            model_count = conn.execute(
                """SELECT COUNT(*) AS c FROM
                       (SELECT p1 AS m FROM matches WHERE tournament_id=?
                        UNION SELECT p2 FROM matches WHERE tournament_id=?)""",
                (tid, tid)).fetchone()['c']
            # The model's matches in this bracket; its last (highest flat index)
            # is where its run ended.
            mine = conn.execute(
                """SELECT round, winner FROM matches
                   WHERE tournament_id=? AND (p1=? OR p2=?)
                   ORDER BY round ASC""", (tid, name, name)).fetchall()
            wins = sum(1 for r in mine if r['winner'] == name)
            if champion == name:
                placement = 'Champion'
            elif mine:
                exit_round = mine[-1]['round']
                participants = _participants_at(exit_round, total)
                placement = _placement_label(participants) if participants else 'Competed'
            else:
                placement = 'Competed'
            out.append({
                'tournament_id': tid,
                'played_at': t['played_at'],
                'champion': champion,
                'model_count': model_count,
                'match_count': total,
                'wins': wins,
                'placement': placement,
                'is_champion': champion == name,
            })
        return out


def get_model_detail(name):
    """Everything about one model for the drill-in view: standing + rank, the full
    ELO timeline, every match it played, head-to-head splits vs each opponent, and
    win/loss splits by mode / map size / round count."""
    with _lock:
        conn = _connect()
        row = conn.execute('SELECT * FROM models WHERE model=?', (name,)).fetchone()
        if not row:
            return {'model': name, 'found': False}
        m = dict(row)
        m['found'] = True
        m['winrate'] = round(m['wins'] / m['matches'] * 100) if m['matches'] else 0
        m['rank'] = conn.execute(
            'SELECT COUNT(*)+1 AS r FROM models WHERE elo > ? OR (elo = ? AND model < ?)',
            (m['elo'], m['elo'], name)).fetchone()['r']

        m['timeline'] = [dict(r) for r in conn.execute(
            """SELECT match_number AS n, played_at AS t, elo_after AS elo, delta,
                      result, opponent, win_prob, elo_before
               FROM rating_events WHERE model=? ORDER BY id ASC""", (name,)).fetchall()]

        match_rows = conn.execute(
            """SELECT id, played_at, mode, map_size, map_strategy, rounds, winner, loser,
                      p1, p2, p1_score, p2_score, margin
               FROM matches WHERE p1=? OR p2=? ORDER BY id DESC""", (name, name)).fetchall()
        matches, h2h = [], {}
        for r in match_rows:
            d = dict(r)
            ev = conn.execute(
                'SELECT model, delta, elo_after FROM rating_events WHERE match_id=?',
                (r['id'],)).fetchall()
            d['deltas'] = {e['model']: {'delta': e['delta'], 'elo': e['elo_after']} for e in ev}
            matches.append(d)
            won = r['winner'] == name
            opp = r['loser'] if won else r['winner']
            rec = h2h.setdefault(opp, {'opponent': opp, 'wins': 0, 'losses': 0})
            rec['wins' if won else 'losses'] += 1
        m['matches_log'] = matches
        for rec in h2h.values():
            g = rec['wins'] + rec['losses']
            rec['games'] = g
            rec['winrate'] = round(rec['wins'] / g * 100) if g else 0
        m['h2h'] = sorted(h2h.values(), key=lambda x: (-x['games'], -x['winrate']))

        def split(col):
            # avg_score = this model's own biome (ecosystem) score in those matches —
            # a magnitude that scales with the board, so it's the meaningful vertical
            # for map size (the win/loss winrate stays the read for the other splits).
            rows = conn.execute(
                f"""SELECT {col} AS key,
                          SUM(CASE WHEN winner=? THEN 1 ELSE 0 END) AS wins,
                          COUNT(*) AS games,
                          AVG(CASE WHEN p1=? THEN p1_score ELSE p2_score END) AS avg_score
                    FROM matches WHERE (p1=? OR p2=?) AND {col} IS NOT NULL
                    GROUP BY {col} ORDER BY games DESC""", (name, name, name, name)).fetchall()
            return [{'key': r['key'], 'wins': r['wins'], 'games': r['games'],
                     'winrate': round(r['wins'] / r['games'] * 100) if r['games'] else 0,
                     'avg_score': round(r['avg_score']) if r['avg_score'] is not None else 0}
                    for r in rows]
        m['splits'] = {'mode': split('mode'), 'map_size': split('map_size'), 'rounds': split('rounds'),
                       'map_strategy': split('map_strategy')}
        return m


def _highlights(conn):
    """Headline moments for the overview cards."""
    out = {}
    # Biggest upset: win by the largest negative-favoured underdog (lowest win_prob win).
    up = conn.execute(
        """SELECT model, opponent, win_prob, delta, played_at
           FROM rating_events WHERE result='W' ORDER BY win_prob ASC LIMIT 1""").fetchone()
    out['biggest_upset'] = dict(up) if up else None
    # Most improved: largest gain from first ELO event to current.
    rows = conn.execute(
        """SELECT model, elo, peak_elo, matches FROM models WHERE matches > 0""").fetchall()
    best = None
    for r in rows:
        gain = r['elo'] - DEFAULT_ELO
        if best is None or gain > best['gain']:
            best = {'model': r['model'], 'gain': gain, 'elo': r['elo'], 'matches': r['matches']}
    out['most_improved'] = best
    # Longest active streak (wins).
    st = conn.execute(
        'SELECT model, streak, elo FROM models ORDER BY streak DESC LIMIT 1').fetchone()
    out['hot_streak'] = dict(st) if st and st['streak'] > 1 else None
    # Highest peak ELO ever reached.
    pk = conn.execute(
        'SELECT model, peak_elo, peak_at FROM models ORDER BY peak_elo DESC LIMIT 1').fetchone()
    out['peak'] = dict(pk) if pk else None
    return out
