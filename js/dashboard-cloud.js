// Biome Analytics — particle-field engine + the field specs built on it.
//
// createField() is a general animated cloud: a `build(data)` function maps the
// live payload into clusters at normalized (nx, ny) positions; the engine eases
// them into place, renders family-hued particle puffs, axes, labels (with
// collision avoidance) and hover tooltips. Every panel below is just a build()
// + axes pair, so they all share one renderer and one aesthetic:
//
//   • Performance Field  — model clusters, win rate × ELO  (createCloud wrapper)
//   • Biome Scores       — model clusters, best ecosystem score × ELO
//   • Match Conditions   — one puff per match, columned by map size / rounds
//   • Decisiveness       — one puff per match, victory margin × total biomass
//
// Lifecycle-safe: update(data)/setSpec()/destroy(); pauses when the tab hides.

import { resolveModel } from './model-identity.js';

const short = (m) => (m || '—').replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
const hueOf = (m) => resolveModel(m).hue;
const famOf = (m) => resolveModel(m).family.label || '—';
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fmtK = (v) => v == null ? '—' : (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
// Deterministic [-1,1] jitter from a string key, so puffs don't twitch each poll.
function jitter(key, salt = 0) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < key.length; i++) { h = Math.imul(h ^ key.charCodeAt(i), 16777619); }
    return ((h >>> 0) / 4294967295) * 2 - 1;
}

