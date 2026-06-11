// FramePlayer — the view-side playback engine for the headless-broadcast decouple.
//
// The engine (game.js) emits board frames + semantic events to a bus and runs
// FREE: it never awaits the view. The FramePlayer buffers what arrives and plays
// it on its OWN clock through registered handlers, so ALL pacing and overlays live
// here — strictly downstream of the engine. A slow, wedged, or closed view drains
// slowly or not at all, and the engine is none the wiser. That is the whole point:
// the freeze class (engine awaiting the renderer) cannot exist when the renderer
// is a subscriber the engine doesn't wait on.
//
// Mirrors the spectator's drainEvents() house pattern (js/spectator.js): play
// items sequentially, a handler throw never wedges the queue, re-check after each.
//
// Each item is a plain object with a string `kind` and an optional monotonic
// `seq`. Handlers are async; the player awaits each so a handler's own delays
// (a reveal hold, an overlay's hide timer) ARE the pacing — moved off the engine.
//
// `coalesce` kinds (e.g. per-step sim frames) collapse when the player falls
// behind: a run of the same kind at the queue head plays only its LAST item, so a
// burst the free-running engine dumped is caught up to without lag. Non-coalescable
// events (round-end, ai-turn, game-over) always play in full — they're the beats.

export class FramePlayer {
    constructor({ onIdle = null } = {}) {
        this._q = [];
        this._handlers = new Map();   // kind -> async (item) => void
        this._coalesce = new Set();   // kinds that collapse when behind
        this._draining = false;
        this._lastSeq = -1;
        this._stopped = false;
        this._onIdle = onIdle;        // called when the queue empties (tests/HUD)
    }

    // Register the async handler for a kind. Chainable. Last registration wins.
    on(kind, handler) { this._handlers.set(kind, handler); return this; }

    // Mark kinds collapsible: when the player is behind, a run of these at the
    // head plays only the latest. Chainable.
    coalesce(...kinds) { kinds.forEach((k) => this._coalesce.add(k)); return this; }

    get pending() { return this._q.length; }
    get draining() { return this._draining; }

    // Enqueue a frame/event and kick the drain. Items arriving while a handler is
    // mid-play simply queue; the running drain picks them up (no re-entrancy).
    // A stale seq (<= the last one we began playing) is dropped: the bus is
    // monotonic, so this only guards duplicate/out-of-order delivery.
    push(item) {
        if (this._stopped || item == null) return;
        if (typeof item.seq === 'number' && item.seq <= this._lastSeq) return;
        this._q.push(item);
        if (!this._draining) this._drain();
    }

    async _drain() {
        if (this._draining) return;
        this._draining = true;
        try {
            while (this._q.length && !this._stopped) {
                let item = this._q.shift();
                // Collapse a run of the same coalescable kind to its last item.
                if (this._coalesce.has(item.kind)) {
                    while (this._q.length && this._q[0].kind === item.kind) item = this._q.shift();
                }
                // Stale/out-of-order guard at PLAY time (push-time alone can't catch
                // a frame that queued before its predecessor began playing).
                if (typeof item.seq === 'number') {
                    if (item.seq <= this._lastSeq) continue;
                    this._lastSeq = item.seq;
                }
                const h = this._handlers.get(item.kind);
                if (!h) continue;                              // unknown kind: skip, don't stall
                try { await h(item); }
                catch (_) { /* a view error must never wedge the queue */ }
            }
        } finally {
            this._draining = false;
            // A handler may have enqueued more while we were finishing — keep going.
            if (this._q.length && !this._stopped) { this._drain(); return; }
            if (this._onIdle) { try { this._onIdle(); } catch (_) {} }
        }
    }

    // Drop everything pending and stop playing (e.g. a new match starts, or the
    // operator switches views). Handlers in flight finish; nothing new is played
    // until push() is called again after reset() clears the stop.
    stop() { this._stopped = true; this._q.length = 0; }

    reset() { this._q.length = 0; this._lastSeq = -1; this._stopped = false; this._draining = false; }
}
