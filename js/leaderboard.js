// Full-screen "Hall of Champions" leaderboard scene.
//
// A standalone, highly-stylized view of the ELO standings — built for the
// launcher (first-load welcome) so a player can browse the roster before ever
// starting a match. It reads the same server data the side-drawer does
// (fetchRankings / fetchHistory) but presents it as a fighting-game roster:
// a top-3 podium, then a leaderboard you can re-slice through several "lenses"
// (Overall / By Size / By Family / Local vs Cloud), every row wearing its baked
// avatar and biome-creature identity.
//
// Pure presentation: it owns no data and no navigation. The caller hands it a
// container and an onBack callback; it fetches, renders, and wires lens
// switching internally.

import { fetchRankings, fetchHistory, resetRankings } from './rankings.js';
import { applyAvatar, applyAvatarVideo, teardownClips } from './model-avatar.js';
import { resolveModel, paramLabel, mightLevel } from './model-identity.js';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

// Biome-creature glyph per family archetype — the fun, recognisable face of each
// family on the board. Anything without a clean emoji falls back to the hex mark.
const CREATURE = {
    fox: '🦊', stag: '🦌', falcon: '🦅', mantis: '🦗', anglerfish: '🐡',
    'luna moth': '🦋', scarab: '🪲', chameleon: '🦎', owl: '🦉', peacock: '🦚',
    octopus: '🐙', wolf: '🐺', rhino: '🦏', scorpion: '🦂', tiger: '🐅',
    lynx: '🐈', otter: '🦦', panda: '🐼', beaver: '🦫', mouse: '🐭',
    koi: '🐟', horse: '🐎', tortoise: '🐢', dragonfly: '🪰', heron: '🦩',
};
const creatureGlyph = (archetype) => CREATURE[archetype] || '⬡';

// Size-tier display, ordered biggest → smallest for the "By Size" lens.
const TIER_VIEW = [
    { id: 'cloud', label: '☁ Cloud Giants' },
    { id: 'large', label: '◆ Large' },
    { id: 'mid',   label: '◈ Mid' },
    { id: 'small', label: '◇ Small' },
];

const LENSES = [
    { id: 'overall', label: 'Overall' },
    { id: 'size',    label: 'By Size' },
    { id: 'family',  label: 'By Family' },
    { id: 'arena',   label: 'Local vs Cloud' },
];

function storedHandle() {
    try { return localStorage.getItem('biome.handle'); } catch (_) { return null; }
}

// Render the whole scene into `root`. opts.onBack is called when the player
// clicks the back chevron. Re-callable to refresh.
export async function openLeaderboard(root, opts = {}) {
    if (!root) return;
    const onBack = opts.onBack || (() => {});
    const humanHandle = opts.humanHandle || storedHandle();

    root.innerHTML = `<div class="lb-shell"><div class="lb-loading">Loading the hall of champions…</div></div>`;

    const [rankings, history] = await Promise.all([fetchRankings(), fetchHistory()]);
    const names = rankings ? Object.keys(rankings) : [];

    if (!names.length) {
        root.innerHTML = `
            <div class="lb-shell">
                <button class="lb-back" id="lb-back">‹ Back</button>
                <div class="lb-title-row">
                    <span class="lt-glyph">⬡</span>
                    <h1 class="lb-title">HALL OF CHAMPIONS</h1>
                    <span class="lt-glyph">⬡</span>
                </div>
                <div class="lb-empty">
                    <div class="lb-empty-mark">🏆</div>
                    <div class="lb-empty-head">No champions yet</div>
                    <div class="lb-empty-sub">Play a ranked match — Solo, Watch, or a Tournament — and the standings light up here.</div>
                </div>
            </div>`;
        root.querySelector('#lb-back')?.addEventListener('click', onBack);
        return;
    }

    // Enrich every entry once. Server returns descending-ELO order, so the array
    // index is the global rank.
    const entries = names.map((name, i) => ({
        name,
        stats: rankings[name],
        rank: i + 1,
        rm: resolveModel(name),
        isHuman: !!humanHandle && name === humanHandle,
    }));

    const totalMatches = history?.length || 0;
    const cloudCount = entries.filter(e => e.rm.sizeTier === 'cloud').length;
    const localCount = entries.length - cloudCount;
    const champ = entries[0];

    root.innerHTML = `
        <div class="lb-shell">
            <button class="lb-back" id="lb-back">‹ Back</button>
            <button class="lb-reset" id="lb-reset" title="Archive standings and start fresh">⟲ Reset</button>

            <div class="lb-head">
                <div class="lb-title-row">
                    <span class="lt-glyph">⬡</span>
                    <h1 class="lb-title">HALL OF CHAMPIONS</h1>
                    <span class="lt-glyph">⬡</span>
                </div>
                <div class="lb-stat-strip">
                    <div class="lb-stat"><b>${entries.length}</b><span>Fighters</span></div>
                    <div class="lb-stat"><b>${totalMatches}</b><span>Matches</span></div>
                    <div class="lb-stat"><b>${localCount}</b><span>Local</span></div>
                    <div class="lb-stat"><b>${cloudCount}</b><span>Cloud</span></div>
                </div>
            </div>

            <div class="lb-podium">${podiumHTML(entries.slice(0, 3))}</div>

            <div class="lb-lenses" role="tablist">
                ${LENSES.map((l, i) => `<button class="lb-lens${i === 0 ? ' active' : ''}" data-lens="${l.id}" role="tab">${l.label}</button>`).join('')}
            </div>

            <div class="lb-list" id="lb-list"></div>

            ${historyHTML(history)}
        </div>`;

    const listEl = root.querySelector('#lb-list');
    const renderLens = (lens) => {
        listEl.innerHTML = viewHTML(lens, entries);
        paintAvatars(listEl);
    };

    root.querySelectorAll('.lb-lens').forEach(btn => {
        btn.addEventListener('click', () => {
            root.querySelectorAll('.lb-lens').forEach(b => b.classList.toggle('active', b === btn));
            renderLens(btn.dataset.lens);
        });
    });

    renderLens('overall');
    paintPodium(root.querySelector('.lb-podium'));
    paintAvatars(root.querySelector('.lb-history'));

    // Leaving the scene: stop every podium decoder before handing control back, so
    // no <video>/bounce-canvas keeps running off-screen.
    const back = () => { teardownClips(root); onBack(); };
    root.querySelector('#lb-back')?.addEventListener('click', back);

    root.querySelector('#lb-reset')?.addEventListener('click', async () => {
        if (!confirm('Reset the leaderboard? Current standings are archived to a backup file and can be restored.')) return;
        teardownClips(root);
        const res = await resetRankings();
        if (res?.archived) console.log(`Rankings reset — standings archived to ${res.archived}`);
        openLeaderboard(root, opts);   // re-fetch and repaint the now-empty hall
    });
}

