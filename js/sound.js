// Web Audio API synthesized SFX — no asset files.
// All sounds are short tonal stamps generated on demand.

const STORAGE_KEY = 'biome.muted';

let ctx = null;
let masterGain = null;
let muted = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1');
let lastPlayedAt = {};   // per-key debounce timestamps

function _ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.6;
    masterGain.connect(ctx.destination);
    return ctx;
}

function _resumeIfSuspended() {
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
}

// Envelope helper — attack/decay shape on a gain node
function _env(g, t0, peak, attack, hold, release) {
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    if (hold > 0) g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
}

// One oscillator with envelope
function _tone({ type = 'sine', freq, freqEnd = null, peak = 0.4, attack = 0.005, hold = 0.0, release = 0.1, delay = 0 }) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + attack + hold + release);
    osc.connect(g);
    g.connect(masterGain);
    _env(g, t0, peak, attack, hold, release);
    osc.start(t0);
    osc.stop(t0 + attack + hold + release + 0.05);
}

// Sound bank — each entry is a function that emits one or more tones
const BANK = {
    // Soft tactile pop when placing an organism
    place() {
        _tone({ type: 'square', freq: 320, freqEnd: 200, peak: 0.18, attack: 0.003, hold: 0, release: 0.08 });
        _tone({ type: 'sine', freq: 720, peak: 0.10, attack: 0.002, hold: 0, release: 0.04, delay: 0.005 });
    },
    // Quick high ping when a score updates
    score() {
        _tone({ type: 'sine', freq: 880, peak: 0.22, attack: 0.004, hold: 0.0, release: 0.13 });
        _tone({ type: 'sine', freq: 1320, peak: 0.10, attack: 0.004, hold: 0.0, release: 0.08, delay: 0.02 });
    },
    // Rising sweep — round transition
    round() {
        _tone({ type: 'sine', freq: 220, freqEnd: 660, peak: 0.30, attack: 0.02, hold: 0.0, release: 0.35 });
        _tone({ type: 'triangle', freq: 110, freqEnd: 330, peak: 0.18, attack: 0.02, hold: 0.0, release: 0.35 });
    },
    // Fighting-game "VS" sting — two heavy slams (one per fighter entering) and
    // a bright metallic clash when they meet in the middle.
    vs() {
        _tone({ type: 'triangle', freq: 130, freqEnd: 80,  peak: 0.42, attack: 0.004, hold: 0.04, release: 0.26 });           // P1 slam
        _tone({ type: 'square',   freq: 220, freqEnd: 120, peak: 0.16, attack: 0.004, hold: 0.0,  release: 0.14 });
        _tone({ type: 'triangle', freq: 150, freqEnd: 90,  peak: 0.42, attack: 0.004, hold: 0.04, release: 0.26, delay: 0.16 }); // P2 slam
        _tone({ type: 'square',   freq: 247, freqEnd: 130, peak: 0.16, attack: 0.004, hold: 0.0,  release: 0.14, delay: 0.16 });
        _tone({ type: 'sawtooth', freq: 1320, freqEnd: 660, peak: 0.22, attack: 0.003, hold: 0.0, release: 0.34, delay: 0.34 }); // clash
        _tone({ type: 'sine',     freq: 1980, peak: 0.16, attack: 0.003, hold: 0.04, release: 0.40, delay: 0.36 });             // shimmer
    },
    // Impactful low boom + high pluck — match begin
    'match-start'() {
        _tone({ type: 'triangle', freq: 90, peak: 0.45, attack: 0.005, hold: 0.05, release: 0.32 });
        _tone({ type: 'sine', freq: 660, peak: 0.22, attack: 0.003, hold: 0.0, release: 0.18, delay: 0.04 });
        _tone({ type: 'sine', freq: 990, peak: 0.16, attack: 0.003, hold: 0.0, release: 0.12, delay: 0.08 });
    },
    // Soft two-note chime for round recap card
    recap() {
        _tone({ type: 'sine', freq: 523, peak: 0.18, attack: 0.005, hold: 0.03, release: 0.18 });
        _tone({ type: 'sine', freq: 784, peak: 0.12, attack: 0.005, hold: 0.03, release: 0.20, delay: 0.06 });
    },
    // Dramatic stinger for callouts
    callout() {
        _tone({ type: 'sawtooth', freq: 110, freqEnd: 165, peak: 0.30, attack: 0.01, hold: 0.04, release: 0.40 });
        _tone({ type: 'sine', freq: 440, peak: 0.20, attack: 0.005, hold: 0.05, release: 0.30, delay: 0.02 });
        _tone({ type: 'triangle', freq: 880, peak: 0.14, attack: 0.005, hold: 0.0, release: 0.20, delay: 0.06 });
    },
    // Heavy body-thud + a downward metallic clang — the loser's "DEFEATED"
    // stamp slamming down. The defeat beat that lands just before the win fanfare.
    ko() {
        _tone({ type: 'triangle', freq: 170, freqEnd: 55,  peak: 0.46, attack: 0.003, hold: 0.03, release: 0.30 });            // body thud
        _tone({ type: 'square',   freq: 200, freqEnd: 70,  peak: 0.18, attack: 0.003, hold: 0.0,  release: 0.16 });            // crunch
        _tone({ type: 'sawtooth', freq: 520, freqEnd: 170, peak: 0.20, attack: 0.002, hold: 0.0,  release: 0.26, delay: 0.02 }); // downer clang
    },
    // Tense buzz resolving to a bright hit — an underdog win
    upset() {
        _tone({ type: 'sawtooth', freq: 70, freqEnd: 140, peak: 0.32, attack: 0.01, hold: 0.06, release: 0.30 });
        _tone({ type: 'square', freq: 330, freqEnd: 220, peak: 0.16, attack: 0.01, hold: 0.04, release: 0.22, delay: 0.04 });
        _tone({ type: 'sine', freq: 1175, peak: 0.26, attack: 0.004, hold: 0.04, release: 0.34, delay: 0.18 }); // D6 release
        _tone({ type: 'triangle', freq: 1568, peak: 0.16, attack: 0.004, hold: 0.0, release: 0.24, delay: 0.24 }); // G6
    },
    // Quick two-note lift — a rank promotion
    promote() {
        _tone({ type: 'triangle', freq: 659, peak: 0.26, attack: 0.005, hold: 0.04, release: 0.16 });            // E5
        _tone({ type: 'sine', freq: 988, peak: 0.24, attack: 0.005, hold: 0.06, release: 0.30, delay: 0.10 });   // B5
    },
    // Three-note ascending arpeggio — end of match
    victory() {
        _tone({ type: 'triangle', freq: 523, peak: 0.30, attack: 0.005, hold: 0.05, release: 0.18 });          // C5
        _tone({ type: 'triangle', freq: 659, peak: 0.30, attack: 0.005, hold: 0.05, release: 0.20, delay: 0.18 }); // E5
        _tone({ type: 'triangle', freq: 784, peak: 0.32, attack: 0.005, hold: 0.10, release: 0.50, delay: 0.36 }); // G5
        _tone({ type: 'sine',     freq: 1046, peak: 0.22, attack: 0.005, hold: 0.10, release: 0.50, delay: 0.36 }); // C6
    },
    // Grand four-note fanfare with a sustained octave bloom — seizing #1.
    // Deliberately bigger and longer than `victory` so the throne moment reads
    // as its own beat rather than a second match-end chime.
    champion() {
        _tone({ type: 'triangle', freq: 523,  peak: 0.30, attack: 0.005, hold: 0.06, release: 0.20 });             // C5
        _tone({ type: 'triangle', freq: 659,  peak: 0.30, attack: 0.005, hold: 0.06, release: 0.22, delay: 0.16 }); // E5
        _tone({ type: 'triangle', freq: 784,  peak: 0.32, attack: 0.005, hold: 0.06, release: 0.24, delay: 0.32 }); // G5
        _tone({ type: 'triangle', freq: 1046, peak: 0.34, attack: 0.005, hold: 0.22, release: 0.70, delay: 0.48 }); // C6 bloom
        _tone({ type: 'sine',     freq: 1568, peak: 0.20, attack: 0.005, hold: 0.22, release: 0.70, delay: 0.48 }); // G6 shimmer
        _tone({ type: 'sine',     freq: 2093, peak: 0.12, attack: 0.005, hold: 0.18, release: 0.60, delay: 0.56 }); // C7 sparkle
    },
};

export function playSound(key) {
    if (muted) return;
    const fn = BANK[key];
    if (!fn) return;

    // Debounce same-key calls within 60ms (e.g. multiple score updates in one tick)
    const now = performance.now();
    if (lastPlayedAt[key] && now - lastPlayedAt[key] < 60) return;
    lastPlayedAt[key] = now;

    if (!_ensureContext()) return;
    _resumeIfSuspended();
    try { fn(); } catch (_) { /* ignore audio errors */ }
}

export function setMuted(value) {
    muted = !!value;
    try { localStorage.setItem(STORAGE_KEY, muted ? '1' : '0'); } catch (_) {}
    if (masterGain && ctx) {
        // Smooth fade to avoid clicks
        const target = muted ? 0 : 0.6;
        masterGain.gain.cancelScheduledValues(ctx.currentTime);
        masterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.08);
    }
}

export function isMuted() {
    return muted;
}
