/* Ghost Media Player — DJ track analysis (BPM estimate, first-beat phase, waveform overview)
 *
 * Pure DSP on one mono Float32Array — no DOM, no libraries. It runs ONCE per
 * track, only when the user asks for it (ANALYZE) or a feature needs a BPM
 * (SYNC / beat-synced transition), never in real time during playback.
 *
 * Method (all standard, deliberately simple):
 *   1. two band energy envelopes (low "kick" band, high "hat/snare" band) per 128-sample hop
 *   2. log-compress -> positive spectral-flux style onset signal, normalised and de-trended
 *   3. tempo: mean autocorrelation of the onset signal at multiples of each candidate beat
 *      period (70-180 BPM, 0.05 % grid), with a mild log-normal preference for ~110 BPM
 *      (this is what separates a true beat from its double/half-time alias)
 *   4. refinement: fine scan (0.005 BPM) around the winner on the full-rate signal using a
 *      Fourier coefficient; the phase of that coefficient gives the position of the beat grid
 *
 * Honest limits: it assumes ONE constant tempo for the whole track. Live-played or
 * tempo-drifting music, or tracks without a clear pulse, give a low-confidence result
 * and the UI says so. The grid is beat-aligned, not bar/phrase-aligned.
 */
(function (global) {
  "use strict";

  var HOP = 128;
  var BPM_MIN = 70, BPM_MAX = 180;
    var PRIOR_CENTER = 110, PRIOR_SIGMA = 0.55;         // octaves
  var ONSET_LAG_SEC = -0.003;                         // constant measured with the synthetic test-suite (see tests/)

  function waveformPeaks(samples, buckets) {
    var n = samples.length, out = new Float32Array(buckets), step = n / buckets, mx = 0, i, b;
    for (b = 0; b < buckets; b++) {
      var s = Math.floor(b * step), e = Math.min(n, Math.floor((b + 1) * step)), p = 0;
      for (i = s; i < e; i++) { var v = samples[i] < 0 ? -samples[i] : samples[i]; if (v > p) p = v; }
      out[b] = p; if (p > mx) mx = p;
    }
    if (mx > 0) for (b = 0; b < buckets; b++) out[b] = Math.sqrt(out[b] / mx);   // sqrt: quiet passages stay visible
    return out;
  }

  function onsetSignal(samples, sr) {
    var n = Math.floor(samples.length / HOP);
    var lowE = new Float64Array(n), highE = new Float64Array(n);
    var aL = 1 - Math.exp(-2 * Math.PI * 150 / sr);      // ~150 Hz one-pole low-pass  (kick band)
    var aH = 1 - Math.exp(-2 * Math.PI * 2000 / sr);     // ~2 kHz one-pole low-pass, subtracted -> high band
    var lp = 0, lh = 0, t, i, idx = 0;
    for (t = 0; t < n; t++) {
      var sl = 0, sh = 0;
      for (i = 0; i < HOP; i++, idx++) {
        var x = samples[idx];
        lp += aL * (x - lp);
        lh += aH * (x - lh);
        var hf = x - lh;
        sl += lp * lp; sh += hf * hf;
      }
      lowE[t] = sl / HOP; highE[t] = sh / HOP;
    }
    function flux(e) {
      var mean = 0, k;
      for (k = 0; k < n; k++) mean += e[k];
      mean = mean / n + 1e-12;
      var f = new Float64Array(n), prev = Math.log(1 + 50 * e[0] / mean), fm = 0;
      for (k = 1; k < n; k++) {
        var c = Math.log(1 + 50 * e[k] / mean);
        var d = c - prev; prev = c;
        if (d > 0) { f[k] = d; fm += d; }
      }
      fm = fm / n + 1e-12;
      for (k = 0; k < n; k++) f[k] /= fm;
      return f;
    }
    var f1 = flux(lowE), f2 = flux(highE), o = new Float64Array(n);
    for (t = 0; t < n; t++) o[t] = f1[t] + 0.5 * f2[t];
    onsetSignal.low = f1;      // kick-band-only flux, used to refine the beat phase
    // remove the slowly varying part (~0.5 s moving average, via prefix sums), keep the positive remainder
    var W = Math.max(3, Math.round(0.5 * sr / HOP)), half = W >> 1;
    var pre = new Float64Array(n + 1), out = new Float64Array(n);
    for (t = 0; t < n; t++) pre[t + 1] = pre[t] + o[t];
    for (t = 0; t < n; t++) {
      var a = Math.max(0, t - half), b = Math.min(n - 1, t + half);
      var v = o[t] - (pre[b + 1] - pre[a]) / (b - a + 1);
      out[t] = v > 0 ? v : 0;
    }
    return out;
  }

  /* Fourier coefficient of the onset signal at tempo `bpm`. Returns {mag, re, im}. */
  function coeff(sig, fps, bpm, step) {
    var w = 2 * Math.PI * (bpm / 60) / (fps / (step || 1));
    var c = Math.cos(w), s = Math.sin(w), cr = 1, ci = 0, re = 0, im = 0, n = sig.length;
    for (var t = 0; t < n; t += (step || 1)) {
      var v = sig[t];
      re += v * cr; im -= v * ci;
      var nr = cr * c - ci * s; ci = cr * s + ci * c; cr = nr;
    }
    return { mag: Math.sqrt(re * re + im * im), re: re, im: im };
  }

  /* The Fourier phase is a compromise between every instrument. Kicks mark the beat best, so fold
   * the kick-band onsets over one beat period and move the grid to the strongest peak, as long as
   * that stays close to the Fourier estimate and clearly stands out. */
  function refinePhase(low, fps, offset, period) {
    var NB = 128, prof = new Float64Array(NB), t, i;
    for (t = 0; t < low.length; t++) {
      var v = low[t];
      if (v <= 0) continue;
      var ph = (((t / fps - offset + period / 2) % period) + period) % period;
      prof[Math.min(NB - 1, Math.floor(ph / period * NB))] += v;
    }
    var sm = new Float64Array(NB), mean = 0;
    for (i = 0; i < NB; i++) { sm[i] = prof[(i + NB - 1) % NB] + prof[i] + prof[(i + 1) % NB]; mean += sm[i]; }
    mean /= NB;
    var pk = 0;
    for (i = 1; i < NB; i++) if (sm[i] > sm[pk]) pk = i;
    if (!(mean > 0) || sm[pk] < 2.0 * mean) return offset;
    var l = sm[(pk + NB - 1) % NB], c = sm[pk], r = sm[(pk + 1) % NB], den = l - 2 * c + r;
    var frac = den !== 0 ? 0.5 * (l - r) / den : 0;
    var delta = ((pk + 0.5 + frac) / NB) * period - period / 2;
    if (Math.abs(delta) > 0.15 * period) return offset;
    var out = offset + delta;
    return ((out % period) + period) % period;
  }

  /* How much more onset energy sits on the beat grid (+/- 35 ms) than chance would put there.
   * ~1 = onsets are spread evenly (no real beat); several = attacks really land on the beats. */
  function gridRatio(onset, fps, offset, period) {
    var win = 0.035, total = 0, hit = 0;
    for (var t = 0; t < onset.length; t++) {
      var v = onset[t];
      if (v <= 0) continue;
      total += v;
      var ph = ((t / fps - offset) % period + period) % period;
      if (Math.min(ph, period - ph) <= win) hit += v;
    }
    if (!(total > 0)) return 0;
    var chance = Math.min(0.5, (2 * win) / period);
    return (hit / total) / chance;
  }

  function prior(bpm) {
    var d = Math.log(bpm / PRIOR_CENTER) / Math.LN2;
    return Math.exp(-0.5 * (d / PRIOR_SIGMA) * (d / PRIOR_SIGMA));
  }

  /* Normalised autocorrelation of the (mean-removed) onset signal for lags 0..maxLag frames,
   * on a window of at most `winSec` taken from the middle of the track. */
  function autocorr(onset, fps, maxLagSec, winSec) {
    var n = onset.length, w = Math.min(n, Math.floor(winSec * fps));
    var start = Math.floor((n - w) / 2), i, L;
    var x = new Float64Array(w), mean = 0;
    for (i = 0; i < w; i++) { x[i] = onset[start + i]; mean += x[i]; }
    mean /= w;
    for (i = 0; i < w; i++) x[i] -= mean;
    var maxLag = Math.min(w - 2, Math.ceil(maxLagSec * fps)), ac = new Float64Array(maxLag + 2), a0 = 0;
    for (i = 0; i < w; i++) a0 += x[i] * x[i];
    if (!(a0 > 0)) return null;
    ac[0] = 1;
    for (L = 1; L <= maxLag + 1 && L < w; L++) {
      var sum = 0, lim = w - L;
      for (i = 0; i < lim; i++) sum += x[i] * x[i + L];
      ac[L] = (sum / lim) / (a0 / w);
    }
    return ac;
  }
  function acAt(ac, lag) {                      // linear interpolation at a fractional lag
    var i = Math.floor(lag), f = lag - i;
    if (i < 0 || i + 1 >= ac.length) return 0;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  }

  function analyze(samples, sr) {
    var peaks = waveformPeaks(samples, 1000);
    var duration = samples.length / sr;
    var result = { peaks: peaks, duration: duration, bpm: 0, offset: 0, confidence: "none", score: 0 };
    if (samples.length < sr * 8) return result;                  // too short to say anything

    var fps = sr / HOP;
    var onset = onsetSignal(samples, sr), lowFlux = onsetSignal.low, i, k;
    var energy = 0;
    for (i = 0; i < onset.length; i++) energy += onset[i];
    if (!(energy > 1e-6)) return result;

    // ---- tempo octave + coarse tempo: mean autocorrelation at multiples of the beat period.
    // (Autocorrelation, unlike a single Fourier bin, is not fooled by off-beat hats cancelling the beat.)
    var MAX_LAG_SEC = 8, MAX_TERMS = 16;
    var ac = autocorr(onset, fps, MAX_LAG_SEC, 180);
    if (!ac) return result;
    var maxLag = ac.length - 2;
    var step = Math.pow(2, 1 / 1400), cand = [], best = null, bestScore = -1e9;
    for (var b = BPM_MIN; b <= BPM_MAX; b *= step) {
      var T = 60 / b * fps;                                       // beat period in frames
      var terms = Math.min(MAX_TERMS, Math.floor(maxLag / T));
      if (terms < 3) continue;
      var sum = 0;
      for (k = 1; k <= terms; k++) sum += acAt(ac, k * T);
      var sc = sum / terms;
      var weighted = sc * prior(b);
      cand.push(sc);
      if (weighted > bestScore) { bestScore = weighted; best = { bpm: b, raw: sc }; }
    }
    if (!best) return result;
    var coarse = best.bpm;

    // ---- fine scan on the full-rate onset signal (+/- 0.35 %): sharpest Fourier peak near the coarse tempo
    var lo = coarse * 0.9965, hi = coarse * 1.0035, fstep = 0.005, fb = coarse, fs = -1, fc = null;
    for (var q = lo; q <= hi; q += fstep) {
      var c1 = coeff(onset, fps, q);
      if (c1.mag > fs) { fs = c1.mag; fb = q; fc = c1; }
    }
    var bpm = fb;
    if (Math.abs(bpm - Math.round(bpm)) < 0.05) bpm = Math.round(bpm);   // studio tempos are almost always whole numbers
    else bpm = Math.round(bpm * 100) / 100;
    if (bpm !== fb) fc = coeff(onset, fps, bpm);

    // ---- beat phase from the same coefficient.
    // C = sum o[t] e^{-i w t}; onsets at t0 + k*P give arg(C) = -w*t0, so t0 = -arg(C)/w
    var theta = -Math.atan2(fc.im, fc.re); if (theta < 0) theta += 2 * Math.PI;
    var periodSec = 60 / bpm;
    var offset = (theta / (2 * Math.PI)) * periodSec - ONSET_LAG_SEC;
    offset = ((offset % periodSec) + periodSec) % periodSec;
    offset = refinePhase(lowFlux, fps, offset, periodSec);

    // ---- confidence: how far the winner stands out from a typical candidate tempo, and whether
    //      the onset signal consists of sharp repeated attacks at all
    var sorted = cand.slice().sort(function (x, y) { return x - y; });
    var median = Math.max(sorted[sorted.length >> 1], 0) + 0.02;
    var ratio = Math.max(best.raw, 0) / median;
    var grid = gridRatio(onset, fps, offset, periodSec);
    result.bpm = bpm; result.offset = offset; result.score = ratio; result.gridRatio = grid;
    var conf = grid >= GRID_HIGH && ratio >= 3 ? "high" : grid >= GRID_MED && ratio >= 2 ? "medium" : "low";
    result.confidence = conf;
    return result;
  }

  var GRID_HIGH = 2.6, GRID_MED = 1.9;     // calibrated by the test-suite

  global.GhostBeat = {
    analyze: analyze, waveformPeaks: waveformPeaks,
    _internals: { onsetSignal: onsetSignal, coeff: coeff, HOP: HOP }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.GhostBeat;
})(typeof window !== "undefined" ? window : globalThis);
