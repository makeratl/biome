// Living Biosphere Orb — the animated whole-board ecosystem-health widget.
//
// Replaces the static terrain donut in the stats panel. A small circular
// terrarium whose ATMOSPHERE encodes health (cool/dim → green calm → red churn)
// while the creatures inside keep their PLAYER hue, so you read the shared
// ecosystem's mood at a glance and still sense the P1/P2 rivalry within it.
//
// Four moods, eased smoothly (never snapped):
//   dormant — empty board: cool, dim, still.
//   infant  — low population, just building: few faint sprites, slow.
//   zen     — near the 9:3:1 ideal: a calm radial trophic mandala (plants outer
//             ring → herbivores middle → predators centre), green glow.
//   alert   — imbalanced: rings dissolve into a jittery crowd, amber→red churn,
//             faster pulse. The CAPTION grades the alert further (STRAINED →
//             named imbalance → COLLAPSING) by SEVERITY, weighting problems at the
//             base (plants being eaten) graver than at the apex (predators glut).
//
// Data arrives every simulation step via update(census, events). The rAF loop
// animates between updates and bails cheaply when the console is collapsed.

import { drawOrganism, BASE_HEX } from './organism-art.js';
import { CONFIG } from './config.js';
import { trophicRead } from './trophic.js';

const MAX = 10;              // sprite cap — keep per-frame cost trivial
const SPRITE_R = 8.5;        // rendered creature radius (px), pre-`born` scale
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Deterministic [-1,1] noise from a string key, so a sprite's crowd position
// and phase don't twitch between updates.
function jitter(key, salt = 0) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return ((h >>> 0) / 4294967295) * 2 - 1;
}

// Ease a hue toward a target along the shortest arc (so red↔green never sweeps
// the whole colour wheel through yellow).
function easeHue(cur, tgt, t) {
    let d = ((tgt - cur + 540) % 360) - 180;
    return (cur + d * t + 360) % 360;
}

// Per-mood visual targets. intensity→glow/alpha, density→sprite count,
// motion→speed/jitter, ringiness→mandala(1)…crowd(0).
const MOODS = {
    dormant:    { word: 'DORMANT',    icon: '·', state: 'dormant'    },
    primordial: { word: 'PRIMORDIAL', icon: '🌿', state: 'primordial' },
    infant:     { word: 'BUILDING',   icon: '🌱', state: 'infant'     },
    zen:        { word: 'BALANCED',   icon: '✦', state: 'zen'        },
};

// Grade an alerting biome into a named, severity-coloured caption. `driver` is the
// worst-off player's trophicRead; `severity` is the tier-weighted collapse risk.
//   strained — amber: tilting off balance, recoverable.
//   alert    — orange: a named imbalance (apex glut/starve, base creeping).
//   collapse — red: the base itself is failing (herbivores starving, or eating a
//              shrinking plant base). Reserved for genuine collapse.
function alertMood(driver, severity) {
    if (driver.baseStarved)
        return { word: 'HERBIVORES STARVING', icon: '☠', state: 'collapse' };
    if (severity >= 0.8)
        return { word: 'COLLAPSING', icon: '☠', state: 'collapse' };
    if (severity < 0.55)
        return { word: 'STRAINED', icon: '⚠', state: 'strained' };
    if (driver.apexStarved)
        return { word: 'PREDATORS STARVING', icon: '⚠', state: 'alert' };
    if (driver.overTier === 'herb')
        return { word: 'OVERGRAZED', icon: '⚠', state: 'alert' };
    return { word: 'TOP-HEAVY', icon: '⚠', state: 'alert' };
}

export class Biosphere {
    constructor(canvas) {
        this.canvas = canvas || null;
        this.ctx = canvas ? canvas.getContext('2d') : null;
        // Caption + rim siblings (queried once; static markup).
        this.elCaption = document.getElementById('bio-caption');
        this.elWord = document.getElementById('bio-word');
        this.elIcon = document.getElementById('bio-icon');
        this.elRim = document.getElementById('bio-rim');

        this.W = 120; this.H = 120; this.dpr = 1;
        this.sprites = [];
        this.t = 0;        // breathing/aurora phase (seconds)
        this.rot = 0;      // slow global mandala rotation
        this.last = 0;
        this.raf = null;
        this.running = false;
        this._mood = 'dormant';
        this._capWord = null; // last caption word — alert family grades by word
        this._prevP = null;   // last combined plant count — trend for collapse reads

        // Eased visual state and its target.
        this.cur = { hue: 210, intensity: 0.15, density: 0, motion: 0.25, ringiness: 0.6 };
        this.tgt = { ...this.cur };

        if (this.canvas) {
            this._resize();
            this.ro = new ResizeObserver(() => this._resize());
            this.ro.observe(this.canvas);
        }
        this._onVis = () => { if (document.hidden) this.stop(); else this.start(); };
        document.addEventListener('visibilitychange', this._onVis);
    }

