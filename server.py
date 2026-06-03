#!/usr/bin/env python3
"""HTTP server with Ollama proxy for CORS bypass and tournament logging."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse, parse_qs
import urllib.request
import urllib.error
import json
import os
import re
import time
import uuid
import subprocess
import threading

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

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

# --- Avatar animation (ComfyUI WAN 2.2 image-to-video bridge) ---
# A baked still (avatars/cyber-organic/<key>.png) is the I2V start frame; a motion
# prompt drives a short victory/defeat clip. Same submit→poll→save shape as the
# avatar bridge, but the WAN graphs differ, so each carries a node-id map for the
# injectable fields. Output is already h264 mp4, so we save the bytes verbatim.
VIDEOS_DIR = os.path.join(BASE_DIR, 'videos')
VIDEO_MANIFEST_FILE = os.path.join(VIDEOS_DIR, 'manifest.json')
OVERRIDES_FILE = os.path.join(AVATARS_DIR, 'lab-overrides.json')
VIDEO_CATEGORIES = ('victory', 'defeat')
OVERRIDE_KINDS = ('still', 'victory', 'defeat')
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
            self._json_response(db.get_rankings())
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
        # Single-model drill-in: full ELO timeline, match log, H2H + factor splits
        if self.path.startswith('/stats/model'):
            q = parse_qs(urlparse(self.path).query)
            name = q.get('m', [''])[0]
            self._json_response(db.get_model_detail(name))
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
        # Avatar animation (WAN i2v) — victory/defeat clips
        if self.path == '/comfy/animate':
            self._handle_comfy_animate()
            return
        # Persist an edited still/motion prompt as a per-key override
        if self.path == '/lab/overrides':
            self._handle_overrides()
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
        })
        self._json_response({
            'ok': True,
            'total_matches': out['total_matches'],
            'result': out['result'],
            'rankings': out['rankings'],
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
    db.init_db()
    server = ThreadingHTTPServer(('', 8765), NoCacheHandler)
    print('Serving on http://localhost:8765')
    server.serve_forever()
