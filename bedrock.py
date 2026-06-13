"""AWS Bedrock bridge — SigV4-signed Converse calls, zero non-stdlib deps.

Biome runs local Ollama by default. This module is the optional premium/open-weight
side door: a client toggle ("use AWS Bedrock models", off by default) decides whether
the curated models below join the tournament pool. The server only ever calls in here
when that pool is in play.

Design contract: a Converse reply is translated back into the **Ollama /api/chat
shape** ({message:{content}, ...}) so the browser's existing request builder and
3-tier extractJSON parser in js/ai.js need no special casing — only a routing branch.

Credentials come from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
optional AWS_SESSION_TOKEN / AWS_REGION). server.py bootstraps those from .env.local
at boot. No boto3 — SigV4 is signed by hand with stdlib hmac/hashlib.

Run `python3 bedrock.py` for a standalone self-test: it reports credential presence,
lists which of the curated models the account can actually invoke, and does one tiny
Converse round-trip to prove signing end-to-end.
"""
import os
import json
import hmac
import hashlib
import datetime
import threading
import urllib.request
import urllib.error
import urllib.parse


# ── credentials / region ───────────────────────────────────────────────────
def _creds():
    return (
        os.environ.get('AWS_ACCESS_KEY_ID', '').strip(),
        os.environ.get('AWS_SECRET_ACCESS_KEY', '').strip(),
        os.environ.get('AWS_SESSION_TOKEN', '').strip(),
    )


def region():
    return (os.environ.get('AWS_REGION')
            or os.environ.get('AWS_DEFAULT_REGION')
            or 'us-east-1').strip()


def available():
    """True when static keys are present — i.e. the server can sign Bedrock calls."""
    key, secret, _ = _creds()
    return bool(key and secret)


# ── curated minimal starter set: premium (Anthropic) vs open weight ─────────
# `name` is the app-wide id (the `bedrock:` prefix is the client routing key);
# `id` is the real Bedrock invoke / inference-profile id (confirmed per region).
# in/out prices are USD per 1M tokens, for the session cost estimate (log only).
MODELS = [
    {'name': 'bedrock:claude-sonnet-4-6',
     'id': 'us.anthropic.claude-sonnet-4-6',
     'label': 'Claude Sonnet 4.6', 'vendor': 'anthropic', 'klass': 'premium',
     'in_price': 3.0, 'out_price': 15.0},
    {'name': 'bedrock:claude-haiku-4-5',
     'id': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
     'label': 'Claude Haiku 4.5', 'vendor': 'anthropic', 'klass': 'premium',
     'in_price': 1.0, 'out_price': 5.0},
    {'name': 'bedrock:deepseek-v3',
     'id': 'deepseek.v3.2',
     'label': 'DeepSeek V3.2', 'vendor': 'deepseek', 'klass': 'open',
     'in_price': 0.58, 'out_price': 1.68},
    {'name': 'bedrock:llama4-maverick',
     'id': 'us.meta.llama4-maverick-17b-instruct-v1:0',
     'label': 'Llama 4 Maverick', 'vendor': 'meta', 'klass': 'open',
     'in_price': 0.24, 'out_price': 0.97},
]
_BY_NAME = {m['name']: m for m in MODELS}


def list_models():
    """Ollama /api/tags-shaped list for the client, or [] when not configured.
    `size` is omitted/0 — these are remote, not on-disk."""
    if not available():
        return []
    return [{'name': m['name'], 'size': 0, 'label': m['label'],
             'vendor': m['vendor'], 'klass': m['klass']} for m in MODELS]


# ── session cost accounting (estimate only — never blocks) ──────────────────
_usage_lock = threading.Lock()
_usage = {'inputTokens': 0, 'outputTokens': 0, 'costUsd': 0.0, 'calls': 0}
_USAGE_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'dev-logs', 'bedrock-usage.log')


def usage():
    with _usage_lock:
        return dict(_usage)