    _resize() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        this.W = Math.max(40, Math.round(rect.width) || 120);
        this.H = Math.max(40, Math.round(rect.height) || 120);
        this.dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(this.W * this.dpr);
        this.canvas.height = Math.round(this.H * this.dpr);
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    start() {
        if (!this.canvas || this.raf) return;
        this.running = true;
        this.raf = requestAnimationFrame((ts) => this._tick(ts));
    }
    stop() {
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }
    destroy() {
        this.running = false;
        this.stop();
        if (this.ro) this.ro.disconnect();
        document.removeEventListener('visibilitychange', this._onVis);
    }

    // ── data → mood + sprite reconciliation ─────────────────────────────
    update(census, events) {
        if (!census) return;
        const c1 = census[1] || {}, c2 = census[2] || {};
        const P = (c1.plants || 0) + (c2.plants || 0);
        const H = (c1.herbivores || 0) + (c2.herbivores || 0);
        const R = (c1.predators || 0) + (c2.predators || 0);
        const total = P + H + R;
        const tiers = (P > 0) + (H > 0) + (R > 0);

        // Shared trophic read — the SAME evaluation the AI prompt uses. Risk is
        // per-player then worst-wins: overgrazing lives inside one biome, so a
        // big plant base on one side mustn't mask the other's herbivore overload.
        const read1 = trophicRead(c1.plants, c1.herbivores, c1.predators);
        const read2 = trophicRead(c2.plants, c2.herbivores, c2.predators);
        const board = trophicRead(P, H, R);   // combined — drives the calm/zen read
        const health = board.health;

        // Layer live starvation on top of the count-based risk.
        const starve = events
            ? ((events[1]?.herbStarved || 0) + (events[1]?.predStarved || 0)
             + (events[2]?.herbStarved || 0) + (events[2]?.predStarved || 0))
            : 0;
        const starveNorm = clamp(starve / Math.max(8, total * 0.25), 0, 1);
        const collapseRisk = clamp(Math.max(read1.risk, read2.risk, starveNorm), 0, 1);

        // Is the plant base shrinking? (<0 = losing plants step over step.) The
        // worst-off biome drives the alert read — collapse lives in one biome.
        const plantTrend = this._prevP > 0 ? (P - this._prevP) / this._prevP : 0;
        this._prevP = P;
        const driver = read1.risk >= read2.risk ? read1 : read2;

        // Tier-weighted severity. A problem at the BASE (herbivores eating the
        // plant base, esp. while it shrinks) is graver than one at the APEX
        // (predators glutting/starving) — the latter can't alone turn the orb red.
        let severity = collapseRisk;
        const baseProblem = driver.overTier === 'herb' || driver.baseStarved;
        const apexOnly = !baseProblem && (driver.apexStarved || driver.overTier === 'pred');
        if (baseProblem && plantTrend < -0.08)
            severity = clamp(severity + (-plantTrend) * 2, 0.8, 1);
        if (apexOnly) severity = Math.min(severity, 0.78);

        // Classify the mood family. ALERT is genuine collapse risk only — a flipped
        // pyramid (a tier exceeding what feeds it) or starvation. A missing
        // UPPER tier isn't risk, just an unfinished web (primordial/building);
        // plants alone are a self-sustaining green base. The alert caption is then
        // graded by severity (STRAINED → named imbalance → COLLAPSING).
        let mood;
        if (total === 0) mood = 'dormant';
        else if (collapseRisk > 0.4) mood = 'alert';
        else if (H === 0 && R === 0) mood = 'primordial';
        else if (board.tiers === 3 && health > 0.6) mood = 'zen';
        else mood = 'infant';

        // Map mood → eased visual targets.
        const popFactor = clamp(total / 30, 0, 1);
        if (mood === 'dormant') {
            this.tgt = { hue: 212, intensity: 0.14, density: 0, motion: 0.22, ringiness: 0.6 };
        } else if (mood === 'primordial') {
            // Lush, calm green base — alive and fine, just no animals yet.
            this.tgt = { hue: 96, intensity: 0.4 + popFactor * 0.15, density: clamp(0.3 + popFactor * 0.55, 0.2, 0.85), motion: 0.28, ringiness: 0.92 };
        } else if (mood === 'infant') {
            this.tgt = { hue: lerp(170, 150, popFactor), intensity: 0.4, density: clamp(0.3 + popFactor * 0.5, 0.15, 0.8), motion: 0.4, ringiness: 0.8 };
        } else if (mood === 'zen') {
            this.tgt = { hue: 135, intensity: 0.55 + health * 0.35, density: 0.7 + popFactor * 0.3, motion: 0.3, ringiness: 1.0 };
        } else { // alert — amber (strained) → red (collapsing), tracking severity
            this.tgt = { hue: lerp(48, 4, severity), intensity: 0.55 + severity * 0.45, density: 0.8 + popFactor * 0.2, motion: 0.45 + severity * 0.75, ringiness: clamp(1 - severity, 0.1, 0.8) };
        }

        // Caption (flips instantly; the orb's easing carries the smoothness). The
        // alert family is graded further, so gate on the WORD, not just the family.
        const cap = mood === 'alert' ? alertMood(driver, severity) : MOODS[mood];
        if (cap.word !== this._capWord) {
            this._capWord = cap.word;
            if (this.elWord) this.elWord.textContent = cap.word;
            if (this.elIcon) this.elIcon.textContent = cap.icon;
            if (this.elCaption) this.elCaption.dataset.state = cap.state;
            if (this.elRim) this.elRim.dataset.state = cap.state;
        }
        this._mood = mood;

        this._reconcile(this._buildDesired(census, health));
    }