// ── the engine ───────────────────────────────────────────────
export function createField(container, opts = {}) {
    const interactive = !!opts.interactive;
    const onPick = opts.onPick || null;
    // Hold the whole spec so spec.build runs with `this`=spec and spec.axes
    // (which may be a getter that depends on the last build) re-reads each frame.
    let spec = opts.spec || { build: opts.build, axes: opts.axes };
    const maxParticles = opts.maxParticles ?? 1400;

    const canvas = document.createElement('canvas');
    canvas.className = 'dd-cloud-canvas';
    container.innerHTML = '';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0;
    let clusters = [];
    let raf = null, running = true;
    let hover = null, mouse = { x: -1, y: -1 };
    let clearPending = 0;   // frames to hard-clear (on spec swap) instead of trail-fade
    const pad = { t: 26, r: 24, b: 36, l: 50 };

    function resize() {
        const rect = container.getBoundingClientRect();
        W = Math.max(120, Math.floor(rect.width));
        H = Math.max(120, Math.floor(rect.height));
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const ro = new ResizeObserver(resize); ro.observe(container); resize();

    function update(data) {
        if (!spec || !spec.build) return;
        const next = spec.build(data) || [];
        // cap particle budget: thin the per-cluster particle counts if needed
        const totalW = next.reduce((s, c) => s + (c.weight || 1), 0) || 1;
        const prev = new Map(clusters.map(c => [c.key, c]));
        clusters = next.map(spec => {
            const c = prev.get(spec.key) || { key: spec.key, nx: spec.nx, ny: spec.ny, parts: [] };
            Object.assign(c, {
                hue: spec.hue, tnx: clamp01(spec.nx), tny: clamp01(spec.ny),
                weight: spec.weight || 1, tip: spec.tip, label: spec.label,
                labelPriority: spec.labelPriority ?? 9999, pick: spec.pick,
            });
            const n = Math.max(4, Math.min(24, Math.round(4 + (c.weight / totalW) * next.length * 8)));
            while (c.parts.length < n) c.parts.push(mkPart(c.key, c.parts.length));
            if (c.parts.length > n) c.parts.length = n;
            c.spread = 7 + Math.sqrt(c.parts.length) * 3.2;
            return c;
        });
    }
    function setSpec(s) { spec = s; clearPending = 4; }   // wipe ghost axes/labels from the old spec

    function mkPart(key, i) {
        return {
            ang: (jitter(key, i * 7) + 1) * Math.PI,
            rad: Math.pow((jitter(key, i * 13) + 1) / 2, 0.7),
            spin: jitter(key, i * 17) * 0.5,
            breathe: (jitter(key, i * 19) + 1) * Math.PI,
            bspeed: 0.5 + (jitter(key, i * 23) + 1) / 2,
            size: 0.8 + (jitter(key, i * 29) + 1) * 0.8,
        };
    }

    function frame() {
        if (!running) return;
        ctx.globalCompositeOperation = 'source-over';
        if (clearPending > 0) { clearPending--; ctx.clearRect(0, 0, W, H); }
        else { ctx.fillStyle = 'rgba(7,8,20,0.34)'; ctx.fillRect(0, 0, W, H); }
        drawAxes();

        const gw = W - pad.l - pad.r, gh = H - pad.t - pad.b;
        ctx.globalCompositeOperation = 'lighter';
        hover = null;
        let drawn = 0;
        for (const c of clusters) {
            c.nx += (c.tnx - c.nx) * 0.07;
            c.ny += (c.tny - c.ny) * 0.07;
            const cx = pad.l + c.nx * gw, cy = pad.t + (1 - c.ny) * gh;
            c._cx = cx; c._cy = cy;
            const baseL = 48 + c.ny * 24;
            for (const p of c.parts) {
                if (drawn++ > maxParticles) break;
                p.ang += p.spin * 0.012; p.breathe += p.bspeed * 0.02;
                const r = c.spread * (0.35 + p.rad * (1 + 0.12 * Math.sin(p.breathe)));
                const px = cx + Math.cos(p.ang) * r, py = cy + Math.sin(p.ang) * r * 0.85;
                ctx.fillStyle = `hsla(${c.hue},72%,${baseL}%,${0.10 + (1 - p.rad) * 0.30})`;
                ctx.beginPath(); ctx.arc(px, py, p.size, 0, Math.PI * 2); ctx.fill();
            }
            ctx.fillStyle = `hsla(${c.hue},88%,${Math.min(82, baseL + 16)}%,0.9)`;
            ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
            if (interactive && mouse.x >= 0) {
                const d = Math.hypot(mouse.x - cx, mouse.y - cy);
                if (d < Math.max(13, c.spread) && (!hover || d < hover._d)) { hover = c; hover._d = d; }
            }
        }

        ctx.globalCompositeOperation = 'source-over';
        const placed = [];
        const cand = clusters.filter(c => c.label).sort((a, b) => a.labelPriority - b.labelPriority);
        for (const c of cand) tryLabel(c, c === hover, placed, false);
        if (hover && hover.label && !cand.includes(hover)) tryLabel(hover, true, placed, true);
        if (hover && hover.tip) drawTooltip(hover);
        raf = requestAnimationFrame(frame);
    }

    function tryLabel(c, strong, placed, force) {
        ctx.font = `${strong ? 700 : 600} 11px 'Segoe UI', system-ui, sans-serif`;
        const w = ctx.measureText(c.label).width;
        const box = { x: c._cx - w / 2, y: c._cy - c.spread - 18, w, h: 14 };
        if (!force) for (const p of placed) if (ov(box, p)) return;
        ctx.textAlign = 'center';
        ctx.fillStyle = strong ? `hsl(${c.hue},85%,82%)` : `hsla(${c.hue},65%,77%,0.78)`;
        ctx.fillText(c.label, c._cx, c._cy - c.spread - 6);
        placed.push(box);
    }
    const ov = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);

    function drawTooltip(c) {
        const lines = c.tip || [];
        if (!lines.length) return;
        ctx.font = `600 11px 'Segoe UI', system-ui, sans-serif`;
        const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
        const h = lines.length * 15 + 10;
        let bx = c._cx + 12, by = c._cy - h - 8;
        if (bx + w > W) bx = c._cx - w - 12;
        if (by < 0) by = c._cy + 12;
        ctx.fillStyle = 'rgba(10,14,28,0.92)';
        ctx.strokeStyle = `hsla(${c.hue},70%,55%,0.6)`;
        rr(bx, by, w, h, 7); ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
            ctx.fillStyle = i === 0 ? `hsl(${c.hue},75%,78%)` : 'rgba(231,235,245,0.8)';
            ctx.font = `${i === 0 ? 700 : 500} 11px 'Segoe UI', system-ui, sans-serif`;
            ctx.fillText(l, bx + 8, by + 16 + i * 15);
        });
    }
    function rr(x, y, w, h, r) {
        ctx.beginPath(); ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    function drawAxes() {
        const axes = (spec && spec.axes) || {};
        const gw = W - pad.l - pad.r, gh = H - pad.t - pad.b;
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
            const x = pad.l + (gw / 4) * i, y = pad.t + (gh / 4) * i;
            ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gh);
            ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y);
        }
        ctx.stroke();
        // optional vertical group dividers
        if (axes.dividers) {
            ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath();
            for (const f of axes.dividers) { const x = pad.l + f * gw; ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gh); }
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(231,235,245,0.42)';
        ctx.font = `600 9px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        if (axes.xLabel) ctx.fillText(axes.xLabel, pad.l + gw / 2, H - 7);
        if (axes.yLabel) { ctx.save(); ctx.translate(12, pad.t + gh / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(axes.yLabel, 0, 0); ctx.restore(); }
        ctx.fillStyle = 'rgba(231,235,245,0.3)';
        for (const t of (axes.xTicks || [])) ctx.fillText(t.label, pad.l + t.f * gw, pad.t + gh + 14);
        ctx.textAlign = 'right';
        for (const t of (axes.yTicks || [])) ctx.fillText(t.label, pad.l - 6, pad.t + (1 - t.f) * gh + 3);
    }

    function onMove(e) { const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; }
    function onLeave() { mouse.x = -1; mouse.y = -1; }
    function onClick() { if (hover && hover.pick && onPick) onPick(hover.pick); }
    if (interactive) {
        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mouseleave', onLeave);
        canvas.addEventListener('click', onClick);
        canvas.style.cursor = 'crosshair';
    }
    const onVis = () => { if (document.hidden) stop(); else loop(); };
    document.addEventListener('visibilitychange', onVis);
    function loop() { if (!raf && running) raf = requestAnimationFrame(frame); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    if (opts.initial) update(opts.initial);
    loop();
    return {
        update, setSpec,
        destroy() {
            running = false; stop(); ro.disconnect();
            document.removeEventListener('visibilitychange', onVis);
            if (interactive) {
                canvas.removeEventListener('mousemove', onMove);
                canvas.removeEventListener('mouseleave', onLeave);
                canvas.removeEventListener('click', onClick);
            }
            container.innerHTML = '';
        },
    };
}

// ── field specs (build + axes) ───────────────────────────────
const NX = (f) => 0.08 + clamp01(f) * 0.84;   // pad the data range off the edges

// Performance Field — model clusters: win rate × ELO.
export function perfSpec() {
    return {
        axes: { xLabel: 'WIN RATE →', yLabel: 'ELO →', xTicks: [0, 25, 50, 75, 100].map(w => ({ f: NX(w / 100), label: w + '%' })) },
        build(data) {
            const rows = (data?.leaderboard || []).filter(r => r.matches > 0);
            if (!rows.length) return [];
            const { lo, hi } = eloDomain(rows);
            const maxG = Math.max(...rows.map(r => r.matches), 1);
            return rows.map(r => ({
                key: r.model, hue: hueOf(r.model),
                nx: NX(r.winrate / 100), ny: NX((r.elo - lo) / (hi - lo)),
                weight: 4 + (r.matches / maxG) * 20,
                label: short(r.model), labelPriority: r.rank, pick: r.model,
                tip: [short(r.model), `ELO ${r.elo} · ${r.winrate}%`, `${r.wins}-${r.losses} · ${r.matches} games`],
            }));
        },
    };
}

// Biome Scores — model clusters: best ecosystem score × ELO.
export function biomeSpec() {
    return {
        axes: { xLabel: 'BEST BIOME SCORE →', yLabel: 'ELO →' },
        build(data) {
            const rows = (data?.leaderboard || []).filter(r => r.matches > 0);
            const agg = scoreAgg(data?.match_points || []);
            const scored = rows.filter(r => agg[r.model]);
            if (!scored.length) return [];
            const { lo, hi } = eloDomain(scored);
            const maxBest = Math.max(...scored.map(r => agg[r.model].best), 1);
            const maxG = Math.max(...scored.map(r => r.matches), 1);
            return scored.map(r => {
                const a = agg[r.model];
                return {
                    key: r.model, hue: hueOf(r.model),
                    nx: NX(a.best / maxBest), ny: NX((r.elo - lo) / (hi - lo)),
                    weight: 4 + (r.matches / maxG) * 20,
                    label: short(r.model), labelPriority: maxBest - a.best, pick: r.model,
                    tip: [short(r.model), `best ${fmtK(a.best)} · avg ${fmtK(a.sum / a.n)}`, `ELO ${r.elo} · ${a.n} games`],
                };
            });
        },
    };
}

// Match Conditions — one puff per match, columned by map size or round count.
const MAP_ORDER = ['auto', 'small', 'medium', 'large'];
export function conditionsSpec(groupBy = 'map_size') {
    const fmtGroup = (g) => groupBy === 'rounds' ? `${g} rounds` : (g === 'auto' ? 'fit screen' : cap(g));
    return {
        groupBy,
        build(data) {
            const mp = (data?.match_points || []).filter(m => m[groupBy] != null && (m.p1_score || m.p2_score));
            if (!mp.length) { this._groups = []; return []; }
            let groups = [...new Set(mp.map(m => String(m[groupBy])))];
            groups.sort(groupBy === 'rounds'
                ? (a, b) => Number(a) - Number(b)
                : (a, b) => MAP_ORDER.indexOf(a) - MAP_ORDER.indexOf(b));
            this._groups = groups;
            const maxTot = Math.max(...mp.map(m => (m.p1_score || 0) + (m.p2_score || 0)), 1);
            const slot = 1 / groups.length, colW = slot * 0.62;
            return mp.map((m, i) => {
                const gi = groups.indexOf(String(m[groupBy]));
                const total = (m.p1_score || 0) + (m.p2_score || 0);
                const key = `${m.played_at}|${m.winner}|${m.loser}|${i}`;
                const fx = (gi + 0.5) * slot + jitter(key) * colW * 0.5;
                return {
                    key, hue: hueOf(m.winner), weight: 1,
                    nx: NX(fx), ny: NX(total / maxTot), pick: m.winner,
                    tip: [`${short(m.winner)} beat ${short(m.loser)}`, `score ${fmtK(m.p1_score)}–${fmtK(m.p2_score)}`,
                          `${cap(m.mode || '')} · ${m.map_size === 'auto' ? 'fit' : m.map_size} · ${m.rounds}r`],
                };
            });
        },
        get axes() {
            const groups = this._groups || [];
            const slot = groups.length ? 1 / groups.length : 1;
            return {
                xLabel: groupBy === 'rounds' ? 'ROUNDS →' : 'MAP SIZE →', yLabel: 'TOTAL BIOME SCORE →',
                xTicks: groups.map((g, i) => ({ f: NX((i + 0.5) * slot), label: fmtGroup(g) })),
                dividers: groups.slice(1).map((_, i) => NX((i + 1) * slot)),
            };
        },
    };
}

// Decisiveness — one puff per match: victory margin × total biomass.
export function decisivenessSpec() {
    return {
        axes: { xLabel: 'MARGIN (close → blowout) →', yLabel: 'TOTAL BIOMASS →' },
        build(data) {
            const mp = (data?.match_points || []).filter(m => (m.p1_score || m.p2_score));
            if (!mp.length) return [];
            const maxM = Math.max(...mp.map(m => m.margin || 0), 1);
            const maxT = Math.max(...mp.map(m => (m.p1_score || 0) + (m.p2_score || 0)), 1);
            return mp.map((m, i) => {
                const total = (m.p1_score || 0) + (m.p2_score || 0);
                return {
                    key: `${m.played_at}|${m.winner}|${m.loser}|${i}`, hue: hueOf(m.winner), weight: 1,
                    nx: NX((m.margin || 0) / maxM), ny: NX(total / maxT), pick: m.winner,
                    tip: [`${short(m.winner)} beat ${short(m.loser)}`, `margin ${fmtK(m.margin)} · total ${fmtK(total)}`,
                          `${cap(m.mode || '')} · ${m.map_size === 'auto' ? 'fit' : m.map_size} · ${m.rounds}r`],
                };
            });
        },
    };
}

function scoreAgg(matchPoints) {
    const agg = {};
    const push = (model, s) => {
        if (model == null || s == null) return;
        const a = agg[model] || (agg[model] = { best: 0, sum: 0, n: 0 });
        a.best = Math.max(a.best, s); a.sum += s; a.n++;
    };
    for (const m of matchPoints) { push(m.p1, m.p1_score); push(m.p2, m.p2_score); }
    return agg;
}
function eloDomain(rows) {
    const elos = rows.map(r => r.elo);
    let lo = Math.min(...elos), hi = Math.max(...elos);
    if (hi - lo < 40) { const mid = (hi + lo) / 2; lo = mid - 25; hi = mid + 25; }
    return { lo, hi };
}

// Back-compat wrapper: the original performance-field entry point.
export function createCloud(container, opts = {}) {
    return createField(container, {
        spec: perfSpec(),
        interactive: opts.interactive, onPick: opts.onPick,
        maxParticles: opts.maxParticles, initial: opts.initial,
    });
}
