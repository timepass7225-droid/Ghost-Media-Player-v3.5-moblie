/* Ghost Media Player — shared DSP rack (Web Audio, real processing, fully offline)
 *
 *   input → [Vocal stage] → [Voice stage] → [Bass stage] → [HD stage] → output
 *
 * One global state (GhostDSP.state) drives every chain that was created, so the
 * Effects panel (normal player) and DJ Mode always show and use the same settings.
 * A stage that is neutral is bypassed with a direct wire, so it costs no CPU.
 *
 * Honest limits (also shown in the UI):
 *  - Vocal remover = centre-channel cancellation in the vocal band. It works on
 *    stereo songs whose vocal is panned to the centre. It is not AI stem
 *    separation: reverb, doubled vocals and centre-panned drums are only reduced.
 *  - Voice changer = real pitch shifting + ring modulation + filters. It is a
 *    live effect, not a speech model.
 *  - Bass Monster / Earthquake pushes real 40–90 Hz energy plus harmonics (so
 *    small speakers also "hit"). How much a table shakes depends on your speakers.
 *  - Sound Tone (instrument swap) listens to the song live. Every kick, snare and hi-hat it hears fires a synthesised
 *    instrument hit (tabla, dholak, darbuka ...) at the same moment, while the original drums are filtered down and a
 *    harmonium / pad drone is added. The voice and melody stay. It is NOT AI stem separation, so the original drums
 *    are reduced, not erased, and it follows the beat it hears rather than re-writing the song.
 *  - HD sound cannot add detail that a low quality file does not contain; it
 *    runs the engine at 96 kHz when the sound card allows and adds clarity.
 */
