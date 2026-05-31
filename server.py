#!/usr/bin/env python3
"""HTTP server with Ollama proxy for CORS bypass and tournament logging."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode
import urllib.request
import urllib.error
import json
import os
import re
import time
import uuid
import subprocess
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(BASE_DIR, 'tournament_log.json')

# --- Avatar generation (ComfyUI bridge) ---
COMFY_URL = 'http://localhost:8188'
AVATARS_DIR = os.path.join(BASE_DIR, 'avatars')
MANIFEST_FILE = os.path.join(AVATARS_DIR, 'manifest.json')
WORKFLOW_FILE = os.path.join(BASE_DIR, 'comfy_avatar_workflow.json')
_SLUG = re.compile(r'^[a-z0-9-]+$')
_manifest_lock = threading.Lock()

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

def _load_log():
    if not os.path.exists(LOG_FILE):
        return []
    try:
        with open(LOG_FILE, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return []

def _save_log(data):
    with open(LOG_FILE, 'w') as f:
        json.dump(data, f, indent=2)

DEFAULT_ELO = 1000

def _expected(r_a, r_b):
    """Expected score (win probability) for player A vs player B under ELO."""
    return 1 / (1 + 10 ** ((r_b - r_a) / 400))

def _rank_of(rankings, name):
    """Return {'elo', 'rank'} (1-based) for a name in an ordered rankings dict, or None."""
    for i, (n, stats) in enumerate(rankings.items()):
        if n == name:
            return {'elo': stats['elo'], 'rank': i + 1}
    return None

def _compute_rankings(log):
    K = 32
    models = {}
    for entry in log:
        p1 = entry['p1']
        p2 = entry['p2']
        for m in (p1, p2):
            if m not in models:
                models[m] = {'elo': DEFAULT_ELO, 'wins': 0, 'losses': 0, 'matches': 0}
        r1 = models[p1]['elo']
        r2 = models[p2]['elo']
        e1 = _expected(r1, r2)
        e2 = 1 - e1
        s1 = 1 if entry['winner'] == p1 else 0
        s2 = 1 - s1
        models[p1]['elo'] = round(r1 + K * (s1 - e1))
        models[p2]['elo'] = round(r2 + K * (s2 - e2))
        models[p1]['wins' if s1 else 'losses'] += 1
        models[p2]['wins' if s2 else 'losses'] += 1
        models[p1]['matches'] += 1
        models[p2]['matches'] += 1
    return dict(sorted(models.items(), key=lambda x: x[1]['elo'], reverse=True))

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # Proxy Ollama API calls
        if self.path.startswith('/ollama/'):
            self._proxy_ollama(self.path[8:])  # strip '/ollama/'
            return
        # Tournament rankings
        if self.path == '/rankings':
            log = _load_log()
            rankings = _compute_rankings(log)
            self._json_response(rankings)
            return
        # Tournament match history
        if self.path == '/history':
            self._json_response(_load_log())
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
        super().do_GET()

    def do_POST(self):
        # Proxy Ollama API calls (including /api/pull for model installation)
        if self.path.startswith('/ollama/'):
            is_pull = '/api/pull' in self.path
            if is_pull:
                self._proxy_ollama_stream(self.path[8:], is_post=True)
            else:
                self._proxy_ollama(self.path[8:], is_post=True)
            return
        # Tournament result logging
        if self.path == '/tournament-result':
            self._handle_tournament_result()
            return
        # Reset rankings (archive then clear the match log)
        if self.path == '/reset-rankings':
            self._handle_reset()
            return
        # Avatar generation via ComfyUI
        if self.path == '/comfy/generate':
            self._handle_comfy_generate()
            return
        super().do_POST()

    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

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
        entry = {
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'tournament_id': body['tournament_id'],
            'round': body['round'],
            'p1': body['p1'],
            'p2': body['p2'],
            'p1_score': body.get('p1_score', 0),
            'p2_score': body.get('p2_score', 0),
            'winner': body['winner'],
            'mode': body.get('mode', 'standard'),
        }
        log = _load_log()
        before = _compute_rankings(log)   # rankings as they stood BEFORE this match
        log.append(entry)
        _save_log(log)
        after = _compute_rankings(log)    # rankings AFTER this match resolves
        total_after = len(after)

        def _delta(name):
            b = _rank_of(before, name)
            a = _rank_of(after, name)
            return {
                'name': name,
                'eloBefore': b['elo'] if b else DEFAULT_ELO,
                'eloAfter': a['elo'] if a else DEFAULT_ELO,
                'rankBefore': b['rank'] if b else None,   # null = wasn't ranked yet
                'rankAfter': a['rank'] if a else total_after,
                'total': total_after,
            }

        winner = entry['winner']
        loser = entry['p2'] if winner == entry['p1'] else entry['p1']
        wb = _rank_of(before, winner)
        lb = _rank_of(before, loser)
        winner_win_prob = _expected(
            wb['elo'] if wb else DEFAULT_ELO,
            lb['elo'] if lb else DEFAULT_ELO,
        )

        result = {
            'p1': _delta(entry['p1']),
            'p2': _delta(entry['p2']),
            'winner': winner,
            'winnerWinProb': winner_win_prob,
        }
        self._json_response({
            'ok': True,
            'total_matches': len(log),
            'result': result,
            'rankings': after,
        })

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

    def _handle_reset(self):
        """Archive the current match log to a timestamped backup, then start fresh."""
        archived = None
        if os.path.exists(LOG_FILE):
            ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
            backup = os.path.join(os.path.dirname(LOG_FILE), f'tournament_log.{ts}.bak')
            try:
                os.rename(LOG_FILE, backup)
                archived = os.path.basename(backup)
            except OSError:
                pass
        _save_log([])
        self._json_response({'ok': True, 'archived': archived})

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
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _proxy_ollama(self, path, is_post=False):
        url = f'http://localhost:11434/{path}'

        try:
            if is_post:
                content_length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(content_length) if content_length else b''
                req = urllib.request.Request(url, data=body, method='POST')
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
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, format, *args):
        pass  # suppress request logs

if __name__ == '__main__':
    server = ThreadingHTTPServer(('', 8765), NoCacheHandler)
    print('Serving on http://localhost:8765')
    server.serve_forever()
