// dsp.js — the measurement maths (spec §4).
// ESS generation, deconvolution, gating, spectrum, smoothing, phase/group-delay,
// driver time-offset, and a basic cumulative spectral decay.
//
// Design note: for the linear IR (FR / phase / group delay / offset) we use
// frequency-domain *regularised* deconvolution. Because we divide by the KNOWN
// sweep spectrum, absolute play/record latency is irrelevant — the impulse just
// lands later in the buffer and we window around its peak (spec §4.3).

import { fft, ifft, nextPow2 } from './fft.js';

const SPEED_OF_SOUND = 343; // m/s at ~20°C

// --- 1. Exponential sine sweep (Farina) ------------------------------------
export function generateESS(f1, f2, duration, sampleRate, fadeMs = 20) {
  const N = Math.round(duration * sampleRate);
  const w1 = 2 * Math.PI * f1;
  const w2 = 2 * Math.PI * f2;
  const L = Math.log(w2 / w1) / duration;      // sweep rate
  const K = w1 / L;                            // = w1 * T / ln(w2/w1)
  const sweep = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / sampleRate;
    sweep[n] = Math.sin(K * (Math.exp(t * L) - 1));
  }
  applyFades(sweep, Math.round((fadeMs / 1000) * sampleRate));
  return sweep;
}

function applyFades(buf, fn) {
  const N = buf.length;
  for (let i = 0; i < fn && i < N; i++) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / fn)); // raised-cosine
    buf[i] *= w;
    buf[N - 1 - i] *= w;
  }
}

// --- 2. Deconvolution: recording ⊗ inverse(sweep) → impulse response --------
// Regularised inverse filter H = Rec · conj(S) / (|S|² + ε).
export function deconvolve(recording, sweep, regDb = -60) {
  const L = nextPow2(recording.length + sweep.length);
  const sr = new Float32Array(L), si = new Float32Array(L);
  const rr = new Float32Array(L), ri = new Float32Array(L);
  sr.set(sweep);
  rr.set(recording);
  fft(sr, si);
  fft(rr, ri);

  let maxMag2 = 0;
  for (let i = 0; i < L; i++) {
    const m = sr[i] * sr[i] + si[i] * si[i];
    if (m > maxMag2) maxMag2 = m;
  }
  const eps = maxMag2 * Math.pow(10, regDb / 10);

  const hr = new Float32Array(L), hi = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const denom = sr[i] * sr[i] + si[i] * si[i] + eps;
    hr[i] = (rr[i] * sr[i] + ri[i] * si[i]) / denom; // Re(Rec·conj(S))
    hi[i] = (ri[i] * sr[i] - rr[i] * si[i]) / denom; // Im(Rec·conj(S))
  }
  ifft(hr, hi);
  return hr; // real impulse response (imag ≈ 0)
}

// --- 3. Peak location (with sub-sample parabolic refinement) ----------------
export function findPeak(ir) {
  let idx = 0, max = 0;
  for (let i = 0; i < ir.length; i++) {
    const a = Math.abs(ir[i]);
    if (a > max) { max = a; idx = i; }
  }
  return idx;
}

// Sub-sample peak position via parabolic interpolation over |ir| — matters for
// the driver-offset "jewel" where we care about fractions of a sample.
export function findPeakSubSample(ir) {
  const i = findPeak(ir);
  if (i <= 0 || i >= ir.length - 1) return i;
  const a = Math.abs(ir[i - 1]), b = Math.abs(ir[i]), c = Math.abs(ir[i + 1]);
  const denom = a - 2 * b + c;
  if (denom === 0) return i;
  return i + (0.5 * (a - c)) / denom;
}

// --- 4. Gate / window the IR ------------------------------------------------
// A short post-window rejects room reflections but limits low-frequency validity
// to roughly f_low ≈ 1 / postSeconds (spec §4.4). preMs keeps a little of the
// leading edge; both edges get a raised-cosine taper to limit spectral leakage.
export function gateIR(ir, peakIdx, sampleRate, preMs = 1, postMs = 5) {
  const pre = Math.round((preMs / 1000) * sampleRate);
  const post = Math.round((postMs / 1000) * sampleRate);
  const start = Math.max(0, peakIdx - pre);
  const end = Math.min(ir.length, peakIdx + post);
  const len = end - start;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = ir[start + i];

  const hf = Math.min(pre, len);
  for (let i = 0; i < hf; i++) out[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / hf));
  const tf = Math.min(post, len);
  for (let i = 0; i < tf; i++) out[len - tf + i] *= 0.5 * (1 + Math.cos((Math.PI * i) / tf));

  return out;
}