def _record_usage(model, in_tok, out_tok):
    cost = (in_tok / 1e6) * model['in_price'] + (out_tok / 1e6) * model['out_price']
    with _usage_lock:
        _usage['inputTokens'] += in_tok
        _usage['outputTokens'] += out_tok
        _usage['costUsd'] += cost
        _usage['calls'] += 1
        session_cost = _usage['costUsd']
    try:
        os.makedirs(os.path.dirname(_USAGE_LOG), exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with open(_USAGE_LOG, 'a', encoding='utf-8') as f:
            f.write(f'{stamp} {model["name"]} in={in_tok} out={out_tok} '
                    f'${cost:.4f} (session ${session_cost:.4f})\n')
    except OSError:
        pass
    return cost, session_cost


# ── AWS Signature V4 ────────────────────────────────────────────────────────
def _sign(key, msg):
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()


def _sigv4_headers(method, host, canonical_uri, payload, service, reg,
                   extra_headers=None):
    """Build the SigV4 Authorization + amz headers for a request. `payload` is
    bytes. `canonical_uri` must already be percent-encoded."""
    key, secret, token = _creds()
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime('%Y%m%dT%H%M%SZ')
    date_stamp = now.strftime('%Y%m%d')
    payload_hash = hashlib.sha256(payload).hexdigest()

    headers = {
        'host': host,
        'x-amz-date': amz_date,
        'x-amz-content-sha256': payload_hash,
    }
    if token:
        headers['x-amz-security-token'] = token
    if extra_headers:
        headers.update({k.lower(): v for k, v in extra_headers.items()})

    signed_headers = ';'.join(sorted(headers))
    canonical_headers = ''.join(f'{k}:{headers[k]}\n' for k in sorted(headers))
    canonical_request = '\n'.join([
        method, canonical_uri, '',          # empty canonical query string
        canonical_headers, signed_headers, payload_hash,
    ])

    scope = f'{date_stamp}/{reg}/{service}/aws4_request'
    string_to_sign = '\n'.join([
        'AWS4-HMAC-SHA256', amz_date, scope,
        hashlib.sha256(canonical_request.encode('utf-8')).hexdigest(),
    ])

    k_date = _sign(('AWS4' + secret).encode('utf-8'), date_stamp)
    k_region = _sign(k_date, reg)
    k_service = _sign(k_region, service)
    k_signing = _sign(k_service, 'aws4_request')
    signature = hmac.new(k_signing, string_to_sign.encode('utf-8'),
                         hashlib.sha256).hexdigest()

    headers['Authorization'] = (
        f'AWS4-HMAC-SHA256 Credential={key}/{scope}, '
        f'SignedHeaders={signed_headers}, Signature={signature}')
    return headers


# ── Converse: Ollama-chat body in, Ollama-chat reply out ────────────────────
def _to_converse(messages, options):
    """Split system out, map roles into Converse system[]/messages[] + config."""
    system, conv = [], []
    for m in messages or []:
        role = m.get('role')
        content = m.get('content', '')
        if role == 'system':
            system.append({'text': content})
        else:
            conv.append({'role': 'assistant' if role == 'assistant' else 'user',
                         'content': [{'text': content}]})
    opts = options or {}
    cfg = {'maxTokens': int(opts.get('num_predict') or 1024)}
    if 'temperature' in opts:
        cfg['temperature'] = opts['temperature']
    body = {'messages': conv, 'inferenceConfig': cfg}
    if system:
        body['system'] = system
    return body


def chat(body, timeout=120):
    """Run one Ollama-shaped /api/chat body through Bedrock Converse.

    Returns (ollama_shaped_reply_dict, http_status). On AWS error, returns an
    {'error': ...} dict with the upstream status so the caller can relay it like
    the Ollama proxy's 502 path."""
    name = body.get('model', '')
    model = _BY_NAME.get(name if name.startswith('bedrock:') else f'bedrock:{name}')
    if model is None:
        return {'error': f'unknown bedrock model: {name}'}, 400
    if not available():
        return {'error': 'bedrock not configured (no AWS credentials)'}, 503

    reg = region()
    host = f'bedrock-runtime.{reg}.amazonaws.com'
    # The id contains ':' (e.g. ...-v1:0). Send it LITERAL in the request path —
    # AWS canonicalizes ':' → %3A itself — but sign the %3A-encoded form so our
    # canonical URI matches what the service derives. (Pre-encoding the path would
    # make AWS re-encode '%' → '%25', breaking the signature.)
    raw_path = f'/model/{model["id"]}/converse'
    canonical_uri = '/model/' + urllib.parse.quote(model['id'], safe='') + '/converse'
    payload = json.dumps(_to_converse(body.get('messages'),
                                      body.get('options'))).encode('utf-8')

    headers = _sigv4_headers('POST', host, canonical_uri, payload,
                             'bedrock', reg,
                             extra_headers={'content-type': 'application/json'})
    req = urllib.request.Request(f'https://{host}{raw_path}',
                                 data=payload, method='POST')
    for k, v in headers.items():
        req.add_header(k, v)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')
        return {'error': f'bedrock {e.code}: {detail}'}, e.code
    except Exception as e:
        return {'error': str(e)}, 502

    out = data.get('output', {}).get('message', {})
    parts = out.get('content', [])
    text = ''.join(p.get('text', '') for p in parts)
    u = data.get('usage', {})
    in_tok = int(u.get('inputTokens', 0))
    out_tok = int(u.get('outputTokens', 0))
    cost, session_cost = _record_usage(model, in_tok, out_tok)

    # Ollama /api/chat shape — what js/ai.js already parses.
    return {
        'model': model['name'],
        'message': {'role': 'assistant', 'content': text},
        'done': True,
        '_usage': {'inputTokens': in_tok, 'outputTokens': out_tok},
        '_costUsd': round(cost, 6),
        '_sessionCostUsd': round(session_cost, 6),
    }, 200


# ── standalone self-test / model-id discovery ───────────────────────────────
def _list_foundation_models():
    """Call the Bedrock control plane (ListFoundationModels) to discover the real
    invoke ids the account can see. Dev aid — not used by the server."""
    reg = region()
    host = f'bedrock.{reg}.amazonaws.com'
    canonical_uri = '/foundation-models'
    headers = _sigv4_headers('GET', host, canonical_uri, b'', 'bedrock', reg)
    req = urllib.request.Request(f'https://{host}{canonical_uri}', method='GET')
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


if __name__ == '__main__':
    print(f'region: {region()}  credentials: {"present" if available() else "MISSING"}')
    if not available():
        raise SystemExit('Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or .env.local).')

    print('\n— ListFoundationModels (discover real invoke ids) —')
    try:
        cat = _list_foundation_models()
        wanted = ('claude-sonnet-4', 'claude-haiku-4', 'deepseek', 'llama4')
        for m in cat.get('modelSummaries', []):
            mid = m.get('modelId', '')
            if any(w in mid for w in wanted):
                print(f'  {mid}')
    except Exception as e:
        print(f'  ListFoundationModels failed: {e}')

    print('\n— Converse round-trip (each curated model) —')
    for m in MODELS:
        reply, status = chat({
            'model': m['name'],
            'messages': [{'role': 'user', 'content': 'Reply with the single word: pong'}],
            'options': {'num_predict': 16},
        })
        if status == 200:
            txt = reply['message']['content'].strip().replace('\n', ' ')[:40]
            u = reply['_usage']
            print(f'  OK   {m["name"]:28} → "{txt}"  ({u["inputTokens"]}+{u["outputTokens"]} tok)')
        else:
            err = str(reply.get('error', reply))[:160]
            print(f'  FAIL {m["name"]:28} [{status}] {err}')