// ── Podium (top 3), centre-tallest ───────────────────────────
function podiumHTML(top) {
    // Visual order: 2nd, 1st (centre), 3rd.
    const order = [top[1], top[0], top[2]].filter(Boolean);
    return order.map(e => {
        const wr = e.stats.matches ? Math.round((e.stats.wins / e.stats.matches) * 100) : 0;
        const ava = e.isHuman
            ? `<div class="lb-pod-ava lb-you">👤</div>`
            : `<div class="lb-pod-ava" data-model="${e.name}"></div>`;
        const fam = e.isHuman ? 'Human Challenger'
            : `${creatureGlyph(e.rm.family.archetype)} ${e.rm.family.label}`;
        return `
        <div class="lb-pod p${e.rank}" style="--bh:${e.rm.hue}">
            <div class="lb-pod-medal">${MEDAL[e.rank]}</div>
            ${ava}
            <div class="lb-pod-perch">
                <div class="lb-pod-rankno">#${e.rank}</div>
                <div class="lb-pod-name">${e.rm.displayName}</div>
                <div class="lb-pod-fam">${fam}</div>
                <div class="lb-pod-elo">${e.stats.elo}<span>ELO</span></div>
                <div class="lb-pod-rec">${e.stats.wins}W · ${e.stats.losses}L · ${wr}%</div>
            </div>
        </div>`;
    }).join('');
}

// ── Lens views ───────────────────────────────────────────────
function viewHTML(lens, entries) {
    if (lens === 'size') {
        return TIER_VIEW.map(t => {
            const rows = entries.filter(e => e.rm.sizeTier === t.id);
            if (!rows.length) return '';
            return groupHTML(t.label, rows.length) + rows.map(rowHTML).join('');
        }).join('');
    }
    if (lens === 'family') {
        // Group by family, families ordered by their best (lowest) global rank.
        const groups = new Map();
        for (const e of entries) {
            const key = e.rm.family.id;
            if (!groups.has(key)) groups.set(key, { fam: e.rm.family, rows: [] });
            groups.get(key).rows.push(e);
        }
        return [...groups.values()]
            .sort((a, b) => a.rows[0].rank - b.rows[0].rank)
            .map(g => {
                const label = `${creatureGlyph(g.fam.archetype)} ${g.fam.label} <span class="lb-grp-vendor">${g.fam.vendor}</span>`;
                return groupHTML(label, g.rows.length) + g.rows.map(rowHTML).join('');
            }).join('');
    }
    if (lens === 'arena') {
        const cloud = entries.filter(e => e.rm.sizeTier === 'cloud');
        const local = entries.filter(e => e.rm.sizeTier !== 'cloud');
        const col = (title, rows, mod) => `
            <div class="lb-col ${mod}">
                ${groupHTML(title, rows.length)}
                ${rows.length ? rows.map(rowHTML).join('') : '<div class="lb-empty-col">None yet</div>'}
            </div>`;
        return `<div class="lb-arena">
            ${col('🖥 Local', local, 'local')}
            ${col('☁ Cloud', cloud, 'cloud')}
        </div>`;
    }
    // overall
    return entries.map(rowHTML).join('');
}