// Low-frequency validity limit for a given post-gate length (Hz).
export function gateFloorHz(postMs) {
  return postMs > 0 ? 1000 / postMs : Infinity;
}

// --- 5. Spectrum from the gated IR -----------------------------------------
export function spectrum(gated, sampleRate, pad = 4) {
  const L = nextPow2(gated.length * pad); // zero-pad → smoother frequency grid
  const re = new Float32Array(L), im = new Float32Array(L);
  re.set(gated);
  fft(re, im);
  const half = L >> 1;
  const freq = new Float32Array(half);
  const mag = new Float32Array(half);
  const phase = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    freq[i] = (i * sampleRate) / L;
    mag[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) + 1e-12);
    phase[i] = Math.atan2(im[i], re[i]);
  }
  return { freq, mag, phase, L };
}

// --- 6. Fractional-octave smoothing (power-averaged) -----------------------
export function fractionalOctaveSmooth(freq, magDb, fraction) {
  const n = freq.length;
  const out = new Float32Array(n);
  if (n < 2) return Float32Array.from(magDb);
  const factor = Math.pow(2, 1 / (2 * fraction)); // half-bandwidth ratio
  const df = freq[1] - freq[0];
  for (let i = 0; i < n; i++) {
    const f = freq[i];
    if (f <= 0) { out[i] = magDb[i]; continue; }
    const a = Math.max(0, Math.floor(f / factor / df));
    const b = Math.min(n - 1, Math.ceil((f * factor) / df));
    let sum = 0, cnt = 0;
    for (let k = a; k <= b; k++) { sum += Math.pow(10, magDb[k] / 10); cnt++; } // power avg
    out[i] = cnt ? 10 * Math.log10(sum / cnt) : magDb[i];
  }
  return out;
}

// Normalise a magnitude trace to ~0 dB over a reference band — this is a
// RELATIVE tool, so A/B overlays line up rather than floating apart.
export function normaliseToBand(freq, magDb, lo = 200, hi = 2000) {
  let sum = 0, cnt = 0;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= lo && freq[i] <= hi) { sum += magDb[i]; cnt++; }
  }
  if (!cnt) return Float32Array.from(magDb);
  const ref = sum / cnt;
  const out = new Float32Array(magDb.length);
  for (let i = 0; i < magDb.length; i++) out[i] = magDb[i] - ref;
  return out;
}

// --- 7. Phase & group delay -------------------------------------------------
export function unwrap(phase) {
  const out = Float32Array.from(phase);
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > Math.PI) { out[i] -= 2 * Math.PI; d = out[i] - out[i - 1]; }
    while (d < -Math.PI) { out[i] += 2 * Math.PI; d = out[i] - out[i - 1]; }
  }
  return out;
}

// Group delay = −dφ/dω, returned in milliseconds.
export function groupDelayMs(freq, phase) {
  const up = unwrap(phase);
  const n = freq.length;
  const gd = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const dw = 2 * Math.PI * (freq[i] - freq[i - 1]);
    gd[i] = dw !== 0 ? (-(up[i] - up[i - 1]) / dw) * 1000 : 0;
  }
  gd[0] = gd[1] || 0;
  return gd;
}

// --- 8. Driver time-offset (spec §5, "the jewel") --------------------------
// Two IRs at the same mic position → arrival-time difference → mm of z-offset.
export function driverOffset(irA, irB, sampleRate) {
  const pa = findPeakSubSample(irA);
  const pb = findPeakSubSample(irB);
  const dSamples = pb - pa;
  const dMs = (dSamples / sampleRate) * 1000;
  const dMm = (dMs / 1000) * SPEED_OF_SOUND * 1000;
  return { peakA: pa, peakB: pb, dSamples, dMs, dMm };
}

// --- 8b. Harmonic distortion (Farina method, spec §5) ----------------------
// With an exponential sweep, each harmonic order deconvolves into its OWN
// impulse response, arriving BEFORE the linear one by Δt_n = T·ln(n)/ln(f2/f1).
// We window each out separately and FFT it → the Nth-harmonic response indexed
// by the fundamental frequency (Farina's result — the same axis REW plots on).
//
// This needs the time-reversed *inverse filter* (not the frequency-domain
// division used for the linear IR), because that division smears the harmonics
// together. The inverse filter also whitens the sweep's pink spectrum: the
// reversed sweep is amplitude-modulated at +6 dB/octave (∝ instantaneous freq).

