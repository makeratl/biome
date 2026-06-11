// LivePublisher — pushes the live tournament feed from the driving browser to the
// server's in-memory relay so the public spectator page can watch in real time.
//
// One stream: snapshot JSON — bracket/scoreboard state AND the board as state
// (occupied cells; see _buildLiveSnapshot/serializeBoard), pushed on every tick.
// The spectator draws the board itself via BoardFrameView (shared organism-art),
// so there is no canvas read-back and no WebP image push — that 1.8s board-encode
// loop was the heavy freeze surface and has been retired.
//
// Fire-and-forget: a failed push must never disturb the tournament loop. We
// deliberately do NOT use `keepalive` — these fire during active play (not on
// unload), so we sidestep the 64 KiB keepalive cap that silently drops large
// bodies (see the capture keepalive note).

export class LivePublisher {
    // POST the current snapshot. `obj` is a plain serializable object built by the
    // tournament manager (see _buildLiveSnapshot) — bracket + scores + board-as-state.
    pushSnapshot(obj) {
        try {
            fetch('/tournament/live', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(obj),
            }).catch(() => {});
        } catch { /* never throw into the game loop */ }
    }
}