    // Build a capped, softened-pyramid sample of {id, species, player, tier, energy}.
    _buildDesired(census, health) {
        const total = ['plants', 'herbivores', 'predators']
            .reduce((s, k) => s + (census[1][k] || 0) + (census[2][k] || 0), 0);
        if (total === 0) return [];
        const popFactor = clamp(total / 30, 0, 1);
        const count = clamp(Math.round(MAX * (0.4 + popFactor * 0.6)), Math.min(3, total), MAX);

        const TIERS = [
            { type: 'plant',     share: 0.50 },
            { type: 'herbivore', share: 0.33 },
            { type: 'predator',  share: 0.17 },
        ];
        // Collect (player,species,count) pairs per tier from bySpecies.
        const tierPairs = {};
        let presentShare = 0;
        for (const t of TIERS) {
            const pairs = [];
            for (const p of [1, 2]) {
                const by = census[p].bySpecies || {};
                for (const sp of Object.keys(by)) {
                    if (CONFIG.SPECIES[sp]?.type === t.type && by[sp] > 0) {
                        pairs.push({ species: sp, player: p, count: by[sp] });
                    }
                }
            }
            tierPairs[t.type] = pairs;
            if (pairs.length) presentShare += t.share;
        }
        if (presentShare === 0) return [];

        const desired = [];
        for (const t of TIERS) {
            const pairs = tierPairs[t.type];
            if (!pairs.length) continue;
            const n = Math.max(1, Math.round(count * (t.share / presentShare)));
            const tierIdx = t.type === 'plant' ? 0 : t.type === 'herbivore' ? 1 : 2;
            for (const a of this._allocate(pairs, n)) {
                const slot = desired.filter(d => d.player === a.player && d.species === a.species).length;
                const maxE = CONFIG.SPECIES[a.species].maxEnergy;
                desired.push({
                    id: `${a.player}:${a.species}:${slot}`,
                    species: a.species, player: a.player, tier: tierIdx,
                    energy: maxE * (0.55 + 0.35 * health),
                });
            }
        }
        return desired;
    }

    // Largest-remainder allocation of n slots across weighted pairs (stable order).
    _allocate(pairs, n) {
        const totalW = pairs.reduce((s, p) => s + p.count, 0) || 1;
        const sorted = [...pairs].sort((a, b) =>
            (a.player - b.player) || a.species.localeCompare(b.species));
        const quota = sorted.map(p => ({ pair: p, exact: (p.count / totalW) * n }));
        const out = [];
        quota.forEach(q => { q.floor = Math.floor(q.exact); for (let i = 0; i < q.floor; i++) out.push(q.pair); });
        let rem = n - out.length;
        quota.sort((a, b) => (b.exact - b.floor) - (a.exact - a.floor));
        for (let i = 0; rem > 0 && i < quota.length; i++, rem--) out.push(quota[i].pair);
        return out;
    }

    // Diff desired vs live sprites by id: keep & retarget shared, fade in new,
    // fade out dropped. Preserves eased positions/phase so nothing twitches.
    _reconcile(desired) {
        const want = new Map(desired.map(d => [d.id, d]));
        const live = new Map(this.sprites.map(s => [s.id, s]));

        for (const [id, d] of want) {
            const s = live.get(id);
            if (s) {
                s.tier = d.tier; s.tEnergy = d.energy; s.alive = true;
            } else {
                this.sprites.push({
                    id: d.id, species: d.species, player: d.player, tier: d.tier,
                    energy: d.energy, tEnergy: d.energy, born: 0, alive: true,
                    x: 0, y: 0,
                    jx: jitter(d.id, 3), jy: jitter(d.id, 7),
                    phase: (jitter(d.id, 11) + 1) * Math.PI,
                    ang: (jitter(d.id, 13) + 1) * Math.PI,
                });
            }
        }
        for (const [id, s] of live) if (!want.has(id)) s.alive = false;
    }