export function generateInverseFilter(sweep, f1, f2, duration, sampleRate) {
  const N = sweep.length;
  const L = Math.log(f2 / f1) / duration; // sweep rate (per second)
  const inv = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const tau = n / sampleRate;            // time into the REVERSED sweep
    inv[n] = sweep[N - 1 - n] * Math.exp(-tau * L); // +6 dB/oct whitening
  }
  return inv;
}

function fftConvolve(a, b) {
  const L = nextPow2(a.length + b.length);
  const ar = new Float32Array(L), ai = new Float32Array(L);
  const br = new Float32Array(L), bi = new Float32Array(L);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  const cr = new Float32Array(L), ci = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    cr[i] = ar[i] * br[i] - ai[i] * bi[i];
    ci[i] = ar[i] * bi[i] + ai[i] * br[i];
  }
  ifft(cr, ci);
  return cr;
}

// Returns { freq, fundamentalDb, ref, harmonics:[{n,mag}], thd, maxThd }.
// All spectra share ONE frequency grid (identical window length → directly
// comparable magnitudes, no interpolation needed).
export function harmonicDistortion(recording, sweep, f1, f2, duration, sampleRate, opts = {}) {
  const maxHarmonic = opts.maxHarmonic || 5;
  const preMs = opts.preMs != null ? opts.preMs : 1;
  const postMs = opts.postMs != null ? opts.postMs : 5;

  const inv = generateInverseFilter(sweep, f1, f2, duration, sampleRate);
  const full = fftConvolve(recording, inv);
  const linPeak = findPeak(full); // linear IR — strongest, latest major peak
  const ratio = Math.log(f2 / f1);

  const fund = gateIR(full, linPeak, sampleRate, preMs, postMs);
  const fSpec = spectrum(fund, sampleRate, 8);
  const freq = fSpec.freq;
  const fundamentalDb = fSpec.mag;

  const harmonics = [];
  for (let n = 2; n <= maxHarmonic; n++) {
    const dt = (duration * Math.log(n)) / ratio; // seconds before linear peak
    const idx = Math.round(linPeak - dt * sampleRate);
    if (idx < postMs * sampleRate / 1000) break;  // ran out of pre-impulse room
    const hIR = gateIR(full, idx, sampleRate, preMs, postMs);
    // Same gate + same pad ⇒ identical grid to the fundamental.
    harmonics.push({ n, mag: spectrum(hIR, sampleRate, 8).mag });
  }

  // Mic-correction: fundamental at f, but harmonic n at its true acoustic
  // frequency n·f (that's where the mic actually coloured it).
  const calFn = opts.calFn || null;
  if (calFn) {
    for (let i = 0; i < freq.length; i++) fundamentalDb[i] -= calFn(freq[i]);
    for (const h of harmonics) {
      for (let i = 0; i < freq.length; i++) h.mag[i] -= calFn(h.n * freq[i]);
    }
  }

  // Band reference so displayed harmonics sit at their true level BELOW the
  // fundamental (fundamental normalised to ~0 dB over 200 Hz–2 kHz).
  let sum = 0, cnt = 0;
  for (let i = 0; i < freq.length; i++) {
    if (freq[i] >= 200 && freq[i] <= 2000) { sum += fundamentalDb[i]; cnt++; }
  }
  const ref = cnt ? sum / cnt : 0;

  // THD(%) vs fundamental frequency = √(Σ Hₙ²) / H₁ · 100.
  const lin = (db) => Math.pow(10, db / 20);
  const thd = new Float32Array(freq.length);
  const nyq = sampleRate / 2;
  let maxThd = { pct: 0, freq: 0 };
  for (let i = 0; i < freq.length; i++) {
    const h1 = lin(fundamentalDb[i]);
    let s = 0;
    for (const h of harmonics) s += Math.pow(lin(h.mag[i]), 2);
    const pct = h1 > 1e-9 ? (Math.sqrt(s) / h1) * 100 : 0;
    thd[i] = pct;
    // Only trust the band where the fundamental is well excited and the top
    // harmonic still fits under Nyquist.
    const f = freq[i];
    if (f >= Math.max(f1, 60) && f <= Math.min(f2, nyq / maxHarmonic) &&
        fundamentalDb[i] > ref - 30 && pct > maxThd.pct) {
      maxThd = { pct, freq: f };
    }
  }

  return { freq, fundamentalDb, ref, harmonics, thd, maxThd, linPeak, sampleRate };
}

