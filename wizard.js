// wizard.js — PRIORITY 2: guided test-plan wizard (beginner mode).
// A guided layer over the existing tests: pick a speaker configuration, get a
// tick-off plan, and walk each test's 3 screens (info → setup → capture+result)
// with plain-language copy, inline glossary chips, and generated SVG diagrams.

import * as dsp from './dsp.js';
import * as audio from './audio.js';
import * as cal from './cal.js';
import { session } from './session.js';
import { passesTweeterGate } from './safety.js';
import { chip, initChips, renderGlossaryList } from './glossary.js';
import { configIcon, layoutDiagram, nearfieldInset } from './svg.js';
import { Plot, TRACE_COLORS } from './plot.js';

const $ = (s) => document.querySelector(s);
const wiz = { config: null, plan: null };

// ---- Driver-pair presets by configuration (spec) --------------------------
const PAIRS = {
  '2-way': [{ name: 'Tweeter ↔ Woofer', a: 'tweeter', b: 'woofer', xo: 2500 }],
  '2.5-way': [{ name: 'Tweeter ↔ Upper woofer', a: 'tweeter', b: 'woofer', xo: 2500 }],
  '3-way': [
    { name: 'Tweeter ↔ Midrange', a: 'tweeter', b: 'midrange', xo: 3000 },
    { name: 'Midrange ↔ Woofer', a: 'midrange', b: 'woofer', xo: 500 },
  ],
  MTM: [{ name: 'Tweeter ↔ mid-woofer pair', a: 'tweeter', b: 'woofer', xo: 2500, note: 'Put the mic on the tweeter axis — the vertical centre between the two mid-woofers — because that\'s where their combined acoustic centre sits.' }],
  coax: [{ name: 'Tweeter ↔ Woofer', a: 'tweeter', b: 'woofer', xo: 2500 }],
};
const CONFIGS = [
  ['2-way', 'Woofer + tweeter; one crossover.'],
  ['2.5-way', 'Two woofers + tweeter; the lower woofer rolls off early (the ".5").'],
  ['3-way', 'Woofer + midrange + tweeter; two crossovers.'],
  ['MTM', "Two mid-woofers flanking a central tweeter (D'Appolito)."],
  ['coax', 'Tweeter mounted inside the woofer, concentric.'],
];
const ROLE_LABEL = { tweeter: 'tweeter', midrange: 'midrange', woofer: 'woofer' };

// ---- Per-test beginner copy (Screen 1) ------------------------------------
const META = {
  driverOffset: {
    title: 'Driver offset', needsRef: true, pairTest: true,
    for: `finding how much further back one ${chip('driver')} sits (its ${chip('acousticCentre', 'acoustic centre')}) than another, so a crossover simulator can line them up in time.`,
    produce: `one number in millimetres (the ${chip('zOffset', 'z-offset')}), plus an error bar.`,
    use: `enter it as the driver's Z position in VituixCAD (or similar).`,
    layout: `test speaker on a stand at a comfortable height; mic on a stand pointing at it, level with the tweeter, ${chip('onAxis', 'on-axis')} (straight in front), about 0.5–1 m away; the other speaker (the ${chip('referenceSpeaker', 'reference')}) left untouched. Nothing moves once you start.`,
    read: `run the SAME driver twice first (the Repeatability button) — the two numbers should agree within a few mm. If they don't, it's not trustworthy yet. The ± number is your honest error bar.`,
    svg: () => layoutDiagram({ showReference: true }),
    terms: ['acousticCentre', 'zOffset', 'referenceSpeaker', 'onAxis', 'impulseResponse', 'repeatability'],
  },
  relativePhase: {
    title: 'Relative phase', needsRef: true, pairTest: true,
    for: `seeing whether two drivers are working together (in ${chip('phase')}) or fighting each other around their ${chip('crossover')}.`,
    produce: `two phase curves overlaid; you look at how they line up in the ${chip('crossoverFreq', 'crossover')} region.`,
    use: `informs whether polarity/offset is right before you finalise a crossover.`,
    layout: `identical to the offset test — same fixed mic, same reference speaker.`,
    read: `in the crossover band, the two curves tracking together = summing well; a big split or one flipped = a polarity/offset issue. Only the crossover region is meaningful.`,
    svg: () => layoutDiagram({ showReference: true }),
    terms: ['phase', 'crossover', 'crossoverFreq', 'referenceSpeaker'],
  },
  distortion: {
    title: 'Distortion', needsRef: false, pairTest: false,
    for: `hearing/seeing when a driver is straining, buzzing, or rattling.`,
    produce: `the main tone plus its harmonic "echoes" (distortion), as a percentage/curve.`,
    use: `find the loudness where distortion climbs, or spot a mechanical buzz.`,
    layout: `mic on-axis, moderate distance; keep the volume moderate so the tablet mic itself isn't the thing distorting.`,
    read: `rising harmonics or a sudden spike at one frequency = a problem to chase.`,
    svg: () => layoutDiagram({ showReference: false }),
    terms: ['driver', 'sweep'],
  },
  waterfall: {
    title: 'Waterfall', needsRef: false, pairTest: false,
    for: `finding resonances — notes that "ring on" after they should have stopped.`,
    produce: `a plot of how the sound decays over time.`,
    use: `identify cabinet or port resonances, or driver breakup.`,
    layout: `mic on-axis, moderate distance.`,
    read: `ridges that persist to the right (later in time) = something ringing.`,
    svg: () => layoutDiagram({ showReference: false }),
    terms: ['impulseResponse', 'sweep'],
  },
  comparativeMagnitude: {
    title: 'Comparative magnitude', needsRef: false, pairTest: false, twoCap: true,
    for: `answering "did the change I just made do what I expected?" and comparing two drivers.`,
    produce: `two frequency-response curves to compare (relative, not absolute — the tablet ${chip('calibration', 'mic isn\'t calibrated')}, so trust the DIFFERENCE, not the exact shape).`,
    use: `A/B a tweak (stuffing, a resistor, a port bung) with the mic left in place.`,
    layout: `mic fixed; change only the one thing between the two captures.`,
    read: `the change between curves is real; the absolute curve is not.`,
    svg: () => layoutDiagram({ showReference: false }),
    terms: ['calibration', 'sweep'],
  },
  nearfield: {
    title: 'Nearfield low-end', needsRef: false, pairTest: false,
    for: `checking bass tuning without the room getting in the way.`,
    produce: `the low-frequency response of a woofer or port.`,
    use: `check port tuning / box alignment.`,
    layout: `mic almost touching the dust cap (for the driver) or in the port mouth (for the port).`,
    read: `shape matters, not absolute level; the dip between the woofer and port nulls shows the box tuning frequency.`,
    svg: () => `<div class="nf-pair">${nearfieldInset('cone')}${nearfieldInset('port')}</div>`,
    terms: ['nearfield', 'woofer'],
  },
};
const TEST_ORDER = ['driverOffset', 'relativePhase', 'distortion', 'waterfall', 'comparativeMagnitude', 'nearfield'];