    // ── render ──────────────────────────────────────────────────────────
    _tick(ts) {
        this.raf = requestAnimationFrame((t) => this._tick(t));

        const hc = document.getElementById('hud-console');
        if (document.hidden || !this.ctx ||
            (hc && (hc.classList.contains('hc-hidden') || hc.classList.contains('hc-collapsed')))) {
            this.last = ts; // keep dt sane on resume
            return;
        }

        const dt = this.last ? clamp((ts - this.last) / 1000, 0, 0.05) : 0.016;
        this.last = ts;
        this.t += dt;

        // Ease visual state toward target.
        const k = clamp(dt * 4, 0, 0.2);
        this.cur.hue = easeHue(this.cur.hue, this.tgt.hue, k);
        for (const key of ['intensity', 'density', 'motion', 'ringiness']) {
            this.cur[key] += (this.tgt[key] - this.cur[key]) * k;
        }
        this.rot += dt * (0.12 + this.cur.motion * 0.35);

        this._draw();
    }

    _draw() {
        const ctx = this.ctx, W = this.W, H = this.H;
        const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 3;
        const { hue, intensity, density, motion, ringiness } = this.cur;

        ctx.save();
        ctx.clearRect(0, 0, W, H);
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();

        // Atmosphere: dark base + two drifting radial glows (screen-blended).
        ctx.fillStyle = `hsl(${hue}, 55%, 7%)`;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'lighter';
        const blob = (ox, oy, rad, h, a) => {
            const g = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, rad);
            g.addColorStop(0, `hsla(${h}, 72%, 24%, ${a})`);
            g.addColorStop(1, 'hsla(0,0%,0%,0)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
        };
        blob(Math.cos(this.t * 0.18) * R * 0.35, Math.sin(this.t * 0.12) * R * 0.30, R * 1.15, hue, 0.25 + intensity * 0.55);
        blob(Math.cos(this.t * 0.11 + 2) * R * 0.30, Math.sin(this.t * 0.16 + 1) * R * 0.34, R * 0.95, hue + 16, 0.18 + intensity * 0.4);
        ctx.globalCompositeOperation = 'source-over';

        // Sprites.
        const ringR = [R * 0.74, R * 0.46, R * 0.18];   // plant / herb / pred
        const breath = 1 + Math.sin(this.t * (0.8 + motion * 1.4)) * (0.02 + motion * 0.03);
        // Count alive sprites per tier for even angular spacing.
        const tierN = [0, 0, 0], tierI = [0, 0, 0];
        for (const s of this.sprites) if (s.alive) tierN[s.tier]++;

        for (const s of this.sprites) {
            // Spawn/despawn fade.
            s.born += (s.alive ? 1 : -1) * 0.07;
            s.born = clamp(s.born, 0, 1);
            s.energy += (s.tEnergy - s.energy) * 0.08;

            // Mandala target position.
            let idx = 0, n = Math.max(1, tierN[s.tier]);
            if (s.alive) { idx = tierI[s.tier]++; }
            const ang = this.rot * (s.tier === 0 ? 1 : s.tier === 1 ? -1.2 : 0.7)
                + (idx / n) * Math.PI * 2 + s.phase * 0.15;
            const rr = ringR[s.tier] * breath;
            const ringX = Math.cos(ang) * rr, ringY = Math.sin(ang) * rr;
            // Crowd target (deterministic, drifting).
            const crowdX = s.jx * R * 0.66 + Math.cos(this.t * motion + s.phase) * R * 0.06;
            const crowdY = s.jy * R * 0.66 + Math.sin(this.t * motion * 1.2 + s.phase) * R * 0.06;
            const tx = lerp(crowdX, ringX, ringiness);
            const ty = lerp(crowdY, ringY, ringiness);
            s.x += (tx - s.x) * 0.10;
            s.y += (ty - s.y) * 0.10;

            // High-frequency shake when chaotic (alert).
            const shake = (1 - ringiness) * motion * 1.6;
            const px = cx + s.x + Math.sin(this.t * 9 + s.phase) * shake;
            const py = cy + s.y + Math.cos(this.t * 11 + s.phase) * shake;

            const r = SPRITE_R * (0.6 + 0.4 * s.born);
            ctx.save();
            ctx.globalAlpha = clamp((0.4 + intensity * 0.6) * s.born, 0, 1);
            ctx.translate(px, py);
            ctx.scale(r / BASE_HEX, r / BASE_HEX);
            drawOrganism(ctx, 0, 0, { species: s.species, player: s.player, energy: s.energy });
            ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        // Purge fully-faded dead sprites.
        if (this.sprites.some(s => !s.alive && s.born <= 0)) {
            this.sprites = this.sprites.filter(s => s.alive || s.born > 0);
        }
    }
}
