// Out-of-process heartbeat — renderer-crash forensics.
//
// A renderer SIGILL ("Aw, Snap!") tears down the whole tab: the in-page DevTools
// console is wiped and any in-browser log dies with it, so nothing inside the
// renderer can ever report its own death. The only way to see the final moment is
// to ship vitals OUT of the renderer continuously. This posts a tiny packet (heap,
// DOM node count, current match/phase) to the server every second; the server
// appends + fsyncs each beat to dev-logs/heartbeat.log. After a crash, the last
// line on disk is the last second the tab was alive:
//   • the gap where beats stop  → WHEN it died
//   • heap climbing toward limit → OOM (JS heap leak; slope = seconds-to-death)
//   • heap flat but beats stop   → GPU/canvas memory or a driver fault, not JS
//   • a shipped error just before the gap → a JS throw accompanied the death
//
// Fire-and-forget: a failed beat must never disturb the game loop.

const BEAT_MS = 1000;

let seq = 0;
let timer = null;
const ctx = {};   // ambient context the app updates (match #, phase, label)

// The app calls this to stamp later beats with where we are (match number, phase,
// etc.) so a crash line says not just "heap was 3.9 GB" but "...during match 14".
export function setHeartbeatContext(patch) {
    Object.assign(ctx, patch);
}

function vitals(extra) {
    const m = performance.memory;   // Chrome-only; gated
    const mb = (b) => +(b / 1048576).toFixed(1);
    return {
        seq: ++seq,
        client_ts: Date.now(),
        ...ctx,
        ...extra,
        heapUsed: m ? mb(m.usedJSHeapSize) : null,
        heapTotal: m ? mb(m.totalJSHeapSize) : null,
        heapLimit: m ? mb(m.jsHeapSizeLimit) : null,
        dom: document.getElementsByTagName('*').length,   // unbounded DOM growth is a classic leak tell
        canvas: document.getElementsByTagName('canvas').length,
        video: document.getElementsByTagName('video').length,
    };
}

function send(record) {
    try {
        fetch('/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record),
            keepalive: true,   // tiny payload, well under the 64 KiB cap — lets a final beat flush during teardown
        }).catch(() => {});
    } catch { /* never throw into the game loop */ }
}

function beat(extra) { send(vitals(extra)); }

// A breadcrumb dropped right before a heavy SYNCHRONOUS step that might block the
// main thread. Uses navigator.sendBeacon, which hands the payload to the browser
// process immediately — so it flushes even if the main thread freezes a moment
// later (a queued fetch would not). After a hang, the last 'crumb' in
// heartbeat.log names the phase that never returned. Falls back to fetch.
export function breadcrumb(label, extra = {}) {
    const rec = { type: 'crumb', client_ts: Date.now(), label, ...ctx, ...extra };
    try {
        const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
        if (navigator.sendBeacon && navigator.sendBeacon('/heartbeat', blob)) return;
    } catch { /* fall through */ }
    send(rec);
}

// NOTE: this was a *synchronous* XHR ("guaranteed delivery, survives a block").
// But a sync XHR blocks the main thread until the server replies, and we sprinkled
// these on hot paths (board-push every 1.8s, every turn phase, every bracket
// render) against a server that fsyncs each write — i.e. the instrument itself
// could stall the very thread it was measuring. Now NON-BLOCKING: it delegates to
// the sendBeacon path. If "broadcast on" freezes vanish with this change, the sync
// XHR was the culprit, not the broadcast. If they persist, the broadcast is the
// real bug and the async crumbs (+ the 1 Hz heartbeat) still localize it.
export function breadcrumbSync(label, extra = {}) {
    breadcrumb(label, extra);
}

export function startHeartbeat() {
    if (timer) return;
    beat({ type: 'boot' });   // delimit this session in the log
    timer = setInterval(() => beat({ type: 'beat' }), BEAT_MS);

    // A JS error or rejection often rides along with (or just precedes) an OOM
    // death — ship it immediately so the log carries the actual throw, not just
    // a silent gap.
    window.addEventListener('error', (e) => {
        beat({ type: 'error', msg: String(e.message || e.error || 'error'),
               src: `${e.filename || ''}:${e.lineno || ''}` });
    });
    window.addEventListener('unhandledrejection', (e) => {
        beat({ type: 'rejection', msg: String(e.reason?.message || e.reason || 'rejection') });
    });
}

export function stopHeartbeat() {
    if (timer) { clearInterval(timer); timer = null; }
}