// ---- Plan generation ------------------------------------------------------
function generatePlan(config) {
  const pairs = PAIRS[config] || PAIRS['2-way'];
  const steps = [];
  let id = 1;
  const add = (testType, pair) => steps.push({ id: id++, testType, pair: pair || null, status: 'pending', result: null, config: {}, scratch: {} });
  pairs.forEach((p) => add('driverOffset', p));   // one offset step per crossover pair
  pairs.forEach((p) => add('relativePhase', p));  // one phase step per crossover pair
  add('distortion'); add('waterfall'); add('comparativeMagnitude'); add('nearfield');
  return { name: `${config} speaker`, config, steps };
}

// ---- Audio helpers (reuse the verified dsp/audio) -------------------------
async function ensureAudio() {
  if (session.ctx) return true;
  const btn = $('#btnInit');
  if (btn && !btn.disabled) btn.click();
  for (let i = 0; i < 40 && !session.ctx; i++) await new Promise((r) => setTimeout(r, 200));
  return !!session.ctx;
}
function pairHasTweeter(step) {
  return !!(step && step.pair && (step.pair.a === 'tweeter' || step.pair.b === 'tweeter'));
}
// Lazily seed the per-step sweep range. Tweeter-involving steps default to a
// higher start (extra programmatic protection — the series cap is still the
// real safeguard); everything else uses the full band.
function ensureRange(step) {
  if (step.config.f1 == null) { step.config.f1 = pairHasTweeter(step) ? 500 : 20; }
  if (step.config.f2 == null) { step.config.f2 = 20000; }
}
function wizSettings(step) {
  const c = (step && step.config) || {};
  return { f1: c.f1 || 20, f2: c.f2 || 20000, duration: 5, level: 0.5, gatePre: 1, gatePost: step && step.testType === 'nearfield' ? 25 : 5, smoothing: 6 };
}

