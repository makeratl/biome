#!/usr/bin/env python3
"""HTTP server with Ollama proxy for CORS bypass and tournament logging."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
import urllib.error
import json
import os
import time
import uuid

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tournament_log.json')

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

def _compute_rankings(log):
    K = 32
    DEFAULT_ELO = 1000
    models = {}
    for entry in log:
        p1 = entry['p1']
        p2 = entry['p2']
        for m in (p1, p2):
            if m not in models:
                models[m] = {'elo': DEFAULT_ELO, 'wins': 0, 'losses': 0, 'matches': 0}
        r1 = models[p1]['elo']
        r2 = models[p2]['elo']
        e1 = 1 / (1 + 10 ** ((r2 - r1) / 400))
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
        log.append(entry)
        _save_log(log)
        self._json_response({'ok': True, 'total_matches': len(log)})

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
