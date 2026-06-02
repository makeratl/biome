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
        conn.commit()
        count = conn.execute('SELECT COUNT(*) AS c FROM matches').fetchone()['c']
        if count == 0 and os.path.exists(LEGACY_LOG):
            _migrate_legacy(conn)


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
           (played_at, tournament_id, round, mode, format, map_size, rounds,
            p1, p2, p1_score, p2_score, winner, loser, margin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (played_at, body.get('tournament_id'), body.get('round'),
         body.get('mode', 'standard'), body.get('format'), body.get('map_size'),
         body.get('rounds'), p1, p2, p1_score, p2_score, winner, loser, margin))
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
                      map_size, rounds, p1, p2, p1_score, p2_score, winner, loser, margin
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
        }


def _match_points(conn, limit=1500):
    """Compact per-match feed for the particle-field panels (biome scores, match
    conditions, decisiveness). Scores are the players' final ecosystem totals."""
    rows = conn.execute(
        """SELECT winner, loser, p1, p2, p1_score, p2_score, margin,
                  map_size, rounds, mode, played_at
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
    return {'map_size': by('map_size'), 'rounds': by('rounds'), 'mode': by('mode')}


def _recent(conn, limit=14):
    rows = conn.execute(
        """SELECT m.id, m.played_at, m.mode, m.map_size, m.rounds, m.winner, m.loser,
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
            """SELECT id, played_at, mode, map_size, rounds, format, tournament_id,
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
            """SELECT id, played_at, mode, map_size, rounds, winner, loser,
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
            rows = conn.execute(
                f"""SELECT {col} AS key,
                          SUM(CASE WHEN winner=? THEN 1 ELSE 0 END) AS wins,
                          COUNT(*) AS games
                    FROM matches WHERE (p1=? OR p2=?) AND {col} IS NOT NULL
                    GROUP BY {col} ORDER BY games DESC""", (name, name, name)).fetchall()
            return [{'key': r['key'], 'wins': r['wins'], 'games': r['games'],
                     'winrate': round(r['wins'] / r['games'] * 100) if r['games'] else 0}
                    for r in rows]
        m['splits'] = {'mode': split('mode'), 'map_size': split('map_size'), 'rounds': split('rounds')}
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