function groupHTML(label, count) {
    return `<div class="lb-group"><span class="lb-grp-label">${label}</span><span class="lb-grp-count">${count}</span></div>`;
}

// ── One leaderboard row ──────────────────────────────────────
function rowHTML(e) {
    const wr = e.stats.matches ? Math.round((e.stats.wins / e.stats.matches) * 100) : 0;
    const rankCell = e.rank <= 3
        ? `<div class="lb-rank top">${MEDAL[e.rank]}</div>`
        : `<div class="lb-rank">${e.rank}</div>`;

    if (e.isHuman) {
        return `<div class="lb-row lb-row-you" style="--bh:${e.rm.hue}">
            ${rankCell}
            <div class="lb-ava lb-you">👤</div>
            <div class="lb-id">
                <div class="lb-name">${e.name}</div>
                <div class="lb-tags"><span class="lb-fam">Human Challenger</span></div>
            </div>
            <div class="lb-might"></div>
            <div class="lb-rec"><b class="w">${e.stats.wins}</b><i>/</i><b class="l">${e.stats.losses}</b><em>${wr}%</em></div>
            <div class="lb-elo">${e.stats.elo}<span>ELO</span></div>
        </div>`;
    }

    const cloud = e.rm.sizeTier === 'cloud';
    const tag = cloud ? '<span class="lb-where cloud">CLOUD</span>' : '<span class="lb-where local">LOCAL</span>';
    return `<div class="lb-row" data-tier="${e.rm.sizeTier}" style="--bh:${e.rm.hue}">
        ${rankCell}
        <div class="lb-ava" data-model="${e.name}"></div>
        <div class="lb-id">
            <div class="lb-name">${e.rm.displayName}</div>
            <div class="lb-tags">
                <span class="lb-fam">${creatureGlyph(e.rm.family.archetype)} ${e.rm.family.label}</span>
                <span class="lb-size">${paramLabel(e.name)}</span>
                ${tag}
            </div>
        </div>
        <div class="lb-might" title="Might">${mightBar(mightLevel(e.name))}</div>
        <div class="lb-rec"><b class="w">${e.stats.wins}</b><i>/</i><b class="l">${e.stats.losses}</b><em>${wr}%</em></div>
        <div class="lb-elo">${e.stats.elo}<span>ELO</span></div>
    </div>`;
}

function mightBar(level) {
    let s = '';
    for (let i = 0; i < 5; i++) s += `<span class="lb-pip${i < level ? ' on' : ''}"></span>`;
    return s;
}

// ── Recent matches ticker ────────────────────────────────────
function historyHTML(history) {
    if (!history?.length) return '';
    const recent = history.slice(-8).reverse();
    const rows = recent.map(m => {
        const loser = m.winner === m.p1 ? m.p2 : m.p1;
        return `<div class="lb-h-row">
            <span class="lb-h-ava" data-model="${m.winner}"></span>
            <span class="lb-h-win">${short(m.winner)}</span>
            <span class="lb-h-def">def.</span>
            <span class="lb-h-ava" data-model="${loser}"></span>
            <span class="lb-h-lose">${short(loser)}</span>
            <span class="lb-h-score">${m.p1_score}–${m.p2_score}</span>
        </div>`;
    }).join('');
    return `<div class="lb-history">
        <div class="lb-h-title">Recent Bouts</div>
        ${rows}
    </div>`;
}

function short(model) {
    if (!model) return '—';
    return model.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
}

// Drop baked portraits into every avatar slot under `scope`.
function paintAvatars(scope) {
    scope?.querySelectorAll?.('[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
}

// Bring the podium to life: the leader plays a celebratory "champion" clip, the
// runners-up an "idle" loop — all ping-pong bounced so a short clip never hard-
// cuts. Each falls back to the still portrait (then the brand-hue gradient) when
// no clip is baked for that model. Confined to the three podium slots; the rows
// stay as still PNGs so we never spin up a wall of decoders. (The human slot has
// no data-model, so it keeps its 👤 placeholder.)
function paintPodium(scope) {
    scope?.querySelectorAll?.('.lb-pod-ava[data-model]').forEach(el => {
        const category = el.closest('.lb-pod')?.classList.contains('p1') ? 'champion' : 'idle';
        applyAvatarVideo(el, el.dataset.model, { category, loop: true, bounce: true });
    });
}