(function (global) {
  "use strict";
  if (global.GhostDSP) return;

  var LS_KEY = "ghost.dsp.v1";
  var LS_HIRES = "ghost.hires.v1";

  var VOICES = {
    off:       { label: "Normal",     pitch: 0,   ring: 0,   mix: 0,    vib: 0,   vibHz: 6, dist: 0,    hp: 20,  lp: 20000 },
    chipmunk:  { label: "Chipmunk",   pitch: 7,   ring: 0,   mix: 0,    vib: 0,   vibHz: 6, dist: 0,    hp: 180, lp: 20000 },
    child:     { label: "Child",      pitch: 10,  ring: 0,   mix: 0,    vib: 0.1, vibHz: 7, dist: 0,    hp: 260, lp: 14000 },
    deep:      { label: "Deep Man",   pitch: -5,  ring: 0,   mix: 0,    vib: 0,   vibHz: 6, dist: 0,    hp: 20,  lp: 9000 },
    monster:   { label: "Monster",    pitch: -9,  ring: 28,  mix: 0.35, vib: 0,   vibHz: 6, dist: 0.35, hp: 20,  lp: 5200 },
    demon:     { label: "Demon",      pitch: -12, ring: 18,  mix: 0.5,  vib: 0.1, vibHz: 4, dist: 0.6,  hp: 20,  lp: 3600 },
    robot:     { label: "Robot",      pitch: 0,   ring: 55,  mix: 1,    vib: 0,   vibHz: 6, dist: 0.05, hp: 120, lp: 9000 },
    alien:     { label: "Alien",      pitch: 4,   ring: 320, mix: 0.5,  vib: 0.7, vibHz: 9, dist: 0,    hp: 150, lp: 12000 },
    telephone: { label: "Telephone",  pitch: 0,   ring: 0,   mix: 0,    vib: 0,   vibHz: 6, dist: 0.1,  hp: 420, lp: 3300 },
    megaphone: { label: "Megaphone",  pitch: 0,   ring: 0,   mix: 0,    vib: 0,   vibHz: 6, dist: 0.55, hp: 520, lp: 4200 }
  };

  var DEFAULTS = {
    vocal: 0,            // 0..100  amount of centre cancellation
    vocalMode: "remove", // remove | only
    voice: "off",        // key of VOICES
    pitch: 0,            // extra semitones on top of the voice preset (-12..12)
    bass: 0,             // 0..100  Bass Monster
    sub: 0,              // 0..100  Earthquake sub layer
    hd: 0,               // 0..100  HD clarity (exciter + air)
    tone: "off",         // key of TONES (instrument swap)
    toneBeat: 80,        // 0..100  level of the new instrument hits
    toneStrip: 70,       // 0..100  how far the original drums are pushed down
    toneDrone: 35,       // 0..100  level of the harmonium / pad drone
    toneKey: 0           // 0..11   drone key (0 = C)
  };

  /* ---- Sound Tone instruments. Each hit is built from sine "body" tones with a pitch glide, optional ring partials
   * and a band-filtered noise burst, so no sample files are needed. low = kick, mid = snare, high = hat. ---- */
  var TONES = {
    off:     { label: "Original", where: "No change" },
    tabla:   { label: "Tabla & Harmonium", where: "India",
      low:  { f0: 150, f1: 68, dec: .34, g: .95, noise: { f: 300, q: .8, dec: .03, g: .22 } },
      mid:  { f0: 345, f1: 332, dec: .24, g: .55, parts: [[2.0, .3, .13], [3.0, .16, .08]], noise: { f: 2800, q: 2, dec: .02, g: .2 } },
      high: { f0: 580, f1: 550, dec: .09, g: .32, noise: { f: 6000, q: 1.2, dec: .05, g: .28 } },
      drone: { h: [1, .6, .5, .35, .3, .2, .15, .1], chord: [1, 1.5, 2], lp: 2300, trem: 5.2, depth: .1 } },
    dholak:  { label: "Dholak & Bhangra", where: "Punjab, India",
      low:  { f0: 118, f1: 60, dec: .42, g: 1, noise: { f: 220, q: .7, dec: .05, g: .3 } },
      mid:  { f0: 430, f1: 405, dec: .13, g: .5, parts: [[1.5, .28, .06]], noise: { f: 3200, q: 1.5, dec: .03, g: .4 } },
      high: { f0: 2400, f1: 2300, dec: .04, g: .1, noise: { f: 7500, q: .8, dec: .07, g: .34, type: "highpass" } },
      drone: { h: [1, .8, .6, .5, .4, .3, .2, .1], chord: [1, 1.5], lp: 1900, trem: 5.8, depth: .16 } },
    darbuka: { label: "Darbuka & Oud", where: "Arabic world",
      low:  { f0: 165, f1: 105, dec: .22, g: .9, noise: { f: 400, q: .8, dec: .02, g: .2 } },
      mid:  { f0: 710, f1: 650, dec: .07, g: .45, noise: { f: 4200, q: 2, dec: .025, g: .35 } },
      high: { f0: 1150, f1: 1100, dec: .035, g: .18, noise: { f: 6500, q: 1.4, dec: .045, g: .3 } },
      drone: { h: [1, .5, .35, .22, .12], chord: [1, 1.335, 2], lp: 1600, trem: 4.4, depth: .12 } },
    djembe:  { label: "Djembe & Kalimba", where: "West Africa",
      low:  { f0: 122, f1: 76, dec: .44, g: 1, noise: { f: 260, q: .7, dec: .04, g: .2 } },
      mid:  { f0: 235, f1: 215, dec: .2, g: .5, noise: { f: 900, q: 1, dec: .05, g: .22 } },
      high: { f0: 490, f1: 470, dec: .05, g: .2, noise: { f: 2600, q: 1, dec: .06, g: .55 } },
      drone: { h: [1, .28, .1, .05], chord: [1, 1.25, 1.5], lp: 3200, trem: 3.2, depth: .07 } },
    taiko:   { label: "Taiko & Shamisen", where: "Japan",
      low:  { f0: 88, f1: 42, dec: .8, g: 1, noise: { f: 150, q: .5, dec: .12, g: .4 } },
      mid:  { f0: 165, f1: 112, dec: .36, g: .6, noise: { f: 700, q: .8, dec: .06, g: .25 } },
      high: { f0: 960, f1: 900, dec: .05, g: .3, noise: { f: 3400, q: 1, dec: .05, g: .3, type: "highpass" } },
      drone: { h: [1, .7, .4, .3, .2], chord: [1, 1.5], lp: 1500, trem: 0, depth: 0, breath: .06 } },
    conga:   { label: "Congas & Organ", where: "Latin America",
      low:  { f0: 138, f1: 118, dec: .38, g: .9, noise: { f: 300, q: .8, dec: .03, g: .2 } },
      mid:  { f0: 292, f1: 270, dec: .28, g: .55, parts: [[1.9, .18, .1]], noise: { f: 1200, q: 1, dec: .04, g: .2 } },
      high: { f0: 530, f1: 505, dec: .04, g: .18, noise: { f: 2300, q: 1.2, dec: .055, g: .5 } },
      drone: { h: [1, 0, .32, 0, .2, 0, .1], chord: [1, 1.25, 1.5], lp: 2600, trem: 6.4, depth: .1 } }
  };
  var TONE_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var TONE_LOOKAHEAD = 0.04;   // s: the original audio is delayed by this much so a hit can be placed exactly on the beat it was heard on

  function assign(t, s) { for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; return t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function load() {
    try { var o = JSON.parse(localStorage.getItem(LS_KEY)); return assign(assign({}, DEFAULTS), o || {}); }
    catch (e) { return assign({}, DEFAULTS); }
  }
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(D.state)); } catch (e) { /* ignore */ } }

  function shaperCurve(drive, asym) {
    var n = 2048, c = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      c[i] = Math.tanh(x * drive + (asym || 0)) - Math.tanh(asym || 0);
    }
    return c;
  }
  function distCurve(amount) {
    var n = 1024, c = new Float32Array(n), k = amount * 40;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      c[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return c;
  }

  /* Two crossfaded delay lines with a ramping delay time = real pitch shift, tempo kept. */
  function buildPitchUnit(ctx, ratio) {
    var WINDOW = 0.1, span = Math.abs(ratio - 1) * WINDOW, up = ratio > 1;
    var unit = { nodes: [], sources: [] };
    unit.input = ctx.createGain(); unit.output = ctx.createGain();
    var len = Math.max(2, Math.round(WINDOW * ctx.sampleRate));
    var rampBuf = ctx.createBuffer(1, len, ctx.sampleRate), fadeBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var ramp = rampBuf.getChannelData(0), fade = fadeBuf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      var t = i / len;
      ramp[i] = up ? span * (1 - t) : span * t;
      fade[i] = Math.sin(Math.PI * t);
    }
    for (var lane = 0; lane < 2; lane++) {
      var delay = ctx.createDelay(1.0); delay.delayTime.value = 0;
      var gain = ctx.createGain(); gain.gain.value = 0;
      var mod = ctx.createBufferSource(); mod.buffer = rampBuf; mod.loop = true; mod.connect(delay.delayTime);
      var win = ctx.createBufferSource(); win.buffer = fadeBuf; win.loop = true; win.connect(gain.gain);
      unit.input.connect(delay); delay.connect(gain); gain.connect(unit.output);
      var at = ctx.currentTime + 0.02 + (lane === 1 ? WINDOW / 2 : 0);
      mod.start(at); win.start(at);
      unit.sources.push(mod, win); unit.nodes.push(delay, gain);
    }
    return unit;
  }
  function killPitchUnit(u) {
    if (!u) return;
    u.sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    u.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
    try { u.input.disconnect(); } catch (e) {} try { u.output.disconnect(); } catch (e) {}
  }

  /* A stage = in/out gains + "inner" subgraph. bypass wires in→out directly. */
  function stage(ctx) {
    var s = { in: ctx.createGain(), out: ctx.createGain(), on: false, wired: null };
    s.in.channelCount = 2; s.in.channelCountMode = "explicit"; s.in.channelInterpretation = "speakers";
    s.bypass = function () { if (s.wired === "bypass") return; try { s.in.disconnect(); } catch (e) {} s.in.connect(s.out); s.wired = "bypass"; if (s.onBypass) s.onBypass(); };
    s.engage = function (inner) { if (s.wired === "inner") return; try { s.in.disconnect(); } catch (e) {} s.in.connect(inner); s.wired = "inner"; if (s.onEngage) s.onEngage(); };
    s.bypass();
    return s;
  }

  function buildVocal(ctx) {
    var st = stage(ctx), n = {};
    n.dry = ctx.createGain(); n.wet = ctx.createGain();
    n.low = ctx.createBiquadFilter(); n.low.type = "lowpass"; n.low.frequency.value = 150; n.low.Q.value = 0.5;
    n.hi = ctx.createBiquadFilter(); n.hi.type = "highpass"; n.hi.frequency.value = 7000; n.hi.Q.value = 0.5;
    n.hp = ctx.createBiquadFilter(); n.hp.type = "highpass"; n.hp.frequency.value = 150; n.hp.Q.value = 0.5;
    n.lp = ctx.createBiquadFilter(); n.lp.type = "lowpass"; n.lp.frequency.value = 7000; n.lp.Q.value = 0.5;
    n.lowG = ctx.createGain(); n.hiG = ctx.createGain();
    n.split = ctx.createChannelSplitter(2); n.gL = ctx.createGain(); n.gR = ctx.createGain();
    n.mid = ctx.createGain(); n.merge = ctx.createChannelMerger(2); n.sum = ctx.createGain();
    n.inner = ctx.createGain();
    n.inner.connect(n.dry); n.dry.connect(st.out);
    n.inner.connect(n.low); n.low.connect(n.lowG); n.lowG.connect(n.sum);
    n.inner.connect(n.hi); n.hi.connect(n.hiG); n.hiG.connect(n.sum);
    n.inner.connect(n.hp); n.hp.connect(n.lp); n.lp.connect(n.split);
    n.split.connect(n.gL, 0); n.split.connect(n.gR, 1);
    n.gL.connect(n.mid); n.gR.connect(n.mid);
    n.mid.connect(n.merge, 0, 0); n.mid.connect(n.merge, 0, 1);
    n.merge.connect(n.sum);
    n.sum.connect(n.wet); n.wet.connect(st.out);
    st.n = n;
    st.apply = function (S) {
      var a = clamp(S.vocal, 0, 100) / 100, now = ctx.currentTime;
      if (a <= 0) { st.bypass(); return; }
      st.engage(n.inner);
      var only = S.vocalMode === "only";
      n.dry.gain.setTargetAtTime(1 - a, now, 0.03);
      n.wet.gain.setTargetAtTime(a, now, 0.03);
      n.lowG.gain.setTargetAtTime(only ? 0 : 1, now, 0.03);
      n.hiG.gain.setTargetAtTime(only ? 0 : 1, now, 0.03);
      n.gL.gain.setTargetAtTime(only ? 0.5 : 1, now, 0.03);
      n.gR.gain.setTargetAtTime(only ? 0.5 : -1, now, 0.03);
      n.mid.gain.setTargetAtTime(only ? 1.4 : 1.15, now, 0.03);
    };
    return st;
  }

  function buildVoice(ctx) {
    var st = stage(ctx), n = {}, pitchUnit = null, curRatio = 1;
    n.inner = ctx.createGain();
    n.pIn = ctx.createGain(); n.pOut = ctx.createGain();
    n.ringDry = ctx.createGain(); n.ringWet = ctx.createGain(); n.rm = ctx.createGain(); n.rm.gain.value = 0;
    n.osc = ctx.createOscillator(); n.osc.type = "sine"; n.osc.frequency.value = 50; n.osc.connect(n.rm.gain);
    n.vc = ctx.createGain();
    n.vib = ctx.createDelay(0.1); n.vib.delayTime.value = 0.012;
    n.lfo = ctx.createOscillator(); n.lfo.frequency.value = 6; n.lfoG = ctx.createGain(); n.lfoG.gain.value = 0;
    n.lfo.connect(n.lfoG); n.lfoG.connect(n.vib.delayTime);
    n.hp = ctx.createBiquadFilter(); n.hp.type = "highpass"; n.hp.frequency.value = 20;
    n.lp = ctx.createBiquadFilter(); n.lp.type = "lowpass"; n.lp.frequency.value = 20000;
    n.shaper = ctx.createWaveShaper(); n.shaper.oversample = "none";
    n.inner.connect(n.pIn); n.pIn.connect(n.pOut);
    n.pOut.connect(n.ringDry); n.ringDry.connect(n.vc);
    n.pOut.connect(n.rm); n.rm.connect(n.ringWet); n.ringWet.connect(n.vc);
    n.vc.connect(n.vib); n.vib.connect(n.hp); n.hp.connect(n.lp); n.lp.connect(n.shaper); n.shaper.connect(st.out);
    var started = false;
    st.onEngage = function () { if (!started) { started = true; try { n.osc.start(); n.lfo.start(); } catch (e) {} } };
    st.apply = function (S) {
      var v = VOICES[S.voice] || VOICES.off, now = ctx.currentTime;
      var semis = clamp(v.pitch + (S.pitch || 0), -24, 24);
      var neutral = S.voice === "off" && !S.pitch;
      if (neutral) {
        st.bypass();
        try { n.pIn.disconnect(); } catch (e) {} killPitchUnit(pitchUnit); pitchUnit = null; curRatio = 1; n.pIn.connect(n.pOut);
        return;
      }
      st.engage(n.inner);
      var ratio = Math.pow(2, semis / 12);
      if (Math.abs(ratio - curRatio) > 1e-4) {
        try { n.pIn.disconnect(); } catch (e) {}
        killPitchUnit(pitchUnit); pitchUnit = null;
        if (semis === 0) { n.pIn.connect(n.pOut); }
        else { pitchUnit = buildPitchUnit(ctx, ratio); n.pIn.connect(pitchUnit.input); pitchUnit.output.connect(n.pOut); }
        curRatio = ratio;
      }
      n.ringDry.gain.setTargetAtTime(1 - v.mix, now, 0.03);
      n.ringWet.gain.setTargetAtTime(v.mix, now, 0.03);
      if (v.ring) n.osc.frequency.setTargetAtTime(v.ring, now, 0.03);
      n.lfo.frequency.setTargetAtTime(v.vibHz || 6, now, 0.03);
      n.lfoG.gain.setTargetAtTime(v.vib * 0.006, now, 0.03);
      n.hp.frequency.setTargetAtTime(v.hp, now, 0.03);
      n.lp.frequency.setTargetAtTime(v.lp, now, 0.03);
      n.shaper.curve = v.dist > 0 ? distCurve(v.dist) : null;
    };
    st.park = function () { killPitchUnit(pitchUnit); pitchUnit = null; curRatio = 1; };
    return st;
  }

  function buildBass(ctx) {
    var st = stage(ctx), n = {};
    n.inner = ctx.createGain(); n.mix = ctx.createGain();
    n.shelf = ctx.createBiquadFilter(); n.shelf.type = "lowshelf"; n.shelf.frequency.value = 95;
    n.punch = ctx.createBiquadFilter(); n.punch.type = "peaking"; n.punch.frequency.value = 55; n.punch.Q.value = 1.1;
    // harmonic layer: makes bass audible (and felt) on laptop / small speakers
    n.hLp = ctx.createBiquadFilter(); n.hLp.type = "lowpass"; n.hLp.frequency.value = 120;
    n.hSh = ctx.createWaveShaper(); n.hSh.curve = shaperCurve(4, 0.25); n.hSh.oversample = "none";
    n.hHp = ctx.createBiquadFilter(); n.hHp.type = "highpass"; n.hHp.frequency.value = 90;
    n.hG = ctx.createGain(); n.hG.gain.value = 0;
    // earthquake sub layer: squashed + saturated 30–80 Hz
    n.sLp = ctx.createBiquadFilter(); n.sLp.type = "lowpass"; n.sLp.frequency.value = 80; n.sLp.Q.value = 0.8;
    n.sHp = ctx.createBiquadFilter(); n.sHp.type = "highpass"; n.sHp.frequency.value = 28;
    n.sComp = ctx.createDynamicsCompressor(); n.sComp.threshold.value = -34; n.sComp.knee.value = 6; n.sComp.ratio.value = 14; n.sComp.attack.value = 0.004; n.sComp.release.value = 0.12;
    n.sSh = ctx.createWaveShaper(); n.sSh.curve = shaperCurve(2.2, 0); n.sSh.oversample = "none";
    n.sG = ctx.createGain(); n.sG.gain.value = 0;
    n.inner.connect(n.shelf); n.shelf.connect(n.punch); n.punch.connect(n.mix);
    n.inner.connect(n.hLp); n.hLp.connect(n.hSh); n.hSh.connect(n.hHp); n.hHp.connect(n.hG); n.hG.connect(n.mix);
    n.inner.connect(n.sHp); n.sHp.connect(n.sLp); n.sLp.connect(n.sComp); n.sComp.connect(n.sSh); n.sSh.connect(n.sG); n.sG.connect(n.mix);
    n.mix.connect(st.out);
    st.apply = function (S) {
      var b = clamp(S.bass, 0, 100) / 100, s = clamp(S.sub, 0, 100) / 100, now = ctx.currentTime;
      if (b <= 0 && s <= 0) { st.bypass(); return; }
      st.engage(n.inner);
      n.shelf.gain.setTargetAtTime(b * 18, now, 0.03);
      n.punch.gain.setTargetAtTime(b * 9, now, 0.03);
      n.hG.gain.setTargetAtTime(b * 0.9, now, 0.03);
      n.sG.gain.setTargetAtTime(s * 3.2, now, 0.03);
      // keep the overall level sane: pull the dry signal down a little as the layers add up
      n.mix.gain.setTargetAtTime(1 / (1 + 0.35 * b + 0.25 * s), now, 0.05);
    };
    return st;
  }

  function buildHD(ctx) {
    var st = stage(ctx), n = {};
    n.inner = ctx.createGain();
    n.air = ctx.createBiquadFilter(); n.air.type = "highshelf"; n.air.frequency.value = 11000;
    n.hp = ctx.createBiquadFilter(); n.hp.type = "highpass"; n.hp.frequency.value = 4500;
    n.sh = ctx.createWaveShaper(); n.sh.curve = shaperCurve(3, 0); n.sh.oversample = "2x";
    n.hp2 = ctx.createBiquadFilter(); n.hp2.type = "highpass"; n.hp2.frequency.value = 5200;
    n.ex = ctx.createGain(); n.ex.gain.value = 0;
    n.inner.connect(n.air); n.air.connect(st.out);
    n.inner.connect(n.hp); n.hp.connect(n.sh); n.sh.connect(n.hp2); n.hp2.connect(n.ex); n.ex.connect(st.out);
    st.apply = function (S) {
      var h = clamp(S.hd, 0, 100) / 100, now = ctx.currentTime;
      if (h <= 0) { st.bypass(); return; }
      st.engage(n.inner);
      n.air.gain.setTargetAtTime(h * 4, now, 0.05);
      n.ex.gain.setTargetAtTime(h * 0.32, now, 0.05);
    };
    return st;
  }

  /* Sound Tone stage. Wiring:
   *   in -> inner -+-> delay -> kick cut -> snare cut -> hat cut -> dry gain ---------------+-> out
   *                +-> 3 band detectors (kick / snare / hat) -> onset logic -> instrument hits -> beat bus -+
   *                                                                          drone (harmonium / pad) -------+ */
  function buildTone(ctx) {
    var st = stage(ctx), n = {};
    var noiseBuf = null, timer = 0, droneNodes = null, droneKey = "", curTone = "off";
    n.inner = ctx.createGain();
    n.delay = ctx.createDelay(0.2); n.delay.delayTime.value = TONE_LOOKAHEAD;
    n.kick = ctx.createBiquadFilter(); n.kick.type = "lowshelf"; n.kick.frequency.value = 120; n.kick.gain.value = 0;
    n.snare = ctx.createBiquadFilter(); n.snare.type = "peaking"; n.snare.frequency.value = 4000; n.snare.Q.value = 0.7; n.snare.gain.value = 0;
    n.hat = ctx.createBiquadFilter(); n.hat.type = "highshelf"; n.hat.frequency.value = 7500; n.hat.gain.value = 0;
    n.dry = ctx.createGain();
    n.inner.connect(n.delay); n.delay.connect(n.kick); n.kick.connect(n.snare); n.snare.connect(n.hat); n.hat.connect(n.dry); n.dry.connect(st.out);

    n.beat = ctx.createGain(); n.beat.gain.value = 0;
    n.comp = ctx.createDynamicsCompressor(); n.comp.threshold.value = -16; n.comp.knee.value = 10; n.comp.ratio.value = 6; n.comp.attack.value = 0.003; n.comp.release.value = 0.12;
    n.beat.connect(n.comp); n.comp.connect(st.out);
    n.droneG = ctx.createGain(); n.droneG.gain.value = 0; n.droneG.connect(st.out);

    // detectors: one band each, read as RMS every few milliseconds
    function band(type, f, q, min, k, gap) {
      var flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = f; flt.Q.value = q;
      var an = ctx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0;
      n.inner.connect(flt); flt.connect(an);
      return { an: an, buf: new Float32Array(an.fftSize), avg: 0, prev: 0, last: -1, min: min, k: k, gap: gap };
    }
    var bands = { low: band("lowpass", 150, 0.7, 0.02, 1.7, 0.11), mid: band("bandpass", 2800, 1.1, 0.012, 2.1, 0.08), high: band("highpass", 7500, 0.7, 0.004, 2.3, 0.06) };

    function noise() {
      if (noiseBuf) return noiseBuf;
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return noiseBuf;
    }
    function env(g, t0, peak, dec) {
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.01, dec));
    }
    function hit(h, t0, vel) {
      var peak = h.g * vel;
      var o = ctx.createOscillator(), og = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(h.f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, h.f1 || h.f0), t0 + Math.max(0.02, h.dec * 0.55));
      env(og, t0, peak, h.dec); o.connect(og); og.connect(n.beat); o.start(t0); o.stop(t0 + h.dec + 0.05);
      (h.parts || []).forEach(function (pt) {
        var po = ctx.createOscillator(), pg = ctx.createGain();
        po.type = "sine"; po.frequency.setValueAtTime((h.f1 || h.f0) * pt[0], t0);
        env(pg, t0, peak * pt[1], pt[2]); po.connect(pg); pg.connect(n.beat); po.start(t0); po.stop(t0 + pt[2] + 0.05);
      });
      if (h.noise) {
        var ns = ctx.createBufferSource(), nf = ctx.createBiquadFilter(), ng = ctx.createGain();
        ns.buffer = noise(); nf.type = h.noise.type || "bandpass"; nf.frequency.value = h.noise.f; nf.Q.value = h.noise.q || 1;
        env(ng, t0, h.noise.g * vel, h.noise.dec); ns.connect(nf); nf.connect(ng); ng.connect(n.beat);
        ns.start(t0, Math.random() * 0.8); ns.stop(t0 + h.noise.dec + 0.05);
      }
    }

    function killDrone() {
      if (!droneNodes) return;
      var d = droneNodes; droneNodes = null; droneKey = "";
      try { d.out.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } catch (e) { /* ignore */ }
      setTimeout(function () {
        d.src.forEach(function (s) { try { s.stop(); } catch (e) {} });
        d.all.forEach(function (x) { try { x.disconnect(); } catch (e) {} });
      }, 400);
    }
    function makeDrone(spec, keyHz) {
      var d = { src: [], all: [] }, re = new Float32Array(spec.h.length + 1), im = new Float32Array(spec.h.length + 1);
      spec.h.forEach(function (a, i) { im[i + 1] = a; });
      var wave = ctx.createPeriodicWave(re, im);
      d.out = ctx.createGain(); d.out.gain.value = 1;
      var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = spec.lp; lp.Q.value = 0.5;
      var trem = ctx.createGain(); trem.gain.value = 1 - (spec.depth || 0);
      d.all.push(d.out, lp, trem);
      if (spec.trem && spec.depth) {
        var lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = spec.trem; lg.gain.value = spec.depth; lfo.connect(lg); lg.connect(trem.gain); lfo.start(); d.src.push(lfo); d.all.push(lfo, lg);
      }
      spec.chord.forEach(function (r) {
        [-5, 5].forEach(function (cents) {
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.setPeriodicWave(wave); o.frequency.value = keyHz * r; o.detune.value = cents; g.gain.value = 0.22 / spec.chord.length;
          o.connect(g); g.connect(lp); o.start(); d.src.push(o); d.all.push(o, g);
        });
      });
      if (spec.breath) {
        var bs = ctx.createBufferSource(), bf = ctx.createBiquadFilter(), bg = ctx.createGain();
        bs.buffer = noise(); bs.loop = true; bf.type = "bandpass"; bf.frequency.value = keyHz * 4; bf.Q.value = 3; bg.gain.value = spec.breath;
        bs.connect(bf); bf.connect(bg); bg.connect(lp); bs.start(); d.src.push(bs); d.all.push(bs, bf, bg);
      }
      lp.connect(trem); trem.connect(d.out); d.out.connect(n.droneG);
      return d;
    }

    function tick() {
      if (ctx.state !== "running" || st.wired !== "inner") return;
      var tn = TONES[curTone]; if (!tn || curTone === "off") return;
      var now = ctx.currentTime;
      ["low", "mid", "high"].forEach(function (name) {
        var b = bands[name]; b.an.getFloatTimeDomainData(b.buf);
        var s = 0, i, v; for (i = 0; i < b.buf.length; i++) { v = b.buf[i]; s += v * v; }
        var rms = Math.sqrt(s / b.buf.length);
        var thr = Math.max(b.min, b.avg * b.k);
        var fire = rms > thr && rms > b.prev * 1.12 && now - b.last > b.gap;
        b.avg = b.avg * 0.985 + rms * 0.015; b.prev = rms;
        if (!fire) return;
        b.last = now;
        var vel = Math.max(0.45, Math.min(1, rms / (thr * 1.8)));
        if (name === "high") vel *= 0.7;
        hit(tn[name], now + Math.max(0.005, TONE_LOOKAHEAD - 0.014), vel);
        D.toneHits[name]++;
        D.toneListeners.forEach(function (fn) { try { fn(name, vel); } catch (e) { /* ignore */ } });
      });
    }
    function startLoop() { if (!timer) timer = setInterval(tick, 8); }
    function stopLoop() { if (timer) { clearInterval(timer); timer = 0; } }

    st.apply = function (S) {
      var tn = TONES[S.tone], now = ctx.currentTime;
      if (!tn || S.tone === "off") { stopLoop(); killDrone(); curTone = "off"; st.bypass(); return; }
      st.engage(n.inner);
      curTone = S.tone; startLoop();
      var strip = clamp(S.toneStrip, 0, 100) / 100;
      n.beat.gain.setTargetAtTime(clamp(S.toneBeat, 0, 100) / 100 * 1.5, now, 0.03);
      n.kick.gain.setTargetAtTime(-22 * strip, now, 0.05);
      n.snare.gain.setTargetAtTime(-6 * strip, now, 0.05);
      n.hat.gain.setTargetAtTime(-14 * strip, now, 0.05);
      var key = S.tone + ":" + S.toneKey;
      if (key !== droneKey) {
        killDrone();
        if (tn.drone) { droneNodes = makeDrone(tn.drone, 130.81 * Math.pow(2, clamp(S.toneKey, 0, 11) / 12)); droneKey = key; }
      }
      n.droneG.gain.setTargetAtTime(clamp(S.toneDrone, 0, 100) / 100 * 0.9, now, 0.08);
    };
    st.park = function () { stopLoop(); killDrone(); };
    st.n = n; st.bands = bands;
    return st;
  }

  var chains = [];
  var D = {
    VOICES: VOICES,
    TONES: TONES,
    TONE_NOTES: TONE_NOTES,
    toneHits: { low: 0, mid: 0, high: 0 },   // how many hits were fired (diagnostics and the on-screen meter)
    toneListeners: [],
    DEFAULTS: DEFAULTS,
    state: load(),
    onChange: [],
    supported: !!(global.AudioContext || global.webkitAudioContext),

    /* Context options: the engine runs at 96 kHz only when the person turned Hi-Res on (needs a restart). */
    hiresEnabled: function () { try { return localStorage.getItem(LS_HIRES) === "1"; } catch (e) { return false; } },
    setHires: function (on) { try { localStorage.setItem(LS_HIRES, on ? "1" : "0"); } catch (e) { /* ignore */ } },
    contextOptions: function () { return D.hiresEnabled() ? { sampleRate: 96000, latencyHint: "playback" } : undefined; },

    create: function (ctx) {
      var c = { ctx: ctx, stages: [buildVocal(ctx), buildVoice(ctx), buildTone(ctx), buildBass(ctx), buildHD(ctx)] };
      c.input = c.stages[0].in; c.output = c.stages[4].out;
      c.stages[0].out.connect(c.stages[1].in);
      c.stages[1].out.connect(c.stages[2].in);
      c.stages[2].out.connect(c.stages[3].in);
      c.stages[3].out.connect(c.stages[4].in);
      c.apply = function () { c.stages.forEach(function (s) { s.apply(D.state); }); };
      c.isActive = function () { return c.stages.some(function (s) { return s.wired === "inner"; }); };
      c.apply();
      chains.push(c);
      return c;
    },

    isActive: function () { return chains.some(function (c) { return c.isActive(); }); },
    /* true when the saved settings ask for any processing (even if no audio graph exists yet) */
    wanted: function () { var t = D.state; return t.vocal > 0 || t.voice !== "off" || !!t.pitch || t.bass > 0 || t.sub > 0 || t.hd > 0 || (!!t.tone && t.tone !== "off"); },

    set: function (name, value) {
      if (!(name in DEFAULTS)) return false;
      D.state[name] = value;
      D.applyAll();
      save();
      return true;
    },
    setMany: function (obj) {
      Object.keys(obj).forEach(function (k) { if (k in DEFAULTS) D.state[k] = obj[k]; });
      D.applyAll(); save();
    },
    reset: function () { D.state = assign({}, DEFAULTS); D.applyAll(); save(); },
    applyAll: function () {
      chains.forEach(function (c) { try { c.apply(); } catch (e) { /* a chain whose context closed */ } });
      D.onChange.forEach(function (fn) { try { fn(D.state); } catch (e) { /* ignore */ } });
    },
    /* One-tap monster beat mode: huge low end + harmonics + clarity. */
    maxBeat: function (on) {
      if (on) D.setMany({ bass: 100, sub: 100, hd: 40 });
      else D.setMany({ bass: 0, sub: 0, hd: 0 });
    }
  };

  global.GhostDSP = D;
})(window);
