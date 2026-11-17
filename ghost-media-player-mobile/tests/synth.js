// Synthetic test music (no copyrighted material): kick / snare / hat patterns at a known tempo and offset.
"use strict";
function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* opts: bpm, offset (s), seconds, sr, hats, snare, noise, swing(0..0.3), seed */
function makeTrack(o) {
  var sr = o.sr || 11025, n = Math.floor(o.seconds * sr), x = new Float32Array(n), r = rng(o.seed || 1);
  var beat = 60 / o.bpm;
  function addKick(t0) {
    var s0 = Math.floor(t0 * sr), len = Math.floor(0.22 * sr), ph = 0;
    for (var i = 0; i < len && s0 + i < n; i++) {
      var tt = i / sr, f = 50 + 90 * Math.exp(-tt * 28);
      ph += 2 * Math.PI * f / sr;
      x[s0 + i] += 0.9 * Math.sin(ph) * Math.exp(-tt * 14);
    }
  }
  function addNoise(t0, dur, amp, decay) {
    var s0 = Math.floor(t0 * sr), len = Math.floor(dur * sr), prev = 0;
    for (var i = 0; i < len && s0 + i < n; i++) {
      var w = r() * 2 - 1, hp = w - prev * 0.9; prev = w;
      x[s0 + i] += amp * hp * Math.exp(-(i / sr) * decay);
    }
  }
  var nb = Math.floor((o.seconds - o.offset) / beat) + 1;
  for (var k = 0; k < nb; k++) {
    var tb = o.offset + k * beat;
    if (o.kick !== false) addKick(tb);
    if (o.snare && k % 2 === 1) addNoise(tb, 0.15, 0.5, 22);
    if (o.hats) {
      addNoise(tb + beat * 0.5 + (o.swing || 0) * beat, 0.05, 0.22, 90);
      if (o.hats === 16) { addNoise(tb + beat * 0.25, 0.04, 0.12, 110); addNoise(tb + beat * 0.75, 0.04, 0.12, 110); }
    }
  }
  if (o.bass) for (var i2 = 0; i2 < n; i2++) x[i2] += 0.12 * Math.sin(2 * Math.PI * 55 * i2 / sr);
  if (o.noise) for (var j = 0; j < n; j++) x[j] += o.noise * (r() * 2 - 1);
  return x;
}
function noiseOnly(seconds, sr, amp, seed) {
  var n = Math.floor(seconds * sr), x = new Float32Array(n), r = rng(seed || 9);
  for (var i = 0; i < n; i++) x[i] = amp * (r() * 2 - 1);
  return x;
}
function toneOnly(seconds, sr) {
  var n = Math.floor(seconds * sr), x = new Float32Array(n);
  for (var i = 0; i < n; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / sr) + 0.2 * Math.sin(2 * Math.PI * 330 * i / sr);
  return x;
}
module.exports = { makeTrack: makeTrack, noiseOnly: noiseOnly, toneOnly: toneOnly };