// --- 8c. Acoustic timing reference (driver-offset-reference-spec P1) --------
// Self-referenced captures: in ONE recording we hear a fixed reference marker
// (a short HF chirp on the reference channel/speaker) AND the driver's swept
// response. Because both events share the same per-capture play/record latency,
// measuring the driver arrival RELATIVE to the reference arrival cancels that
// latency — which is the ~0.2–0.3 ms iOS jitter that made absolute peak-timing
// unusable. z_offset = (t_driverB − t_refB) − (t_driverA − t_refA).

// Short Hann-windowed 2–4 kHz chirp — sharp cross-correlation, easy to separate
// from the low-frequency start of the main sweep.
export function generateRefMarker(sampleRate, { f1 = 2000, f2 = 4000, durMs = 2 } = {}) {
  const N = Math.max(2, Math.round((durMs / 1000) * sampleRate));
  const T = N / sampleRate;
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / sampleRate;
    const phase = 2 * Math.PI * (f1 * t + ((f2 - f1) / (2 * T)) * t * t); // linear chirp
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));          // Hann
    out[n] = Math.sin(phase) * w;
  }
  return out;
}

// Matched-filter cross-correlation: sub-sample lag where `template` best aligns
// inside `signal` (i.e. the template's arrival index). Parabolic-interpolated.
export function crossCorrPeak(signal, template) {
  const L = nextPow2(signal.length + template.length);
  const sr = new Float32Array(L), si = new Float32Array(L);
  const tr = new Float32Array(L), ti = new Float32Array(L);
  sr.set(signal); tr.set(template);
  fft(sr, si); fft(tr, ti);
  const cr = new Float32Array(L), ci = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    cr[i] = sr[i] * tr[i] + si[i] * ti[i]; // Re(S·conj(T))
    ci[i] = si[i] * tr[i] - sr[i] * ti[i]; // Im(S·conj(T))
  }
  ifft(cr, ci);
  let idx = 0, max = 0;
  for (let i = 0; i < signal.length; i++) { const a = Math.abs(cr[i]); if (a > max) { max = a; idx = i; } }
  if (idx > 0 && idx < signal.length - 1) {
    const a = Math.abs(cr[idx - 1]), b = Math.abs(cr[idx]), c = Math.abs(cr[idx + 1]);
    const den = a - 2 * b + c;
    if (den !== 0) return idx + (0.5 * (a - c)) / den;
  }
  return idx;
}

// One self-referenced capture → offset (samples) of driver arrival relative to
// the reference marker arrival, both measured inside the same recording.
export function selfReferencedOffset(recording, sweep, marker, sampleRate) {
  const ir = deconvolve(recording, sweep);
  const tDriver = findPeakSubSample(ir);
  // The marker is emitted BEFORE the sweep, so it arrives before tDriver.
  // Restrict the cross-correlation to [0, tDriver) — otherwise the sweep's own
  // pass through the marker's 2–4 kHz band (much later in the sweep) can win the
  // correlation and wreck the reference timing.
  const searchEnd = Math.max(marker.length + 1, Math.min(recording.length, Math.floor(tDriver)));
  const tRef = crossCorrPeak(recording.subarray(0, searchEnd), marker);
  return { tRef, tDriver, offsetSamples: tDriver - tRef };
}

export function samplesToMm(samples, sampleRate, c = 343) {
  return (samples / sampleRate) * c * 1000;
}

export function meanStd(arr) {
  const n = arr.length;
  if (!n) return { mean: 0, std: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

// --- 9. Cumulative spectral decay (basic waterfall, spec §5) ---------------
// Successively shift the window into the IR tail and FFT each slice.
export function waterfall(ir, peakIdx, sampleRate, slices = 12, stepMs = 0.3, winMs = 5) {
  const step = Math.round((stepMs / 1000) * sampleRate);
  const win = Math.round((winMs / 1000) * sampleRate);
  const frames = [];
  for (let s = 0; s < slices; s++) {
    const start = peakIdx + s * step;
    const seg = new Float32Array(win);
    for (let i = 0; i < win && start + i < ir.length; i++) {
      const w = 0.5 * (1 + Math.cos((Math.PI * i) / win)); // decaying half-window
      seg[i] = ir[start + i] * w;
    }
    const { freq, mag } = spectrum(seg, sampleRate, 2);
    frames.push({ timeMs: (s * step * 1000) / sampleRate, freq, mag });
  }
  return frames;
}
