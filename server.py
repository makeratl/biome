#!/usr/bin/env python3
"""HTTP server with Ollama proxy for CORS bypass and tournament logging."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs, unquote
import urllib.request
import urllib.error
import json
import os
import re
import time
import uuid
import subprocess
import threading
import ipaddress
import collections
import signal
import sys

import db
import traj

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# --- Avatar generation (ComfyUI bridge) ---
COMFY_URL = 'http://localhost:8188'
AVATARS_DIR = os.path.join(BASE_DIR, 'avatars')
MANIFEST_FILE = os.path.join(AVATARS_DIR, 'manifest.json')
WORKFLOW_FILE = os.path.join(BASE_DIR, 'comfy_avatar_workflow.json')
_SLUG = re.compile(r'^[a-z0-9-]+$')
_manifest_lock = threading.Lock()

# --- Training-data capture (Training Lab) ---
# Per-turn trajectories + per-round reward signals stream here as newline-
# delimited JSON; match outcomes are stamped by the tournament-result handler.
# Append-only, one lock so concurrent matches (tournament threads) don't interleave.
TRAINING_DIR = os.path.join(BASE_DIR, 'training-data')
_traj_lock = threading.Lock()

def _traj_append(filename, record):
    try:
        os.makedirs(TRAINING_DIR, exist_ok=True)
        line = json.dumps(record, separators=(',', ':')) + '\n'
        with _traj_lock:
            with open(os.path.join(TRAINING_DIR, filename), 'a', encoding='utf-8') as f:
                f.write(line)
        return True
    except Exception:
        return False

# --- Out-of-process heartbeat (renderer-crash forensics) ---
# A renderer SIGILL ("Aw, Snap!") wipes the in-page console, so no in-browser log
# can ever report the tab's own death. Instead the driving browser POSTs a tiny
# vitals packet every second (heap, DOM node count, match #) to /heartbeat and we
# append it here, flushing on every write (open→append→close). When the tab dies,
# the LAST line on disk is the final moment before death; the gap where beats stop
# marks WHEN, and the heap/DOM trend up to it marks WHY. Survives the crash because
# it lives entirely outside the renderer. Tail with: tail -f dev-logs/heartbeat.log
HEARTBEAT_DIR = os.path.join(BASE_DIR, 'dev-logs')
HEARTBEAT_FILE = os.path.join(HEARTBEAT_DIR, 'heartbeat.log')
_heartbeat_lock = threading.Lock()

def _heartbeat_append(record):
    try:
        os.makedirs(HEARTBEAT_DIR, exist_ok=True)
        record['server_ts'] = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime())
        line = json.dumps(record, separators=(',', ':')) + '\n'
        with _heartbeat_lock:
            with open(HEARTBEAT_FILE, 'a', encoding='utf-8') as f:
                f.write(line)
                f.flush()
                os.fsync(f.fileno())   # force to disk so a hard crash can't lose the last beat
        return True
    except Exception:
        return False

# --- Live tournament relay (Spectator view) ---
# The server is otherwise blind to in-progress tournaments — it only sees a match
# once it's over (POST /tournament-result). The spectator page lives on a different
# machine (public DNS), so browser-local channels are out: the driving browser
# pushes a live snapshot + periodic board image here, and spectators poll it.
# Ephemeral, in-memory only — no DB. Lock-guarded (ThreadingHTTPServer).
_LIVE_LOCK = threading.Lock()
_LIVE = {'snapshot': None, 'board': None, 'board_ct': 'image/webp',
         'board_rev': 0, 'updated': 0.0, 'done': False,
         # Cached terrain from the last board KEYFRAME (full board). The driver
         # sends terrain once per match then organisms-only; we splice this back in
         # so every served snapshot carries a complete board (robust to late joiners).
         'terrain': None,
         # Per-step growth stream: a small ring of recent { seq, board } frames the
         # driver pushes each simulation step, drained by spectators (since-seq) to
         # ANIMATE the 2s growth cycle. Bounded — a slow spectator just resyncs to latest.
         'frames': collections.deque(maxlen=64), 'frame_seq': 0}
LIVE_STALE_S = 75   # no push in this long ⇒ driver gone ⇒ treat as idle


def _splice_board_terrain(snap):
    """Terrain travels once per match (a 'full' board keyframe), organisms every
    push. Cache the keyframe's terrain and splice it into organism-only boards so
    every STORED/served snapshot is terrain-complete — a late joiner or a poll
    between keyframes still gets a full board. Mutates snap['board'] in place.
    Call under _LIVE_LOCK."""
    board = snap.get('board') if isinstance(snap, dict) else None
    if not isinstance(board, dict):
        return
    cells = board.get('cells')
    if not isinstance(cells, list):
        return
    if board.get('full'):
        # Keyframe: cache terrain keyed by (col, row).
        _LIVE['terrain'] = {(c['c'], c['r']): c['t'] for c in cells
                            if isinstance(c, dict) and 't' in c}
        return
    terr = _LIVE.get('terrain')
    if not terr:
        return   # no keyframe seen yet — serve the organisms-only board as-is
    # Organisms-only push: rebuild a complete board = cached terrain + live organisms.
    org = {(c['c'], c['r']): c['o'] for c in cells
           if isinstance(c, dict) and 'o' in c and 'c' in c and 'r' in c}
    merged = []
    for (cc, rr), t in terr.items():
        cell = {'c': cc, 'r': rr, 't': t}
        o = org.get((cc, rr))
        if o:
            cell['o'] = o
        merged.append(cell)
    board['cells'] = merged
    board['full'] = True


# ── Headless tournament scheduler ────────────────────────────────────────────
# Runs scheduled/queued tournaments ONE AT A TIME by spawning the headless runner
# (tools/run-tournament.mjs), which drives a dedicated Chromium through one
# tournament. The browser game posts results to /tournament-result and feeds the
# live relay exactly as a human-operated tab would, so the scheduler only manages
# lifecycle — it never touches game logic. Control plane is LAN-only (do_POST is
# IP-gated; GET /tournament/jobs is off the public allowlist).
_HERE = os.path.dirname(os.path.abspath(__file__))
SCHED_FILE = os.path.join(_HERE, 'tournament-schedule.json')
RUNNER = os.path.join(_HERE, 'tools', 'run-tournament.mjs')
_SCHED_LOCK = threading.Lock()
_SCHED = {
    'queue': [],     # pending jobs (dicts)
    'running': None, # the job currently executing
    'recent': collections.deque(maxlen=20),
    'schedules': [], # persisted recurring/future specs
    'proc': None,    # the running subprocess.Popen
    'cancel': set(), # job ids asked to cancel
}
_job_seq = 0

def _norm_cfg(body):
    """Clamp/normalize a tournament config from an API body."""
    fmts = {'seeded', 'qualifier', 'champions', 'davidGoliath', 'open', 'locals'}
    fmt = str(body.get('format', 'seeded'))
    if fmt not in fmts:
        fmt = 'seeded'
    size = int(body.get('size', 8))
    size = 4 if size < 4 else (32 if size > 32 else size)
    rounds = int(body.get('rounds', 10))
    rounds = 1 if rounds < 1 else (50 if rounds > 50 else rounds)
    return {'size': size, 'format': fmt, 'rounds': rounds,
            'mapStrategy': str(body.get('mapStrategy', 'mediated'))}

def _new_job(cfg, source='manual'):
    global _job_seq
    _job_seq += 1
    return {'id': 'job-%d-%d' % (int(time.time()), _job_seq), 'status': 'queued',
            'config': cfg, 'source': source, 'created': time.time(),
            'started': None, 'finished': None, 'exit': None,
            'champion': None, 'error': None}

def _load_schedules():
    try:
        with open(SCHED_FILE) as f:
            data = json.load(f)
        with _SCHED_LOCK:
            _SCHED['schedules'] = data.get('schedules', [])
    except Exception:
        pass

def _save_schedules():
    try:
        with _SCHED_LOCK:
            data = {'schedules': list(_SCHED['schedules'])}
        with open(SCHED_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass

def _schedule_due(s, now):
    """Has this recurring/future schedule come due since it last fired?"""
    w = s.get('when', {})
    last = s.get('last_fired') or 0
    kind = w.get('kind')
    if kind == 'interval':
        return (now - last) >= max(1, int(w.get('hours', 6))) * 3600
    if kind == 'daily':
        try:
            hh, mm = [int(x) for x in str(w.get('time', '09:00')).split(':')]
        except Exception:
            hh, mm = 9, 0
        lt = time.localtime(now)
        target = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, hh, mm, 0, 0, 0, -1))
        last_day = time.localtime(last).tm_yday if last else -1
        return now >= target and last_day != lt.tm_yday
    return False

def _kill_proc(proc):
    """Kill the runner AND its Chromium children (it's a session leader)."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

def _parse_runner_result(out):
    for line in reversed((out or '').splitlines()):
        if line.startswith('RESULT '):
            try:
                return json.loads(line[7:])
            except Exception:
                return {}
    return {}

def _run_job(job):
    cfg = job['config']
    # Generous backstop; the per-match watchdog (tournament.js) already force-resolves
    # stuck matches, and the runner has its own --timeout — this is the outer reap.
    timeout_s = cfg['rounds'] * cfg['size'] * 60 + 600
    with _SCHED_LOCK:
        job['status'] = 'running'
        job['started'] = time.time()
        _SCHED['running'] = job
    cmd = ['node', RUNNER, '--size', str(cfg['size']), '--format', cfg['format'],
           '--rounds', str(cfg['rounds']), '--map-strategy', cfg['mapStrategy'],
           '--server', 'http://localhost:8765', '--timeout', str(timeout_s)]
    proc = None
    try:
        proc = subprocess.Popen(cmd, cwd=_HERE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, start_new_session=True)
        with _SCHED_LOCK:
            _SCHED['proc'] = proc
        t0 = time.time()
        while proc.poll() is None:
            if time.time() - t0 > timeout_s + 120:
                _kill_proc(proc)
                job['error'] = 'timed out'
                break
            if job['id'] in _SCHED['cancel']:
                _kill_proc(proc)
                job['error'] = 'cancelled'
                break
            time.sleep(2)
        out = proc.stdout.read().decode('utf-8', 'replace') if proc.stdout else ''
        result = _parse_runner_result(out)
        job['exit'] = proc.returncode
        job['champion'] = result.get('champion')
        if proc.returncode == 0 and not job['error']:
            job['status'] = 'done'
        else:
            job['status'] = 'failed'
            if not job['error']:
                job['error'] = result.get('error') or ('exit %s' % proc.returncode)
    except Exception as e:
        job['status'] = 'failed'
        job['error'] = str(e)
        if proc:
            _kill_proc(proc)
    finally:
        job['finished'] = time.time()
        with _SCHED_LOCK:
            _SCHED['running'] = None
            _SCHED['proc'] = None
            _SCHED['cancel'].discard(job['id'])
            _SCHED['recent'].appendleft(job)

def _scheduler_tick():
    now = time.time()
    fired = False
    with _SCHED_LOCK:
        scheds = list(_SCHED['schedules'])
    for s in scheds:
        if _schedule_due(s, now):
            with _SCHED_LOCK:
                _SCHED['queue'].append(_new_job(s['config'], source=s['id']))
                s['last_fired'] = now
            fired = True
    if fired:
        _save_schedules()
    with _SCHED_LOCK:
        job = _SCHED['queue'].pop(0) if (_SCHED['running'] is None and _SCHED['queue']) else None
    if job:
        _run_job(job)   # blocks until this tournament finishes (we run one at a time)

def _scheduler_loop():
    _load_schedules()
    while True:
        try:
            _scheduler_tick()
        except Exception as e:
            sys.stderr.write('[sched] tick error: %s\n' % e)
        time.sleep(5)


# --- Public exposure: trust by source IP, not a global flag ---
# This server is meant to sit behind a single port-forward (WAN :8765 → box),
# so ONE process must serve anonymous spectators AND accept the live push from
# the LAN driver. A process-global switch can't do both. Instead we trust by
# source address: requests from loopback/private ranges (you, on the LAN) get
# full access; everything from the open internet is restricted to a read-only
# spectator allowlist — the Ollama proxy, /reset-rankings, the DB, and every
# write are simply never reachable from the WAN.
#
# A home router's DNAT preserves the real client IP, so client_address cleanly
# distinguishes LAN from WAN. BIOME_PUBLIC remains as an optional override that
# forces read-only even for LAN clients (useful for testing the public face).
PUBLIC_MODE = os.environ.get('BIOME_PUBLIC', '').lower() in ('1', 'true', 'yes')

def _is_trusted_addr(host):
    """True for loopback + RFC1918 private clients (the LAN driver)."""
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_loopback or ip.is_private or ip.is_link_local
    except ValueError:
        return False

# Exact GET endpoints a spectator needs (queries allowed via prefix match).
_PUBLIC_GET_ENDPOINTS = (
    '/tournament/live/frames', '/tournament/live/board', '/tournament/live', '/tournament', '/tournaments',
    '/rankings', '/stats/matches', '/stats/dashboard',
)
# Static asset path prefixes the spectator page pulls in (its JS/CSS/avatars).
_PUBLIC_STATIC_PREFIXES = ('/js/', '/avatars/', '/assets/')
# Exact files allowed even though the blanket .json/.db rule would block them —
# the avatar/video manifests are harmless lookups the page needs.
_PUBLIC_STATIC_FILES = ('/spectator.html', '/style.css', '/favicon.ico',
                        '/avatars/manifest.json', '/videos/manifest.json')

def _public_get_allowed(path):
    # Decode + normalize FIRST so traversal can't sneak a sensitive file past
    # the prefix match. '/js/../server.py' (or its %2e%2e-encoded form, which the
    # static handler unquotes after this check) would otherwise pass '/js/' and
    # resolve to source on disk. Match translate_path: unquote, then collapse
    # '..' with normpath; refuse anything that still escapes root.
    clean = unquote(path.split('?', 1)[0]).replace('\\', '/')
    clean = os.path.normpath(clean)
    if not clean.startswith('/') or '..' in clean.split('/'):
        return False
    if clean in _PUBLIC_STATIC_FILES:
        return True
    if any(clean.startswith(p) for p in _PUBLIC_STATIC_PREFIXES):
        # ...but never data files that happen to sit under an allowed prefix.
        return not clean.endswith(('.db', '.jsonl', '.json'))
    return any(clean == e or clean.startswith(e) for e in _PUBLIC_GET_ENDPOINTS)

def _load_manifest():
    try:
        with open(MANIFEST_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

def _save_manifest(data):
    with open(MANIFEST_FILE, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')

def _comfy_generate(key, style, prompt, negative, lora, seed):
    """Submit one avatar job to ComfyUI, wait for it, resize + save into
    avatars/<style>/<key>.png, and record it in the manifest. Mirrors the exact
    graph the MCP used (comfy_avatar_workflow.json); we only inject per-request
    fields: positive (6), negative (7), style LoRA (14), seed (3), filename (9)."""
    with open(WORKFLOW_FILE) as f:
        graph = json.load(f)
    graph['6']['inputs']['text'] = prompt
    graph['7']['inputs']['text'] = negative
    graph['14']['inputs']['lora_name'] = lora
    graph['3']['inputs']['seed'] = int(seed)
    graph['9']['inputs']['filename_prefix'] = f'biome-avatar-{style}-{key}'

    payload = json.dumps({'prompt': graph}).encode()
    req = urllib.request.Request(f'{COMFY_URL}/prompt', data=payload,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        pid = json.load(r)['prompt_id']

    img, t0 = None, time.time()
    while time.time() - t0 < 180:
        time.sleep(1)
        try:
            with urllib.request.urlopen(f'{COMFY_URL}/history/{pid}', timeout=10) as r:
                hist = json.load(r)
        except Exception:
            continue
        if pid in hist:
            if hist[pid].get('status', {}).get('status_str') == 'error':
                raise RuntimeError('ComfyUI reported a generation error')
            imgs = hist[pid].get('outputs', {}).get('9', {}).get('images', [])
            if imgs:
                img = imgs[0]
                break
    if not img:
        raise RuntimeError('generation timed out')

    q = urlencode({'filename': img['filename'], 'subfolder': img.get('subfolder', ''),
                   'type': img.get('type', 'output')})
    with urllib.request.urlopen(f'{COMFY_URL}/view?{q}', timeout=30) as r:
        raw = r.read()

    out_dir = os.path.join(AVATARS_DIR, style)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{key}.png')
    try:
        subprocess.run(['convert', 'png:-', '-resize', '512x512', '-strip', out_path],
                       input=raw, capture_output=True, check=True)
    except Exception:
        with open(out_path, 'wb') as f:  # fallback: full-size if imagemagick is missing
            f.write(raw)

    rel = f'avatars/{style}/{key}.png'
    with _manifest_lock:
        manifest = _load_manifest()
        manifest.setdefault(style, {})[key] = rel
        _save_manifest(manifest)
    return {'ok': True, 'key': key, 'style': style, 'path': rel,
            'prompt_id': pid, 'seconds': round(time.time() - t0, 1)}

# --- Avatar animation (ComfyUI WAN 2.2 image-to-video bridge) ---
# A baked still (avatars/cyber-organic/<key>.png) is the I2V start frame; a motion
# prompt drives a short victory/defeat clip. Same submit→poll→save shape as the
# avatar bridge, but the WAN graphs differ, so each carries a node-id map for the
# injectable fields. Output is already h264 mp4, so we save the bytes verbatim.
VIDEOS_DIR = os.path.join(BASE_DIR, 'videos')
VIDEO_MANIFEST_FILE = os.path.join(VIDEOS_DIR, 'manifest.json')
OVERRIDES_FILE = os.path.join(AVATARS_DIR, 'lab-overrides.json')
VIDEO_CATEGORIES = ('intro', 'idle', 'thinking', 'victory', 'defeat', 'champion')
OVERRIDE_KINDS = ('still',) + VIDEO_CATEGORIES
VIDEO_WORKFLOWS = {
    'fast':    {'file': os.path.join(BASE_DIR, 'comfy_video_fast.json'),
                'image': '1', 'positive': '27', 'negative': '28', 'seed': '30', 'save': '34'},
    'quality': {'file': os.path.join(BASE_DIR, 'comfy_video_quality.json'),
                'image': '1', 'positive': '25', 'negative': '26', 'seed': '28', 'save': '32'},
}
_video_manifest_lock = threading.Lock()
_overrides_lock = threading.Lock()

def _load_video_manifest():
    try:
        with open(VIDEO_MANIFEST_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

def _save_video_manifest(data):
    os.makedirs(VIDEOS_DIR, exist_ok=True)
    with open(VIDEO_MANIFEST_FILE, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')

def _load_overrides():
    try:
        with open(OVERRIDES_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

def _save_override(kind, key, text):
    """Persist (or, on empty text, clear) one per-key prompt override so the lab
    reloads the edit next session. Returns the full overrides map."""
    with _overrides_lock:
        data = _load_overrides()
        bucket = data.setdefault(kind, {})
        if text and text.strip():
            bucket[key] = text
        else:
            bucket.pop(key, None)
        with open(OVERRIDES_FILE, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
    return data

def _save_identity(key, label, archetype, motif):
    """Persist (or, when all fields are blank, clear) a per-key creature identity
    override into the `identity` bucket of lab-overrides.json. Stores only the
    non-empty fields so a partial rename doesn't wipe the others on reload."""
    with _overrides_lock:
        data = _load_overrides()
        bucket = data.setdefault('identity', {})
        entry = {}
        if label and label.strip():
            entry['label'] = label.strip()
        if archetype and archetype.strip():
            entry['archetype'] = archetype.strip()
        if motif and motif.strip():
            entry['motif'] = motif.strip()
        if entry:
            bucket[key] = entry
        else:
            bucket.pop(key, None)
        with open(OVERRIDES_FILE, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
    return data

# --- Model roster (active vs retired) ---
# The bench is a roster decision orthogonal to ELO (which lives in biome.db), so
# it persists in its own file rather than on the models table — that table only
# has rows for models that have actually played. Shape: {"retired": [<full ollama
# name>, ...]}. Retiring a model excludes it from tournament fields and the AI
# opponent pickers (enforced client-side) while keeping its weights and history.
ROSTER_FILE = os.path.join(BASE_DIR, 'model-roster.json')
_roster_lock = threading.Lock()

def _load_roster():
    try:
        with open(ROSTER_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get('retired'), list):
            return {'retired': [m for m in data['retired'] if m]}
    except (OSError, json.JSONDecodeError):
        pass
    return {'retired': []}

def _save_roster_entry(model, retired):
    """Add or remove a model from the retired list, then persist. Returns the
    updated roster dict."""
    with _roster_lock:
        data = _load_roster()
        cur = [m for m in data['retired'] if m != model]
        if retired:
            cur.append(model)
        data = {'retired': sorted(set(cur))}
        with open(ROSTER_FILE, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
    return data

def _comfy_upload_image(path):
    """Upload a local PNG into ComfyUI's input dir so a LoadImage node can read it.
    Returns the stored name (subfolder-prefixed if any)."""
    with open(path, 'rb') as f:
        data = f.read()
    boundary = uuid.uuid4().hex
    fname = os.path.basename(path)
    body = b''.join([
        f'--{boundary}\r\n'.encode(),
        f'Content-Disposition: form-data; name="image"; filename="{fname}"\r\n'.encode(),
        b'Content-Type: image/png\r\n\r\n', data, b'\r\n',
        f'--{boundary}\r\n'.encode(),
        b'Content-Disposition: form-data; name="overwrite"\r\n\r\n', b'true\r\n',
        f'--{boundary}--\r\n'.encode(),
    ])
    req = urllib.request.Request(f'{COMFY_URL}/upload/image', data=body,
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
                                 method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)
    name = res['name']
    return f"{res['subfolder']}/{name}" if res.get('subfolder') else name

def _comfy_animate(key, category, prompt, negative, workflow, seed):
    """Animate the baked still for <key> into videos/<category>/<key>.mp4 via WAN
    i2v, and record it in the video manifest. Injects per-request fields into the
    chosen graph using its node-id map; the still is uploaded to ComfyUI first."""
    wf = VIDEO_WORKFLOWS[workflow]
    still = os.path.join(AVATARS_DIR, 'cyber-organic', f'{key}.png')
    if not os.path.exists(still):
        raise FileNotFoundError(f'no baked still for "{key}" — generate the avatar first')

    img_name = _comfy_upload_image(still)
    with open(wf['file']) as f:
        graph = json.load(f)
    graph[wf['image']]['inputs']['image'] = img_name
    graph[wf['positive']]['inputs']['text'] = prompt
    if negative:                                   # else keep the graph's WAN default
        graph[wf['negative']]['inputs']['text'] = negative
    graph[wf['seed']]['inputs']['noise_seed'] = int(seed)
    graph[wf['save']]['inputs']['filename_prefix'] = f'biome-clip-{category}-{key}'

    payload = json.dumps({'prompt': graph}).encode()
    req = urllib.request.Request(f'{COMFY_URL}/prompt', data=payload,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        pid = json.load(r)['prompt_id']

    vid, t0 = None, time.time()
    while time.time() - t0 < 600:                  # video is slow (quality is 20-step)
        time.sleep(2)
        try:
            with urllib.request.urlopen(f'{COMFY_URL}/history/{pid}', timeout=10) as r:
                hist = json.load(r)
        except Exception:
            continue
        if pid in hist:
            if hist[pid].get('status', {}).get('status_str') == 'error':
                raise RuntimeError('ComfyUI reported a generation error')
            outs = hist[pid].get('outputs', {}).get(wf['save'], {})
            clips = outs.get('images') or outs.get('gifs') or []
            if clips:
                vid = clips[0]
                break
    if not vid:
        raise RuntimeError('animation timed out')

    q = urlencode({'filename': vid['filename'], 'subfolder': vid.get('subfolder', ''),
                   'type': vid.get('type', 'output')})
    with urllib.request.urlopen(f'{COMFY_URL}/view?{q}', timeout=60) as r:
        raw = r.read()

    out_dir = os.path.join(VIDEOS_DIR, category)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{key}.mp4')
    with open(out_path, 'wb') as f:
        f.write(raw)

    rel = f'videos/{category}/{key}.mp4'
    with _video_manifest_lock:
        manifest = _load_video_manifest()
        manifest.setdefault(category, {})[key] = rel
        _save_video_manifest(manifest)
    return {'ok': True, 'key': key, 'category': category, 'path': rel,
            'prompt_id': pid, 'seconds': round(time.time() - t0, 1)}

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    # A request is restricted to the read-only spectator surface when it comes
    # from outside the LAN (the open internet via the port-forward), or when
    # BIOME_PUBLIC forces read-only everywhere. LAN/loopback clients — i.e. you,
    # driving the tournament — are never restricted, so the live push works.
    def _restricted(self):
        if PUBLIC_MODE:
            return True
        return not _is_trusted_addr(self.client_address[0])

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        restricted = self._restricted()
        # A WAN visitor at the root gets the spectator page — the public entry
        # point — instead of the game UI (or a bare 403). LAN clients still get
        # the game at /, since they're here to drive, not just watch.
        if restricted and self.path.split('?', 1)[0] in ('/', '/index.html', '/index.htm'):
            self.path = '/spectator.html'
        # WAN (or forced-public) clients see only the spectator allowlist.
        if restricted and not _public_get_allowed(self.path):
            self.send_error(403, 'Forbidden')
            return
        # Live tournament relay (spectator view)
        if self.path == '/tournament/live':
            self._handle_live_get()
            return
        if self.path.startswith('/tournament/live/frames'):
            self._handle_live_frames_get()
            return
        if self.path.startswith('/tournament/live/board'):
            self._handle_live_board_get()
            return
        # Scheduler control plane (LAN-only — kept off _PUBLIC_GET_ENDPOINTS).
        if self.path.startswith('/tournament/jobs'):
            self._handle_jobs_get()
            return
        # Proxy Ollama API calls
        if self.path.startswith('/ollama/'):
            self._proxy_ollama(self.path[8:])  # strip '/ollama/'
            return
        # Tournament rankings
        if self.path == '/rankings':
            self._json_response(db.get_rankings())
            return
        # Model roster: which installed models are benched (retired)
        if self.path == '/model-roster':
            self._json_response(_load_roster())
            return
        # Tournament match history
        if self.path == '/history':
            self._json_response(db.get_history())
            return
        # Live dashboard payload (standings, ELO timelines, head-to-head, factors)
        if self.path == '/stats/dashboard':
            self._json_response(db.get_dashboard())
            return
        # Full match log (drives the expandable match-log detail view)
        if self.path.startswith('/stats/matches'):
            q = parse_qs(urlparse(self.path).query)
            limit = int(q.get('limit', ['2000'])[0])
            self._json_response(db.get_matches(limit))
            return
        # Per-model tournament participation (Recent Tournaments profile strip).
        # Checked before /stats/model so the longer prefix wins.
        if self.path.startswith('/stats/model-tournaments'):
            q = parse_qs(urlparse(self.path).query)
            name = q.get('m', [''])[0]
            self._json_response(db.get_model_tournaments(name))
            return
        # Single-model drill-in: full ELO timeline, match log, H2H + factor splits
        if self.path.startswith('/stats/model'):
            q = parse_qs(urlparse(self.path).query)
            name = q.get('m', [''])[0]
            self._json_response(db.get_model_detail(name))
            return
        # Past tournaments: the list, and one bracket's matches + ELO history.
        if self.path == '/tournaments':
            self._json_response(db.get_tournaments())
            return
        if self.path.startswith('/tournament'):
            q = parse_qs(urlparse(self.path).query)
            tid = q.get('id', [''])[0]
            if not tid:
                self._json_response({'error': 'id required'}, 400)
            else:
                self._json_response(db.get_tournament(tid))
            return
        # Training Lab: browse captured turns with their reward labels
        if self.path.startswith('/trajectory/list'):
            q = parse_qs(urlparse(self.path).query)
            limit = int(q.get('limit', ['200'])[0])
            filters = {}
            if q.get('model', [''])[0]:
                filters['model'] = q['model'][0]
            if q.get('gold', [''])[0] in ('1', 'true'):
                filters['gold'] = True
            if q.get('medal', [''])[0] in ('gold', 'silver', 'bronze'):
                filters['medal'] = q['medal'][0]
            labels = traj.load_labels()
            rows = []
            for t, lbl in traj.labeled_turns(filters):
                s = traj.summarize(t, lbl)
                s['decision'] = labels.get(t.get('turn_uid'))
                rows.append(s)
            rows.reverse()  # newest first
            self._json_response({'turns': rows[:limit], 'total': len(rows)})
            return
        # Training Lab: full turn record (verbatim prompt/response) + label
        if self.path.startswith('/trajectory/detail'):
            q = parse_qs(urlparse(self.path).query)
            uid = q.get('uid', [''])[0]
            turns, ri, oi = traj.load()
            hit = next((t for t in turns if t.get('turn_uid') == uid), None)
            if not hit:
                self._json_response({'error': 'not found'}, 404)
            else:
                self._json_response({'turn': hit, 'label': traj.score_turn(hit, ri, oi)})
            return
        # Training Lab: build the SFT dataset from gold turns (+ manual stars)
        if self.path.startswith('/trajectory/export'):
            q = parse_qs(urlparse(self.path).query)
            filters = {}
            if q.get('model', [''])[0]:
                filters['model'] = q['model'][0]
            self._json_response(traj.write_dataset(filters))
            return
        # Training Lab: dashboard metrics (gold count, totals, goal progress)
        if self.path == '/trajectory/stats':
            self._json_response(traj.stats())
            return
        # Training Lab: who currently teaches (top of the ladder)
        if self.path == '/trajectory/champion':
            ranks = db.get_rankings()
            champ = max(ranks.items(), key=lambda kv: kv[1].get('elo', 0), default=(None, None))
            self._json_response({'champion': champ[0], 'stats': champ[1]})
            return
        # Avatar generation: is ComfyUI reachable?
        if self.path == '/comfy/health':
            ok = False
            try:
                with urllib.request.urlopen(f'{COMFY_URL}/system_stats', timeout=3) as r:
                    ok = r.status == 200
            except Exception:
                ok = False
            self._json_response({'comfy': ok})
            return
        # Honor HTTP Range requests for static files. Python's stock handler
        # ignores Range and replies 200 + whole file, which Chrome's media
        # stack rejects for <video> streaming (the victory clips silently
        # stall on the win screen). Serve 206 ourselves when a Range is asked.
        if self.headers.get('Range') and self._serve_range_request():
            return
        super().do_GET()

    # Stream a byte range of a static file as 206 Partial Content. Returns True
    # if it fully handled the response, False to fall back to the normal handler
    # (non-file paths, unparseable/whole-file ranges).
    def _serve_range_request(self):
        path = self.translate_path(self.path.split('?', 1)[0])
        if not os.path.isfile(path):
            return False
        m = re.match(r'bytes=(\d*)-(\d*)\s*$', self.headers.get('Range', '').strip())
        if not m:
            return False
        try:
            f = open(path, 'rb')
        except OSError:
            return False
        with f:
            size = os.fstat(f.fileno()).st_size
            start_s, end_s = m.group(1), m.group(2)
            if start_s == '':
                if end_s == '':
                    return False
                length = min(int(end_s), size)
                start, end = size - length, size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
                if end >= size:
                    end = size - 1
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Type', self.guess_type(path))
                self.end_headers()
                return True
            length = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(length))
            self.end_headers()
            if self.command == 'HEAD':
                return True
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)
        return True

    def do_POST(self):
        # Only the LAN driver may write (push the live feed, log results, etc.).
        if self._restricted():
            self.send_error(403, 'Forbidden')
            return
        # Live tournament relay: driving browser pushes snapshot + board image
        if self.path == '/tournament/live':
            self._handle_live_post()
            return
        if self.path == '/tournament/live/frames':
            self._handle_live_frames_post()
            return
        if self.path == '/tournament/live/board':
            self._handle_live_board_post()
            return
        # Scheduler control plane (LAN-only via the do_POST 403 gate above).
        if self.path == '/tournament/schedule':
            self._handle_schedule_post()
            return
        if self.path == '/tournament/jobs/cancel':
            self._handle_jobs_cancel_post()
            return
        # Proxy Ollama API calls (including /api/pull for model installation)
        if self.path.startswith('/ollama/'):
            is_pull = '/api/pull' in self.path
            if is_pull:
                self._proxy_ollama_stream(self.path[8:], is_post=True)
            else:
                self._proxy_ollama(self.path[8:], is_post=True)
            return
        # Out-of-process heartbeat / crash forensics (renderer SIGILL survivor)
        if self.path == '/heartbeat':
            self._handle_heartbeat()
            return
        # Tournament result logging
        if self.path == '/tournament-result':
            self._handle_tournament_result()
            return
        # Training-data capture: per-turn trajectory + per-round reward signals
        if self.path == '/trajectory/turn':
            self._handle_trajectory('turns.jsonl')
            return
        if self.path == '/trajectory/round':
            self._handle_trajectory('rounds.jsonl')
            return
        # Training Lab: manual curate override (star/reject) for a turn
        if self.path == '/trajectory/label':
            self._handle_trajectory('labels.jsonl')
            return
        # Training Lab: compact logs — drop rejects + never-gold turns
        if self.path == '/trajectory/purge':
            try:
                length = int(self.headers.get('Content-Length', 0))
                body = json.loads(self.rfile.read(length)) if length else {}
            except (json.JSONDecodeError, ValueError):
                body = {}
            self._json_response(traj.purge(body.get('mode', 'curatable')))
            return
        # Reset rankings (archive then clear the match log)
        if self.path == '/reset-rankings':
            self._handle_reset()
            return
        # Avatar generation via ComfyUI
        if self.path == '/comfy/generate':
            self._handle_comfy_generate()
            return
        # Avatar animation (WAN i2v) — victory/defeat clips
        if self.path == '/comfy/animate':
            self._handle_comfy_animate()
            return
        # Persist an edited still/motion prompt as a per-key override
        if self.path == '/lab/overrides':
            self._handle_overrides()
            return
        # Persist a per-key creature identity (rename / retheme)
        if self.path == '/lab/identity':
            self._handle_identity()
            return
        # Retire / reactivate a model (bench it from competition, weights kept)
        if self.path == '/model-roster':
            self._handle_roster()
            return
        super().do_POST()

    def do_DELETE(self):
        # Only the LAN driver may delete (model uninstall via the Ollama proxy).
        if self._restricted():
            self.send_error(403, 'Forbidden')
            return
        # Uninstall: delete model weights from disk via Ollama. Proxied so all
        # Ollama traffic stays on one path. ELO/history in biome.db is untouched.
        if self.path.startswith('/ollama/'):
            self._proxy_ollama(self.path[8:], method='DELETE')
            return
        self.send_response(405)
        self.end_headers()

    def _json_response(self, data, status=200):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        except (BrokenPipeError, ConnectionResetError):
            # Client vanished mid-write (tab closed, navigated, or crashed). The
            # socket is gone — there's nothing to report and no one to report to.
            pass

    def _read_json_body(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            return json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            return None

    # ── tournament scheduler control plane (LAN-only) ──────────────────────
    def _handle_schedule_post(self):
        body = self._read_json_body()
        if body is None:
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        cfg = _norm_cfg(body)
        when = body.get('when') or {'kind': 'now'}
        if when.get('kind') == 'now':
            job = _new_job(cfg, source='manual')
            with _SCHED_LOCK:
                _SCHED['queue'].append(job)
            self._json_response({'ok': True, 'job': job['id']})
        else:
            sid = 'sched-%d' % int(time.time() * 1000)
            with _SCHED_LOCK:
                _SCHED['schedules'].append({'id': sid, 'config': cfg, 'when': when,
                                            'last_fired': time.time()})
            _save_schedules()
            self._json_response({'ok': True, 'schedule': sid})

    def _handle_jobs_get(self):
        with _SCHED_LOCK:
            out = {'running': _SCHED['running'], 'queue': list(_SCHED['queue']),
                   'recent': list(_SCHED['recent']), 'schedules': list(_SCHED['schedules'])}
        self._json_response(out)

    def _handle_jobs_cancel_post(self):
        body = self._read_json_body()
        if body is None:
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        jid = body.get('id')
        removed = False
        with _SCHED_LOCK:
            n = len(_SCHED['queue'])
            _SCHED['queue'] = [j for j in _SCHED['queue'] if j['id'] != jid]
            removed = len(_SCHED['queue']) < n
            if _SCHED['running'] and _SCHED['running']['id'] == jid:
                _SCHED['cancel'].add(jid)
                removed = True
            ns = len(_SCHED['schedules'])
            _SCHED['schedules'] = [s for s in _SCHED['schedules'] if s['id'] != jid]
            if len(_SCHED['schedules']) < ns:
                removed = True
        _save_schedules()
        self._json_response({'ok': removed})

    def _handle_trajectory(self, filename):
        # Fire-and-forget from the client; we just append and ack. Never 500 into
        # the game loop — a bad record is dropped, not fatal.
        try:
            length = int(self.headers.get('Content-Length', 0))
            record = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        record.setdefault('server_ts', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        ok = _traj_append(filename, record)
        self._json_response({'ok': ok})

    def _handle_heartbeat(self):
        # Fire-and-forget vitals from the driving browser. Must never disturb the
        # game loop — a bad beat is dropped, not fatal. Ack tiny so the client's
        # 1 Hz post is cheap.
        try:
            length = int(self.headers.get('Content-Length', 0))
            record = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response({'ok': False}, 400)
            return
        _heartbeat_append(record)
        self._json_response({'ok': True})

    def _handle_tournament_result(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        required = ['tournament_id', 'round', 'p1', 'p2', 'winner']
        for field in required:
            if field not in body:
                self._json_response({'error': f'Missing field: {field}'}, 400)
                return
        # db.record_match inserts the match, applies incremental ELO, writes the
        # rating_events timeline, and returns the same delta/result payload the
        # client already knows how to celebrate — plus the match id.
        out = db.record_match({
            'tournament_id': body['tournament_id'],
            'round': body['round'],
            'mode': body.get('mode', 'standard'),
            'format': body.get('format'),
            'map_size': body.get('map_size'),
            'map_strategy': body.get('map_strategy'),
            'rounds': body.get('rounds'),
            'p1': body['p1'],
            'p2': body['p2'],
            'p1_score': body.get('p1_score', 0),
            'p2_score': body.get('p2_score', 0),
            'winner': body['winner'],
            'seed': body.get('seed'),
        })
        # Training-data: stamp the authoritative outcome onto this match's
        # captured turns/rounds (joined by match_uid). Done here because the
        # server now holds match_uid + match_id + winner + scores + ELO at once.
        if body.get('match_uid'):
            _traj_append('outcomes.jsonl', {
                'match_uid': body['match_uid'],
                'match_id': out['match_id'],
                'winner': body['winner'],
                'p1': body['p1'], 'p2': body['p2'],
                'p1_score': body.get('p1_score', 0),
                'p2_score': body.get('p2_score', 0),
                'seed': body.get('seed'),
                'mode': body.get('mode', 'standard'),
                'map_strategy': body.get('map_strategy'),
                'map_size': body.get('map_size'),
                'rounds': body.get('rounds'),
                'elo': out['result'],
                'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            })
        self._json_response({
            'ok': True,
            'total_matches': out['total_matches'],
            'result': out['result'],
            'rankings': out['rankings'],
        })

    # --- Live tournament relay ---------------------------------------------
    # Fire-and-forget from the driving browser; never 500 into the game loop.
    def _handle_live_post(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            snap = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        with _LIVE_LOCK:
            _splice_board_terrain(snap)
            _LIVE['snapshot'] = snap
            _LIVE['updated'] = time.time()
            _LIVE['done'] = bool(snap.get('done'))
        self._json_response({'ok': True})

    # Per-step growth frame from the driver — append to the ring. Lightweight
    # { seq, board }; spectators drain newer-than-since to animate the sim.
    def _handle_live_frames_post(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            frame = json.loads(self.rfile.read(length)) if length else {}
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        seq = frame.get('seq')
        if not isinstance(seq, int):
            self._json_response({'error': 'no seq'}, 400)
            return
        with _LIVE_LOCK:
            _LIVE['frames'].append({'seq': seq, 'board': frame.get('board')})
            if seq > _LIVE['frame_seq']:
                _LIVE['frame_seq'] = seq
            _LIVE['updated'] = time.time()
        self._json_response({'ok': True})

    # Spectator drains frames with seq > `since`; `latest` lets a joiner skip the
    # backlog and resync to the live edge.
    def _handle_live_frames_get(self):
        try:
            since = int(parse_qs(urlparse(self.path).query).get('since', ['0'])[0])
        except (ValueError, TypeError):
            since = 0
        with _LIVE_LOCK:
            frames = [f for f in _LIVE['frames'] if f['seq'] > since]
            latest = _LIVE['frame_seq']
        self._json_response({'frames': frames, 'latest': latest})

    def _handle_live_board_post(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            data = self.rfile.read(length) if length else b''
        except (ValueError, OSError):
            self._json_response({'error': 'bad body'}, 400)
            return
        if not data:
            self._json_response({'error': 'empty'}, 400)
            return
        with _LIVE_LOCK:
            _LIVE['board'] = data
            _LIVE['board_ct'] = self.headers.get('Content-Type', 'image/webp')
            _LIVE['board_rev'] += 1
            _LIVE['updated'] = time.time()
            rev = _LIVE['board_rev']
        self._json_response({'ok': True, 'board_rev': rev})

    def _handle_live_get(self):
        with _LIVE_LOCK:
            snap = _LIVE['snapshot']
            updated = _LIVE['updated']
            rev = _LIVE['board_rev']
            done = _LIVE['done']
        age = time.time() - updated if updated else None
        active = snap is not None and not done and age is not None and age < LIVE_STALE_S
        self._json_response({
            'active': active,
            'done': done,
            'snapshot': snap if active else None,
            'board_rev': rev,
            'age_ms': round(age * 1000) if age is not None else None,
        })

    def _handle_live_board_get(self):
        with _LIVE_LOCK:
            data = _LIVE['board']
            ct = _LIVE['board_ct']
        if not data:
            self.send_error(404, 'no board')
            return
        self.send_response(200)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _handle_comfy_generate(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        key = body.get('key', '')
        style = body.get('style', 'cyber-organic')
        prompt = body.get('prompt', '')
        negative = body.get('negative', '')
        lora = body.get('lora', '')
        seed = body.get('seed', 0)
        if not (key and prompt and lora):
            self._json_response({'error': 'key, prompt, and lora are required'}, 400)
            return
        if not (_SLUG.match(key) and _SLUG.match(style)):  # guard the filesystem path
            self._json_response({'error': 'key/style must be lowercase slugs'}, 400)
            return
        try:
            self._json_response(_comfy_generate(key, style, prompt, negative, lora, seed))
        except Exception as e:
            self._json_response({'error': str(e)}, 502)

    def _handle_comfy_animate(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        key = body.get('key', '')
        category = body.get('category', '')
        prompt = body.get('prompt', '')
        negative = body.get('negative', '')
        workflow = body.get('workflow', 'fast')
        seed = body.get('seed', 0)
        if not (key and prompt):
            self._json_response({'error': 'key and prompt are required'}, 400)
            return
        if not _SLUG.match(key):                       # guard the filesystem path
            self._json_response({'error': 'key must be a lowercase slug'}, 400)
            return
        if category not in VIDEO_CATEGORIES:
            self._json_response({'error': f'category must be one of {VIDEO_CATEGORIES}'}, 400)
            return
        if workflow not in VIDEO_WORKFLOWS:
            self._json_response({'error': f'workflow must be one of {tuple(VIDEO_WORKFLOWS)}'}, 400)
            return
        try:
            self._json_response(_comfy_animate(key, category, prompt, negative, workflow, seed))
        except FileNotFoundError as e:
            self._json_response({'error': str(e)}, 404)
        except Exception as e:
            self._json_response({'error': str(e)}, 502)

    def _handle_overrides(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        kind = body.get('kind', '')
        key = body.get('key', '')
        text = body.get('text', '')
        if kind not in OVERRIDE_KINDS:
            self._json_response({'error': f'kind must be one of {OVERRIDE_KINDS}'}, 400)
            return
        if not _SLUG.match(key):
            self._json_response({'error': 'key must be a lowercase slug'}, 400)
            return
        _save_override(kind, key, text)
        self._json_response({'ok': True, 'kind': kind, 'key': key, 'saved': bool(text and text.strip())})

    def _handle_identity(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        key = body.get('key', '')
        if not _SLUG.match(key):
            self._json_response({'error': 'key must be a lowercase slug'}, 400)
            return
        _save_identity(key, body.get('label', ''), body.get('archetype', ''), body.get('motif', ''))
        self._json_response({'ok': True, 'key': key})

    def _handle_roster(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._json_response({'error': 'Invalid JSON'}, 400)
            return
        model = (body.get('model') or '').strip()
        if not model:
            self._json_response({'error': 'model required'}, 400)
            return
        data = _save_roster_entry(model, bool(body.get('retired')))
        self._json_response({'ok': True, 'retired': data['retired']})

    def _handle_reset(self):
        """Archive the current database to a timestamped backup, then start fresh."""
        self._json_response(db.reset())

    def _proxy_ollama_stream(self, path, is_post=False):
        """Stream proxy for pull requests — sends NDJSON lines as they arrive."""
        url = f'http://localhost:11434/{path}'
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length else b''
            req = urllib.request.Request(url, data=body, method='POST')
            req.add_header('Content-Type', self.headers.get('Content-Type', 'application/json'))

            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()

            with urllib.request.urlopen(req, timeout=600) as response:
                for line in response:
                    self.wfile.write(line)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Client gave up (e.g. an AI-turn AbortController fired). Nothing to
            # send back — the socket is already gone.
            return
        except Exception as e:
            self._send_proxy_error(e)

    def _proxy_ollama(self, path, is_post=False, method=None):
        url = f'http://localhost:11434/{path}'
        if method is None:
            method = 'POST' if is_post else 'GET'

        try:
            if method in ('POST', 'DELETE'):
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length) if content_length else b''
                req = urllib.request.Request(url, data=body, method=method)
                req.add_header('Content-Type', self.headers.get('Content-Type', 'application/json'))
            else:
                req = urllib.request.Request(url)

            with urllib.request.urlopen(req, timeout=120) as response:
                self.send_response(response.status)
                for header, value in response.headers.items():
                    if header.lower() not in ['content-encoding', 'transfer-encoding']:
                        self.send_header(header, value)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(response.read())
        except (BrokenPipeError, ConnectionResetError):
            # Client gave up (e.g. an AI-turn AbortController fired) before we
            # finished writing the proxied response. The socket is gone — don't
            # try to send an error body into a broken pipe.
            return
        except Exception as e:
            self._send_proxy_error(e)

    def _send_proxy_error(self, e):
        """Send a 502 for a failed proxy, but never raise if the client is gone."""
        try:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        pass  # suppress request logs

if __name__ == '__main__':
    db.init_db()
    # Headless tournament scheduler — runs queued/scheduled tournaments one at a
    # time by spawning the runner. Daemon so it dies with the server.
    threading.Thread(target=_scheduler_loop, daemon=True).start()
    server = ThreadingHTTPServer(('', 8765), NoCacheHandler)
    print('Serving on http://localhost:8765')
    server.serve_forever()
