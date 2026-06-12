#!/usr/bin/env node
// Headless tournament runner — drives ONE tournament to completion in a dedicated
// headless Chromium, then exits. The browser game does the real work: it POSTs each
// match result to /tournament-result (ELO) and feeds the live relay
// (/tournament/live + /tournament/live/frames) exactly as a human-operated tab would,
// so this runner needs ZERO game/server changes — it just launches, configures,
// starts, and waits.
//
// Spawned by the server.py scheduler (one at a time). Connects to the already-running
// server; does NOT start one. Orphan-proof: unique CDP port + profile per process,
// reaps its own Chrome on exit.
//
//   node tools/run-tournament.mjs --size 8 --format seeded --rounds 10 \
//        --map-strategy mediated [--server http://localhost:8765] [--timeout 1800]
//
// Exit: 0 = ran to a champion · 1 = never started / timed out / failed · 2 = launch error.
// Final stdout line is `RESULT {json}` for the parent to capture.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHROME = process.env.BIOME_CHROME || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]; if (!k || !k.startsWith('--')) continue;
    a[k.slice(2)] = argv[i + 1];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const SIZE = parseInt(args.size || '8', 10);
const FORMAT = args.format || 'seeded';
const ROUNDS = parseInt(args.rounds || '10', 10);
const MAP_STRATEGY = args['map-strategy'] || 'mediated';
const SERVER = (args.server || 'http://localhost:8765').replace(/\/$/, '');
const TIMEOUT_MS = (parseInt(args.timeout || '1800', 10)) * 1000;   // hard cap, default 30 min
// Unique CDP port per process so concurrent/leftover runners never collide or attach.
const CDP_PORT = args['cdp-port'] ? parseInt(args['cdp-port'], 10) : 9400 + (process.pid % 150);

function killCdp() { try { execSync(`fuser -k ${CDP_PORT}/tcp 2>/dev/null || true`); } catch {} }
function done(code, payload) {
  console.log('RESULT ' + JSON.stringify({ code, ...payload }));
  killCdp();
  process.exit(code);
}

// ---- CDP --------------------------------------------------------------------
function launchChrome(profile) {
  return spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-dev-shm-usage', '--window-size=1400,900',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
}
async function cdpVersion() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return; } catch {} await sleep(100); }
  throw new Error('CDP never came up');
}
async function newTab(url) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('CDP /json/new failed: ' + r.status);
  return (await r.json()).webSocketDebuggerUrl;
}
class CDP {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.handlers = []; }
  open() { return new Promise((res, rej) => { this.ws.addEventListener('open', () => res()); this.ws.addEventListener('error', rej); this.ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m.result); this.pending.delete(m.id); } else if (m.method) this.handlers.forEach((h) => h(m.method, m.params)); }); }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res) => this.pending.set(id, res)); }
  on(fn) { this.handlers.push(fn); }
  async eval(expr, awaitPromise = false) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; }
}
const fmtArgs = (args = []) => args.map((a) => a.value ?? a.description ?? a.unserializableValue ?? a.type).join(' ');

// ---- run --------------------------------------------------------------------
async function main() {
  killCdp();
  const profile = join(ROOT, 'dev-logs', `.chrome-run-${process.pid}`);
  mkdirSync(profile, { recursive: true });
  console.log(`[runner] size=${SIZE} format=${FORMAT} rounds=${ROUNDS} map=${MAP_STRATEGY} cdp=${CDP_PORT}`);
  const chrome = launchChrome(profile);
  await cdpVersion();
  const wsUrl = await newTab(`${SERVER}/`);
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  let errors = 0;
  cdp.on((method, p) => {
    if (method === 'Runtime.consoleAPICalled' && (p.type || '').toUpperCase() === 'ERROR') errors++;
    else if (method === 'Runtime.exceptionThrown') errors++;
  });

  // Wait for the game to load.
  let ready = false;
  for (let i = 0; i < 150; i++) { if (await cdp.eval('!!(window.game && window.game._startTournament)').catch(() => false)) { ready = true; break; } await sleep(100); }
  if (!ready) return done(2, { error: 'game never loaded' });

  // Configure and start.
  await cdp.eval(`(() => {
    window.game._tournamentSize = ${SIZE};
    window.game._tournamentFormat = ${JSON.stringify(FORMAT)};
    window.game._world = { ...window.game._worldSettings(), rounds: ${ROUNDS}, mapStrategy: ${JSON.stringify(MAP_STRATEGY)} };
  })()`);
  await cdp.eval('window.game._startTournament()', true).catch((e) => console.log('[runner] start err: ' + e.message));

  await sleep(2500);
  const started = await cdp.eval('!!(window.game.tournament && window.game.tournament.running)').catch(() => false);
  if (!started) return done(1, { error: 'tournament did not start (too few eligible models?)' });
  console.log('[runner] tournament running');

  // Poll to completion under the hard watchdog.
  const t0 = Date.now(); let lastLog = 0;
  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(4000);
    let running;
    try { running = await cdp.eval('!!(window.game.tournament && window.game.tournament.running)'); }
    catch (e) { console.log('[runner] poll failed (tab unresponsive): ' + e.message); }
    if (running === false) {
      const champion = await cdp.eval('(() => { try { const w = window.game.tournament._finalMatch().winner; return (typeof w === "string" ? w : w?.name) || null; } catch { return null; } })()').catch(() => null);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[runner] finished in ${elapsed}s — champion: ${champion}`);
      await sleep(1500);   // let the final result POST flush
      return done(0, { champion, elapsed, errors });
    }
    if (Date.now() - lastLog > 30000) {
      const info = await cdp.eval('JSON.stringify({round: window.game.turns && window.game.turns.round, phase: window.game.turns && String(window.game.turns.phase)})').catch(() => '?');
      console.log(`[runner] +${Math.round((Date.now() - t0) / 1000)}s ${info}`);
      lastLog = Date.now();
    }
  }
  return done(1, { error: 'timed out', elapsed: Math.round((Date.now() - t0) / 1000) });
}
main().catch((e) => { console.error('[runner] failed:', e?.message || e); done(2, { error: String(e?.message || e) }); });
