// BroadcastCarousel — a small rotating-panel engine for the on-board "flank"
// panels during a live tournament match. It mounts a flip stage + a progress bar
// into a flank element, then cycles a list of panels every `intervalMs`, doing a
// rotateY card-flip on each advance (ESPN-style). The engine is generic: callers
// hand it a list of panels, each a `{ id, render }` where render() returns
// `{ html, paint? }` (or null) built from already-fetched data — so render stays
// synchronous and the flip never waits on the network.
//
// Lifecycle is gen-guarded: every start()/stop() bumps a generation counter, and
// any in-flight flip bails if it's been superseded — so re-starting for a new
// matchup (or hiding the flank) can't leave a half-finished flip on screen.

import { teardownClips } from './model-avatar.js';
import { breadcrumbSync } from './heartbeat.js';

const FLIP_MS = 300;

export class BroadcastCarousel {
    constructor(el, { intervalMs = 10000 } = {}) {
        this.el = typeof el === 'string' ? document.getElementById(el) : el;
        this.intervalMs = intervalMs;
        this.panels = [];
        this.idx = 0;
        this.timer = null;
        this.gen = 0;
        this.stage = null;
        this.prog = null;
    }

    _mount() {
        if (this.stage && this.stage.isConnected) return;
        this.el.classList.add('mf-carousel');
        this.el.innerHTML = `<div class="mf-stage"></div><div class="mf-prog"><span></span></div>`;
        this.stage = this.el.querySelector('.mf-stage');
        this.prog = this.el.querySelector('.mf-prog span');
    }

    // panels: [{ id, render: () => ({ html, paint? }) | null }]
    start(panels) {
        this.stop();
        this.panels = (panels || []).filter(Boolean);
        if (!this.el || !this.panels.length) return;
        const gen = ++this.gen;
        this._mount();
        this.idx = 0;
        this._show(this.idx, false, gen);
        this._resetProgress();
        if (this.panels.length > 1) this._schedule(gen);
    }

    stop() {
        this.gen++;                       // invalidate any in-flight render/flip/timer
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.stage) teardownClips(this.stage);
    }

    _schedule(gen) {
        this.timer = setTimeout(() => {
            if (gen !== this.gen) return;
            this._advance(gen);
        }, this.intervalMs);
    }

    async _advance(gen) {
        const next = (this.idx + 1) % this.panels.length;
        await this._show(next, true, gen);
        if (gen !== this.gen) return;
        this.idx = next;
        this._resetProgress();
        this._schedule(gen);
    }

    async _show(i, flip, gen) {
        let payload = null;
        // Tripwire: a freeze inside a panel's synchronous render() leaves
        // 'carousel.render' (with the panel id) as the last crumb, naming the exact
        // culprit panel. (renderer-SIGILL→hang hunt.)
        breadcrumbSync('carousel.render', { id: this.panels[i]?.id });
        try { payload = this.panels[i].render(); } catch (_) { payload = null; }
        breadcrumbSync('carousel.rendered', { id: this.panels[i]?.id });
        if (gen !== this.gen) return;
        if (!payload) payload = { html: `<div class="mf-empty">—</div>` };

        if (flip) {
            const s = this.stage;
            s.style.transition = `transform ${FLIP_MS}ms ease-in`;
            s.style.transform = 'rotateY(90deg)';
            await wait(FLIP_MS);
            if (gen !== this.gen) return;
            this._swap(payload);
            s.style.transition = 'none';
            s.style.transform = 'rotateY(-90deg)';
            void s.offsetWidth;                       // commit the pre-flip pose
            s.style.transition = `transform ${FLIP_MS}ms ease-out`;
            s.style.transform = 'rotateY(0deg)';
        } else {
            this._swap(payload);
        }
    }

    _swap(payload) {
        teardownClips(this.stage);                    // stop departing clips
        this.stage.innerHTML = payload.html;
        try { payload.paint?.(this.stage); } catch (_) {}
    }

    // Restart the 0→100% fill so the bar tracks the dwell on the current panel.
    _resetProgress() {
        if (!this.prog) return;
        this.prog.style.transition = 'none';
        this.prog.style.width = '0%';
        void this.prog.offsetWidth;
        if (this.panels.length > 1) {
            this.prog.style.transition = `width ${this.intervalMs}ms linear`;
            this.prog.style.width = '100%';
        }
    }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
