// LivePublisher — pushes a live tournament feed from the driving browser to the
// server's in-memory relay so the public spectator page can watch in real time.
//
// Two streams:
//   • snapshot JSON  — the bracket/scoreboard state, pushed on every bracket
//     repaint (match start, each round-end, match end, champion). Tiny payload.
//   • board image    — a downscaled WebP of #game-canvas, pushed on a throttle
//     while a match is live, so spectators see the ecosystem (not just numbers).
//
// Everything here is fire-and-forget: a failed push must never disturb the
// tournament loop. We deliberately do NOT use `keepalive` — these fire during
// active play (not on unload), so we sidestep the 64 KiB keepalive cap that
// silently drops large bodies (see the capture keepalive note).

import { breadcrumbSync } from './heartbeat.js';

const BOARD_INTERVAL_MS = 1800;   // how often the board snapshot refreshes
const BOARD_MAX_W = 960;          // downscale wide boards to keep pushes light
const BOARD_QUALITY = 0.6;        // WebP quality

export class LivePublisher {
    constructor() {
        this._boardTimer = null;
        this._boardInFlight = false;
        this._scratch = null;       // offscreen canvas for downscaling
    }

    // POST the current snapshot. `obj` is a plain serializable object built by
    // the tournament manager (see _buildLiveSnapshot).
    pushSnapshot(obj) {
        try {
            fetch('/tournament/live', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(obj),
            }).catch(() => {});
        } catch { /* never throw into the game loop */ }
    }

    // Begin throttled board-image pushes. Safe to call repeatedly.
    startBoardLoop() {
        if (this._boardTimer) return;
        this._pushBoard();   // immediate first frame
        this._boardTimer = setInterval(() => this._pushBoard(), BOARD_INTERVAL_MS);
    }

    stopBoardLoop() {
        if (this._boardTimer) { clearInterval(this._boardTimer); this._boardTimer = null; }
    }

    _pushBoard() {
        if (this._boardInFlight) return;   // don't pile up if the network is slow
        const src = document.getElementById('game-canvas');
        if (!src || !src.width || !src.height) return;
        // Tripwire: a freeze inside this 1.8s board-push leaves 'board.push.start'
        // as the last crumb with no 'board.push.end'. (renderer-SIGILL→hang hunt.)
        breadcrumbSync('board.push.start', { w: src.width, h: src.height });
        try {
            const scale = Math.min(1, BOARD_MAX_W / src.width);
            const w = Math.max(1, Math.round(src.width * scale));
            const h = Math.max(1, Math.round(src.height * scale));
            if (!this._scratch) this._scratch = document.createElement('canvas');
            const c = this._scratch;
            if (c.width !== w) c.width = w;
            if (c.height !== h) c.height = h;
            const ctx = c.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(src, 0, 0, w, h);
            this._boardInFlight = true;
            breadcrumbSync('board.push.end', {});
            c.toBlob((blob) => {
                if (!blob) { this._boardInFlight = false; return; }
                fetch('/tournament/live/board', {
                    method: 'POST',
                    headers: { 'Content-Type': 'image/webp' },
                    body: blob,
                }).catch(() => {}).finally(() => { this._boardInFlight = false; });
            }, 'image/webp', BOARD_QUALITY);
        } catch {
            this._boardInFlight = false;
            breadcrumbSync('board.push.end', { caught: true });
        }
    }
}