// ---- Level-setting routine (Test levels) ----------------------------------
const levelTest = { running: false, cur: null };
function speak(text) {
  try {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1;
      window.speechSynthesis.speak(u);
    }
  } catch (_) { /* speech optional */ }
}
async function runLevelTest(step, statusEl) {
  if (!(await ensureAudio())) { statusEl.textContent = 'Enable the mic/audio first (a permission prompt should appear).'; return; }
  const ctx = session.ctx, sr = ctx.sampleRate;
  const sweep = dsp.generateESS(step.config.f1, step.config.f2, 3, sr); // 3 s, with fades (safer transients)
  const silence = new Float32Array(sweep.length);
  levelTest.running = true;
  while (levelTest.running) {
    statusEl.textContent = '🔊 Testing LEFT… (set your amp so it\'s comfortably loud, not distorting)';
    speak('Testing left');
    levelTest.cur = audio.playStereoOnce(ctx, sweep, silence, 0.5);
    await levelTest.cur.promise;
    if (!levelTest.running) break;
    await new Promise((r) => setTimeout(r, 300));
    if (!levelTest.running) break;
    statusEl.textContent = '🔊 Testing RIGHT…';
    speak('Testing right');
    levelTest.cur = audio.playStereoOnce(ctx, silence, sweep, 0.5);
    await levelTest.cur.promise;
    if (!levelTest.running) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  statusEl.textContent = 'Stopped.';
}
function showLevelTest(step, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h2 class="modal-title">Test levels</h2>
      <p class="level-warn">WARNING: If your tweeter is connected directly to the amp and you do not
        have a capacitor in series protecting it, DO NOT PROCEED!!!</p>
      <div class="ref-row">
        <label class="driver-type-row">Sweep start (Hz)<input id="lvlF1" type="number" min="10" max="20000" value="${step.config.f1}"/></label>
        <label class="driver-type-row">Sweep end (Hz)<input id="lvlF2" type="number" min="100" max="24000" value="${step.config.f2}"/></label>
      </div>
      <p class="hint">These limits are also used for the real measurement. Raising the start frequency
        keeps damaging lows out of a tweeter — extra protection, not a substitute for the series cap.</p>
      <p id="lvlStatus" class="status"></p>
      <div class="modal-buttons">
        <button id="lvlProceed" class="secondary">Proceed</button>
        <button id="lvlHappy" class="primary">Happy</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const f1 = overlay.querySelector('#lvlF1'), f2 = overlay.querySelector('#lvlF2');
  const status = overlay.querySelector('#lvlStatus');
  const sync = () => {
    step.config.f1 = Math.max(10, parseInt(f1.value, 10) || step.config.f1);
    step.config.f2 = Math.max(step.config.f1 + 50, parseInt(f2.value, 10) || step.config.f2);
  };
  f1.addEventListener('change', sync);
  f2.addEventListener('change', sync);
  overlay.querySelector('#lvlProceed').addEventListener('click', () => { sync(); runLevelTest(step, status); });
  const close = () => {
    levelTest.running = false;
    if (levelTest.cur) levelTest.cur.stop();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    overlay.remove();
    if (onClose) onClose();
  };
  overlay.querySelector('#lvlHappy').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
async function capLinear(step) {
  const ctx = session.ctx, mic = session.micStream, sr = ctx.sampleRate, s = wizSettings(step);
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const rec = await audio.playAndRecord(ctx, mic, sweep, { tailSec: 1, level: s.level });
  const ir = dsp.deconvolve(rec, sweep);
  const peakIdx = dsp.findPeak(ir);
  const gated = dsp.gateIR(ir, peakIdx, sr, s.gatePre, s.gatePost);
  const spec = dsp.spectrum(gated, sr);
  let mag = spec.mag;
  if (session.cal) mag = cal.correctMagnitude(spec.freq, mag, session.cal);
  mag = dsp.fractionalOctaveSmooth(spec.freq, mag, s.smoothing);
  mag = dsp.normaliseToBand(spec.freq, mag);
  return { freq: spec.freq, mag, phase: spec.phase, gd: dsp.groupDelayMs(spec.freq, spec.phase), ir, peakIdx, sr, rec, sweep };
}
async function capOffset(refChannel, s) {
  const ctx = session.ctx, mic = session.micStream, sr = ctx.sampleRate;
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const marker = dsp.generateRefMarker(sr);
  const gap = Math.round(0.008 * sr), tauS = marker.length + gap, total = tauS + sweep.length;
  const refCh = new Float32Array(total); refCh.set(marker, 0);
  const swpCh = new Float32Array(total); swpCh.set(sweep, tauS);
  const refIsLeft = refChannel === 'L';
  const rec = await audio.playStereoAndRecord(ctx, mic, refIsLeft ? refCh : swpCh, refIsLeft ? swpCh : refCh, { tailSec: 1, level: s.level });
  // Subtract tauS so the per-driver readout is a physical path difference (the
  // ~10 ms marker→sweep gap otherwise makes a woofer read ~3400 mm). It cancels
  // in the final B−A difference, so the Z result is unchanged.
  const res = dsp.selfReferencedOffset(rec, sweep, marker, sr);
  return { ...res, offsetSamples: res.offsetSamples - tauS, sr };
}
function phaseDeg(rad) {
  const out = new Float32Array(rad.length);
  for (let i = 0; i < rad.length; i++) { let d = (rad[i] * 180) / Math.PI; while (d > 180) d -= 360; while (d < -180) d += 360; out[i] = d; }
  return out;
}

// ---- Rendering ------------------------------------------------------------
const host = () => $('#wizard');

function render(html) { host().innerHTML = html; }

export function renderStart() {
  render(`
    <div class="card">
      <h2>Guided speaker measurement</h2>
      <p class="hint">New to this? This walks you through each test one at a time — what to do, why,
        and how to read it. First, what kind of speaker are you measuring?</p>
      <div class="cfg-grid">
        ${CONFIGS.map(([c, d]) => `
          <button class="cfg-pick" data-cfg="${c}">
            ${configIcon(c)}
            <span class="cfg-name">${c}</span>
            <span class="cfg-desc">${d}</span>
          </button>`).join('')}
      </div>
      <p class="hint">Note: calibrated/absolute frequency response and SPL aren't in the plan — the
        tablet ${chip('calibration', 'mic isn\'t calibrated')}, so those need a proper mic-cal file.</p>
      <button id="wizGloss" class="secondary" style="margin-top:10px">Open glossary</button>
    </div>`);
  document.querySelectorAll('.cfg-pick').forEach((b) => b.addEventListener('click', () => {
    wiz.config = b.dataset.cfg;
    wiz.plan = generatePlan(wiz.config);
    renderPlan();
  }));
  $('#wizGloss').addEventListener('click', renderGlossary);
}

function renderGlossary() {
  render(`<div class="card"><h2>Glossary</h2><div class="gloss-list">${renderGlossaryList()}</div>
    <button id="wizBack" class="secondary" style="margin-top:12px">Back</button></div>`);
  $('#wizBack').addEventListener('click', () => (wiz.plan ? renderPlan() : renderStart()));
}

function renderPlan() {
  const p = wiz.plan;
  const rows = p.steps.map((st, i) => {
    const m = META[st.testType];
    const tick = st.status === 'done' ? '✅' : st.status === 'skipped' ? '⤼' : '⬜';
    const sub = st.pair ? ` — ${st.pair.name}` : '';
    const res = st.status === 'done' && st.result ? `<span class="plan-res">${st.result.summary}</span>` : '';
    return `<button class="plan-step" data-i="${i}"><span class="plan-tick">${tick}</span>
      <span class="plan-label">${m.title}${sub}</span>${res}</button>`;
  }).join('');
  const firstPending = p.steps.findIndex((s) => s.status === 'pending');
  render(`
    <div class="card">
      <div class="plan-head">${configIcon(p.config)}
        <div><h2>Your plan</h2><p class="hint">${p.config} speaker · tap a test to begin. Each ticks off as you finish.</p></div></div>
      <div class="plan-list">${rows}</div>
      <div class="capture-row" style="margin-top:12px">
        <button id="wizContinue" class="primary"${firstPending < 0 ? ' disabled' : ''}>${firstPending < 0 ? 'All done 🎉' : 'Continue'}</button>
        <button id="wizRestart" class="secondary">Start over</button>
      </div>
      <button id="wizGloss2" class="secondary" style="margin-top:8px">Glossary</button>
    </div>`);
  document.querySelectorAll('.plan-step').forEach((b) => b.addEventListener('click', () => renderInfo(+b.dataset.i)));
  if (firstPending >= 0) $('#wizContinue').addEventListener('click', () => renderInfo(firstPending));
  $('#wizRestart').addEventListener('click', () => { wiz.plan = null; wiz.config = null; renderStart(); });
  $('#wizGloss2').addEventListener('click', renderGlossary);
}

// Screen 1 — info / setup
function renderInfo(i) {
  const st = wiz.plan.steps[i], m = META[st.testType];
  const pairNote = st.pair && st.pair.note ? `<p class="hint">📍 ${st.pair.note}</p>` : '';
  render(`
    <div class="card wiz-screen">
      <div class="wiz-crumbs">Step ${i + 1} of ${wiz.plan.steps.length} · ${m.title}${st.pair ? ' — ' + st.pair.name : ''}</div>
      <h2>${m.title}</h2>
      <div class="wiz-sec"><h3>What it's for</h3><p>${m.for}</p></div>
      <div class="wiz-sec"><h3>What you'll produce</h3><p>${m.produce}</p></div>
      <div class="wiz-sec"><h3>How you'll use it</h3><p>${m.use}</p></div>
      <div class="wiz-sec"><h3>Recommended layout</h3><div class="wiz-svg">${m.svg()}</div><p>${m.layout}</p>${pairNote}</div>
      <div class="wiz-sec"><h3>How to read it</h3><p>${m.read}</p></div>
      <div class="wiz-sec"><h3>Key terms</h3><p class="chip-row">${m.terms.map((t) => chip(t)).join(' ')}</p></div>
      <div class="capture-row">
        <button id="wizBack" class="secondary">Back to plan</button>
        <button id="wizReady" class="primary">Ready</button>
      </div>
    </div>`);
  $('#wizBack').addEventListener('click', renderPlan);
  $('#wizReady').addEventListener('click', () => renderConfig(i));
}

// Screen 2 — data entry / configuration
function renderConfig(i) {
  const st = wiz.plan.steps[i], m = META[st.testType];
  const cfg = st.config;
  cfg.testSpeaker = cfg.testSpeaker || 'R';
  cfg.xo = cfg.xo || (st.pair ? st.pair.xo : 2500);
  ensureRange(st);
  const tw = pairHasTweeter(st);
  const activeRoles = st.pair ? [st.pair.a, st.pair.b] : [];
  const needDisconnect = m.pairTest;
  render(`
    <div class="card wiz-screen">
      <div class="wiz-crumbs">Setup · ${m.title}${st.pair ? ' — ' + st.pair.name : ''}</div>
      <div class="wiz-svg small">${configIcon(wiz.plan.config, activeRoles)}</div>
      <label class="driver-type-row">Test speaker (the one you're measuring)
        <select id="cfgSpeaker">
          <option value="L"${cfg.testSpeaker === 'L' ? ' selected' : ''}>Left</option>
          <option value="R"${cfg.testSpeaker === 'R' ? ' selected' : ''}>Right</option>
        </select></label>
      ${m.needsRef ? `<p class="hint">Reference = your <strong>other</strong> speaker (the ${cfg.testSpeaker === 'L' ? 'right' : 'left'} one), left where it is. It fires the timing marker so the tablet's audio delay cancels.</p>` : ''}
      ${st.pair ? `<p class="hint">This pair meets at their ${chip('crossoverFreq', 'crossover')}. We only trust the result across the range where both drivers actually play — around the crossover.</p>
        <label class="driver-type-row">Crossover frequency (Hz)
          <input id="cfgXo" type="number" min="100" max="15000" value="${cfg.xo}"/></label>` : ''}
      ${tw ? `<div class="wiz-warn">
        <p>This test drives a <strong>tweeter</strong>. As extra protection you can raise the sweep's
          start frequency to keep damaging lows out of it — but the ${chip('protectionCap', 'series cap')}
          is the real safeguard.</p>
        <div class="ref-row">
          <label class="driver-type-row">Sweep start (Hz)<input id="cfgF1" type="number" min="10" max="20000" value="${cfg.f1}"/></label>
          <label class="driver-type-row">Sweep end (Hz)<input id="cfgF2" type="number" min="100" max="24000" value="${cfg.f2}"/></label>
        </div></div>` : ''}
      ${needDisconnect ? `<div class="wiz-warn">
        <p>At the back of the speaker, unscrew the ${chip('terminals', 'binding posts')} and disconnect every driver except the one(s) being measured. If your drivers aren't wired individually, this test needs the ${chip('bypassCrossover', 'crossover bypassed')}.</p>
        <label class="modal-check"><input type="checkbox" id="cfgDisc"/><span>Drivers disconnected (only the one under test is connected).</span></label>
      </div>` : ''}
      <div class="capture-row">
        <button id="wizBack" class="secondary">Back</button>
        <button id="wizGo" class="primary"${needDisconnect ? ' disabled' : ''}>Start capture</button>
      </div>
    </div>`);
  $('#cfgSpeaker').addEventListener('change', (e) => { cfg.testSpeaker = e.target.value; renderConfig(i); });
  if (st.pair) $('#cfgXo').addEventListener('change', (e) => { cfg.xo = Math.max(100, parseInt(e.target.value, 10) || cfg.xo); });
  if (tw) {
    $('#cfgF1').addEventListener('change', (e) => { cfg.f1 = Math.max(10, parseInt(e.target.value, 10) || cfg.f1); });
    $('#cfgF2').addEventListener('change', (e) => { cfg.f2 = Math.max(cfg.f1 + 50, parseInt(e.target.value, 10) || cfg.f2); });
  }
  if (needDisconnect) $('#cfgDisc').addEventListener('change', (e) => { $('#wizGo').disabled = !e.target.checked; });
  $('#wizBack').addEventListener('click', () => renderInfo(i));
  $('#wizGo').addEventListener('click', () => renderCapture(i));
}

// Screen 3 — capture + result
function renderCapture(i) {
  const st = wiz.plan.steps[i], m = META[st.testType];
  const cfg = st.config;
  ensureRange(st);
  const refChannel = cfg.testSpeaker === 'L' ? 'R' : 'L'; // reference is the other speaker
  let controls;
  if (m.pairTest) {
    controls = `
      <div class="capture-row">
        <button class="secondary" data-cap="a">Capture ${ROLE_LABEL[st.pair.a]}</button>
        <button class="secondary" data-cap="b">Capture ${ROLE_LABEL[st.pair.b]}</button>
      </div>
      ${st.testType === 'driverOffset' ? '<button class="secondary" data-cap="rep" style="width:100%;margin-top:6px">Repeatability (same driver ×2)</button>' : ''}
      <p id="capA" class="hint">${ROLE_LABEL[st.pair.a]}: not captured</p>
      <p id="capB" class="hint">${ROLE_LABEL[st.pair.b]}: not captured</p>`;
  } else if (m.twoCap) {
    controls = `<div class="capture-row">
        <button class="secondary" data-cap="a">Capture A</button>
        <button class="secondary" data-cap="b">Capture B</button></div>
      <p id="capA" class="hint">A: not captured</p><p id="capB" class="hint">B: not captured</p>`;
  } else {
    controls = `<button class="primary" data-cap="one" style="width:100%">▶ Capture</button>`;
  }
  render(`
    <div class="card wiz-screen">
      <div class="wiz-crumbs">Capture · ${m.title}${st.pair ? ' — ' + st.pair.name : ''}</div>
      <p class="hint">Test speaker: <strong>${cfg.testSpeaker}</strong>${m.needsRef ? ` · reference: <strong>${refChannel}</strong>` : ''}. Keep everything still.</p>
      <div class="lvl-bar">
        <span id="lvlRange" class="hint">Sweep: ${cfg.f1}–${cfg.f2} Hz</span>
        <button id="testLevels" class="secondary">Test levels</button>
      </div>
      ${controls}
      <canvas id="wizPlot" class="wiz-plot"></canvas>
      <p id="wizStatus" class="status"></p>
      <div id="wizResult"></div>
      <div class="capture-row">
        <button id="wizBack" class="secondary">Back</button>
        <button id="wizDone" class="primary" disabled>Looks good</button>
      </div>
    </div>`);
  const plot = new Plot($('#wizPlot'));
  st.scratch = {};
  $('#wizBack').addEventListener('click', () => renderConfig(i));
  $('#wizDone').addEventListener('click', () => finishStep(i));
  host().querySelectorAll('[data-cap]').forEach((b) => b.addEventListener('click', () => runCapture(i, b.dataset.cap, plot, refChannel)));
  $('#testLevels').addEventListener('click', () => showLevelTest(st, () => {
    const el = $('#lvlRange'); if (el) el.textContent = `Sweep: ${st.config.f1}–${st.config.f2} Hz`;
  }));
}

async function runCapture(i, which, plot, refChannel) {
  const st = wiz.plan.steps[i], m = META[st.testType];
  if (!(await ensureAudio())) { $('#wizStatus').textContent = 'Please enable the mic (a permission prompt should appear).'; return; }
  // P0 gate: fires when the driver being played is a tweeter (offset/phase).
  if (m.pairTest) {
    const role = which === 'a' ? st.pair.a : which === 'b' ? st.pair.b : st.pair.a;
    if (!(await passesTweeterGate(role))) return;
  }
  const btns = host().querySelectorAll('[data-cap]'); btns.forEach((b) => (b.disabled = true));
  try {
    if (st.testType === 'driverOffset') await capOffsetFlow(st, which, plot, refChannel);
    else if (st.testType === 'relativePhase') await capPhaseFlow(st, which, plot, refChannel);
    else if (st.testType === 'distortion') await capDistortionFlow(st, plot);
    else if (st.testType === 'waterfall') await capWaterfallFlow(st, plot);
    else if (st.testType === 'comparativeMagnitude') await capCompareFlow(st, which, plot);
    else if (st.testType === 'nearfield') await capNearfieldFlow(st, plot);
  } catch (e) {
    $('#wizStatus').textContent = 'Error: ' + e.message;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

// ---- Per-test capture flows ----------------------------------------------
const AVG = 8;
async function averagedOffset(refChannel, s, label) {
  const offs = [];
  for (let k = 0; k < AVG; k++) {
    $('#wizStatus').textContent = `${label} ${k + 1}/${AVG}…`;
    const cap = await capOffset(refChannel, s);
    if (cap.valid) offs.push(cap.offsetSamples); // drop low-SNR / garbage captures
  }
  return offs; // may be shorter than AVG (or empty) if captures were rejected
}
async function capOffsetFlow(st, which, plot, refChannel) {
  const sr = session.ctx.sampleRate;
  const s = wizSettings(st);
  if (which === 'rep') {
    const c1 = await capOffset(refChannel, s);
    $('#wizStatus').textContent = 'Repeatability 2/2…';
    const c2 = await capOffset(refChannel, s);
    if (!c1.valid || !c2.valid) {
      $('#wizResult').innerHTML = `<p class="hint">⚠ Couldn't get a clean capture (weak / low-SNR impulse). Bypass the crossover, widen the sweep band, raise the level slightly, keep the room quiet, and retry.</p>`;
      return;
    }
    const diff = Math.abs(dsp.samplesToMm(c2.offsetSamples - c1.offsetSamples, sr));
    $('#wizResult').innerHTML = `<p class="hint">Repeatability: same driver twice differed by <strong>${diff.toFixed(1)} mm</strong> — ${diff <= 15 ? '✅ good, the reference is working.' : '⚠ over 15 mm; check nothing moved.'}</p>`;
    return;
  }
  const offs = await averagedOffset(refChannel, s, `Capturing ${which === 'a' ? ROLE_LABEL[st.pair.a] : ROLE_LABEL[st.pair.b]}`);
  const MIN_GOOD = 3;
  if (offs.length < MIN_GOOD) {
    $('#cap' + which.toUpperCase()).textContent = `${which === 'a' ? ROLE_LABEL[st.pair.a] : ROLE_LABEL[st.pair.b]}: ⚠ capture failed (${offs.length}/${AVG} usable)`;
    $('#cap' + which.toUpperCase()).classList.remove('captured');
    $('#wizResult').innerHTML = `<p class="hint">⚠ Too few clean captures. Likely causes: crossover still in the signal path, sweep band too narrow/low, level too low, or movement/noise. Fix and retry.</p>`;
    return;
  }
  const { mean, std } = dsp.robustMeanStd(offs);
  st.scratch[which] = { mean, std, sr };
  $('#cap' + which.toUpperCase()).textContent = `${which === 'a' ? ROLE_LABEL[st.pair.a] : ROLE_LABEL[st.pair.b]}: ${dsp.samplesToMm(mean, sr).toFixed(1)} mm (± ${dsp.samplesToMm(std, sr).toFixed(1)} mm)`;
  $('#cap' + which.toUpperCase()).classList.add('captured');
  if (st.scratch.a && st.scratch.b) {
    const zSamp = st.scratch.b.mean - st.scratch.a.mean;
    const zMm = dsp.samplesToMm(zSamp, sr);
    const stdMm = dsp.samplesToMm(Math.hypot(st.scratch.a.std, st.scratch.b.std), sr);
    const absMm = Math.abs(zMm);
    const verdict = stdMm > 15 ? '❌ error bar too big — not trustworthy yet.' : stdMm > Math.max(3, absMm * 0.5) ? '⚠ error bar is large relative to the offset.' : '✅ tight — trustworthy.';
    const dir = zMm >= 0 ? `${ROLE_LABEL[st.pair.b]} sits further back` : `${ROLE_LABEL[st.pair.a]} sits further back`;
    st.scratch.result = { summary: `${absMm.toFixed(1)} mm ± ${stdMm.toFixed(1)}`, detail: `${dir}. Enter as the driver Z position in VituixCAD.` };
    $('#wizResult').innerHTML = `<p class="result-big">${absMm.toFixed(1)} mm <span class="pm">± ${stdMm.toFixed(1)} mm</span></p><p class="hint">${dir}. ${verdict}<br>Enter as the driver's Z position in VituixCAD.</p>`;
    $('#wizDone').disabled = false;
  }
}
async function capPhaseFlow(st, which, plot, refChannel) {
  const res = await capLinear(st);
  st.scratch[which] = res;
  $('#cap' + which.toUpperCase()).textContent = `${which === 'a' ? ROLE_LABEL[st.pair.a] : ROLE_LABEL[st.pair.b]}: captured`;
  $('#cap' + which.toUpperCase()).classList.add('captured');
  const traces = [];
  if (st.scratch.a) traces.push({ freq: st.scratch.a.freq, values: phaseDeg(st.scratch.a.phase), color: TRACE_COLORS[0], name: st.pair.a, visible: true });
  if (st.scratch.b) traces.push({ freq: st.scratch.b.freq, values: phaseDeg(st.scratch.b.phase), color: TRACE_COLORS[1], name: st.pair.b, visible: true });
  plot.setYRange(-180, 180, 'phase (deg)');
  plot.draw(traces);
  if (st.scratch.a && st.scratch.b) {
    st.scratch.result = { summary: 'phase overlaid', detail: `Compare tracking around ${st.config.xo} Hz.` };
    $('#wizResult').innerHTML = `<p class="hint">Look at how the two curves line up around <strong>${st.config.xo} Hz</strong>. Tracking together = summing well; a big split or flip = polarity/offset issue.</p>`;
    $('#wizDone').disabled = false;
  }
}
async function capDistortionFlow(st, plot) {
  const ctx = session.ctx, mic = session.micStream, sr = ctx.sampleRate, s = wizSettings(st);
  $('#wizStatus').textContent = 'Capturing…';
  const sweep = dsp.generateESS(s.f1, s.f2, s.duration, sr);
  const rec = await audio.playAndRecord(ctx, mic, sweep, { tailSec: 1, level: s.level });
  const d = dsp.harmonicDistortion(rec, sweep, s.f1, s.f2, s.duration, sr, { maxHarmonic: 5, preMs: s.gatePre, postMs: s.gatePost, calFn: session.cal ? (f) => cal.calValueAt(session.cal, f) : null });
  const shift = (a) => { const v = new Float32Array(a.length); for (let j = 0; j < a.length; j++) v[j] = a[j] - d.ref; return v; };
  const traces = [{ freq: d.freq, values: shift(d.fundamentalDb), color: '#fff', name: 'fundamental', visible: true }];
  d.harmonics.forEach((h, idx) => traces.push({ freq: d.freq, values: shift(h.mag), color: TRACE_COLORS[idx], name: 'H' + h.n, visible: true }));
  plot.setYRange(-90, 5, 'dB rel. fundamental'); plot.draw(traces);
  st.scratch.result = { summary: d.maxThd.pct > 0 ? `worst THD ${d.maxThd.pct.toFixed(1)}%` : 'distortion measured', detail: '' };
  $('#wizStatus').textContent = ''; $('#wizResult').innerHTML = `<p class="hint">${d.maxThd.pct > 0 ? `Worst distortion ≈ <strong>${d.maxThd.pct.toFixed(1)}%</strong> around ${Math.round(d.maxThd.freq)} Hz.` : 'Distortion measured.'} Rising harmonics or a spike = something to chase.</p>`;
  $('#wizDone').disabled = false;
}
async function capWaterfallFlow(st, plot) {
  $('#wizStatus').textContent = 'Capturing…';
  const res = await capLinear(st);
  const frames = dsp.waterfall(res.ir, res.peakIdx, res.sr);
  let ref = -Infinity; for (let j = 0; j < frames[0].mag.length; j++) if (frames[0].mag[j] > ref) ref = frames[0].mag[j];
  const traces = frames.map((f, idx) => { const v = new Float32Array(f.mag.length); for (let j = 0; j < f.mag.length; j++) v[j] = f.mag[j] - ref; const b = Math.round(255 * (1 - idx / frames.length)); return { freq: f.freq, values: v, color: `rgba(${b},${Math.round(b * 0.6 + 60)},255,0.8)`, name: f.timeMs.toFixed(1), visible: true }; });
  plot.setYRange(-40, 5, 'CSD (dB, fades with time)'); plot.draw(traces);
  st.scratch.result = { summary: 'decay captured', detail: '' };
  $('#wizStatus').textContent = ''; $('#wizResult').innerHTML = `<p class="hint">Ridges that persist to the right (later in time) = something ringing on.</p>`;
  $('#wizDone').disabled = false;
}
async function capCompareFlow(st, which, plot) {
  $('#wizStatus').textContent = 'Capturing…';
  const res = await capLinear(st);
  st.scratch[which] = res;
  $('#cap' + which.toUpperCase()).textContent = `${which.toUpperCase()}: captured`;
  $('#cap' + which.toUpperCase()).classList.add('captured');
  const traces = [];
  if (st.scratch.a) traces.push({ freq: st.scratch.a.freq, values: st.scratch.a.mag, color: TRACE_COLORS[0], name: 'A', visible: true });
  if (st.scratch.b) traces.push({ freq: st.scratch.b.freq, values: st.scratch.b.mag, color: TRACE_COLORS[1], name: 'B', visible: true });
  plot.setYRange(-30, 15, 'dB (relative)'); plot.draw(traces);
  $('#wizStatus').textContent = '';
  if (st.scratch.a && st.scratch.b) {
    st.scratch.result = { summary: 'A/B captured', detail: '' };
    $('#wizResult').innerHTML = `<p class="hint">Trust the <strong>difference</strong> between the two curves, not the exact shape (uncalibrated mic).</p>`;
    $('#wizDone').disabled = false;
  }
}
async function capNearfieldFlow(st, plot) {
  $('#wizStatus').textContent = 'Capturing…';
  const res = await capLinear(st);
  plot.fMin = 10; plot.fMax = 500;
  plot.setYRange(-30, 15, 'dB (relative, LF)'); plot.draw([{ freq: res.freq, values: res.mag, color: TRACE_COLORS[2], name: 'nearfield', visible: true }]);
  st.scratch.result = { summary: 'LF captured', detail: '' };
  $('#wizStatus').textContent = ''; $('#wizResult').innerHTML = `<p class="hint">Shape matters, not level. The dip between the woofer and port nulls marks the box tuning frequency.</p>`;
  $('#wizDone').disabled = false;
}

function finishStep(i) {
  const st = wiz.plan.steps[i];
  st.status = 'done';
  st.result = st.scratch.result || { summary: 'done' };
  renderPlan();
}

// ---- Boot -----------------------------------------------------------------
initChips();
renderStart();
