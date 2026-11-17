/* Ghost Media Player — Web Audio processing engine
 *
 * One shared AudioContext and one shared node graph. Every media element is
 * routed into the same graph through its own MediaElementAudioSourceNode
 * (a source node can only be created once per element, so they are cached).
 *
 *   element ─▶ input ─▶ [ FX chain (bypassed when disabled) ] ─▶ boost ─▶ limiter ─▶ out
 *
 * Everything here processes real audio. Nothing is decorative: if a node type
 * is missing in the current browser engine, the matching control is reported
 * as unavailable instead of being faked.
 */
(function (global) {
  "use strict";

  var DEFAULTS = {
    bass: 0,          // dB,  -12 .. +12  (low shelf)
    treble: 0,        // dB,  -12 .. +12  (high shelf)
    pitch: 0,         // semitones, -12 .. +12 (real pitch shift, tempo kept)
    echo: 0,          // wet %, 0 .. 100
    reverb: 0,        // wet %, 0 .. 100
    distortion: 0,    // drive %, 0 .. 100
    lowpass: 20000,   // Hz (20000 = off)
    highpass: 20,     // Hz (20 = off)
    balance: 0,       // -1 (L) .. +1 (R)
    night: false      // night mode: heavy dynamic-range compression
  };

  var PRESETS = {
    normal: { label: "Normal", params: {} },
    deep: { label: "Deep Voice", params: { pitch: -5, bass: 5, treble: -3, lowpass: 9000 } },
    high: { label: "High Voice", params: { pitch: 5, treble: 3, highpass: 140 } },
    bassboost: { label: "Bass Boost", params: { bass: 10, treble: 1 } },
    radio: { label: "Radio", params: { highpass: 600, lowpass: 3400, distortion: 14, bass: -3 } },
    echo: { label: "Echo", params: { echo: 45 } },
    dj: { label: "DJ", params: { bass: 8, treble: 6, reverb: 20, distortion: 8 } },
    night: { label: "Night Mode", params: { night: true, treble: 3, bass: -2 } }
  };

  var Ctor = global.AudioContext || global.webkitAudioContext;

  var fx = {
    PRESETS: PRESETS,
    DEFAULTS: DEFAULTS,
    params: assign({}, DEFAULTS),
    enabled: false,
    boost: 1,          // 1 .. 4  (100% .. 400%)
    preset: "normal",
    ctx: null,
    attached: false,   // the *currently active* element is routed through the graph
    unavailable: {},   // { paramName: "reason" } for anything this engine can't do
    lastError: null
  };

  var sources = null;      // WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>
  var nodes = null;        // built lazily with the context
  var pitchUnit = null;    // built only while pitch !== 0
  var activeEl = null;

  function assign(t, s) { for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; return t; }

  fx.isSupported = function () { return !!Ctor; };

  /* The app has exactly one AudioContext. DJ Mode builds its own deck graph on this same
   * context (it never touches the player graph above) and registers keepAlive so that the
   * player stopping does not park the context while a deck is still playing. */
  fx.getContext = function () { return ensureContext(); };
  fx.keepAlive = null;     // optional function() -> true while another engine (DJ Mode) is playing

  /* ------------------------------------------------------------------ graph */

  function ensureContext() {
    if (fx.ctx) return fx.ctx;
    if (!Ctor) { fx.lastError = "The Web Audio API is not available in this browser engine."; return null; }
    try {
      var opt = window.GhostDSP && window.GhostDSP.contextOptions ? window.GhostDSP.contextOptions() : undefined;
      try { fx.ctx = opt ? new Ctor(opt) : new Ctor(); }
      catch (e0) { fx.ctx = new Ctor(); }
    } catch (e) {
      fx.lastError = "Audio processing could not be started: " + (e && e.message ? e.message : e);
      return null;
    }
    sources = new WeakMap();
    buildGraph();
    return fx.ctx;
  }

  function buildGraph() {
    var ctx = fx.ctx;
    var n = {};

    n.input = ctx.createGain();
    n.fxIn = ctx.createGain();
    n.fxOut = ctx.createGain();

    n.bass = ctx.createBiquadFilter();
    n.bass.type = "lowshelf"; n.bass.frequency.value = 200; n.bass.gain.value = 0;

    n.treble = ctx.createBiquadFilter();
    n.treble.type = "highshelf"; n.treble.frequency.value = 3200; n.treble.gain.value = 0;

    n.highpass = ctx.createBiquadFilter();
    n.highpass.type = "highpass"; n.highpass.frequency.value = DEFAULTS.highpass;

    n.lowpass = ctx.createBiquadFilter();
    n.lowpass.type = "lowpass"; n.lowpass.frequency.value = DEFAULTS.lowpass;

    n.shaper = ctx.createWaveShaper();
    n.shaper.curve = distortionCurve(0);
    n.shaper.oversample = "none";

    // Pitch stage: a plain pass-through gain pair. The pitch shifter is patched
    // in between them only while a non-zero pitch is selected (saves CPU).
    n.pitchIn = ctx.createGain();
    n.pitchOut = ctx.createGain();
    n.pitchIn.connect(n.pitchOut);

    // Echo (parallel wet path with feedback)
    n.echoDelay = ctx.createDelay(2.0);
    n.echoDelay.delayTime.value = 0.28;
    n.echoFeedback = ctx.createGain(); n.echoFeedback.gain.value = 0.34;
    n.echoWet = ctx.createGain(); n.echoWet.gain.value = 0;

    // Reverb (parallel wet path, impulse response generated locally — no files)
    n.reverbWet = ctx.createGain(); n.reverbWet.gain.value = 0;
    if (ctx.createConvolver) {
      n.convolver = ctx.createConvolver();
      n.convolver.buffer = makeImpulse(ctx, 1.8, 2.6);
    } else {
      fx.unavailable.reverb = "Convolution reverb is not supported by this browser engine.";
    }

    // Stereo balance
    if (ctx.createStereoPanner) {
      n.panner = ctx.createStereoPanner();
    } else {
      fx.unavailable.balance = "Stereo panning is not supported by this browser engine.";
    }

    n.boost = ctx.createGain(); n.boost.gain.value = 1;

    // Safety limiter — always in the path so boost/effects can't blow the output up.
    n.limiter = ctx.createDynamicsCompressor();
    setLimiter(n.limiter, false);

    // ---- wiring
    // FX chain
    var tail = n.fxIn;
    tail.connect(n.bass); tail = n.bass;
    tail.connect(n.treble); tail = n.treble;
    tail.connect(n.highpass); tail = n.highpass;
    tail.connect(n.lowpass); tail = n.lowpass;
    tail.connect(n.shaper); tail = n.shaper;
    tail.connect(n.pitchIn);

    // after pitch: dry + echo wet + reverb wet -> fxOut
    n.pitchOut.connect(n.fxOut);
    n.pitchOut.connect(n.echoDelay);
    n.echoDelay.connect(n.echoFeedback);
    n.echoFeedback.connect(n.echoDelay);
    n.echoDelay.connect(n.echoWet);
    n.echoWet.connect(n.fxOut);
    if (n.convolver) {
      n.pitchOut.connect(n.convolver);
      n.convolver.connect(n.reverbWet);
      n.reverbWet.connect(n.fxOut);
    }

    // Output stage
    var afterFx = n.panner ? n.panner : n.boost;
    n.fxOut.connect(afterFx);
    if (n.panner) n.panner.connect(n.boost);
    n.limiter.connect(ctx.destination);

    // Shared DSP rack (vocal remover / voice changer / bass monster / HD): boost -> dsp -> limiter|destination
    if (window.GhostDSP && window.GhostDSP.create) {
      try {
        n.dsp = window.GhostDSP.create(ctx);
        window.GhostDSP.onChange.push(function () { routeOutput(); });
      } catch (e1) { n.dsp = null; }
    }

    nodes = n;
    fx.nodes = n;   // exposed for diagnostics/tests; the UI never touches it
    routeBypass();
    routeOutput();
  }

  // input -> fxIn (effects on) or input -> panner/boost (effects off)
  function routeBypass() {
    if (!nodes) return;
    try { nodes.input.disconnect(); } catch (e) { /* ignore */ }
    if (fx.enabled) {
      nodes.input.connect(nodes.fxIn);
    } else {
      nodes.input.connect(nodes.panner ? nodes.panner : nodes.boost);
      if (nodes.panner) nodes.panner.pan.value = 0;
    }
  }

  /* With effects off and boost at 100% the graph must be bit-transparent, so
   * the limiter is only inserted when something can actually push the level up. */
  function routeOutput() {
    if (!nodes) return;
    try { nodes.boost.disconnect(); } catch (e) { /* ignore */ }
    var dsp = nodes.dsp, dspOn = !!(dsp && dsp.isActive());
    var needLimiter = fx.enabled || fx.boost > 1 || dspOn;
    if (dsp) {
      try { dsp.output.disconnect(); } catch (e) { /* ignore */ }
      nodes.boost.connect(dsp.input);
      dsp.output.connect(needLimiter ? nodes.limiter : fx.ctx.destination);
    } else {
      nodes.boost.connect(needLimiter ? nodes.limiter : fx.ctx.destination);
    }
  }

  function setLimiter(comp, night) {
    // Night mode = strong, musical dynamic-range compression (quiet parts lifted).
    // Otherwise a transparent brick-wall-ish safety limiter for boosted output.
    comp.threshold.value = night ? -32 : -3;
    comp.knee.value = night ? 24 : 0;
    comp.ratio.value = night ? 8 : 20;
    comp.attack.value = night ? 0.01 : 0.003;
    comp.release.value = night ? 0.3 : 0.25;
  }

  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * seconds));
    var buf = ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var data = buf.getChannelData(c);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function distortionCurve(amount) {
    var n = 1024;
    var curve = new Float32Array(n);
    var k = amount * 4; // 0 => linear (no colouring at all)
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /* --------------------------------------------------- real pitch shifting */
  /* Two crossfaded delay lines whose delay time ramps linearly: the classic
   * time-domain (Doppler) pitch shifter. Tempo is preserved; only the pitch
   * moves. Built from standard Web Audio nodes only — no library, no worklet. */
  function buildPitchUnit(ctx, ratio) {
    var WINDOW = 0.100;                    // s, crossfade window
    var span = Math.abs(ratio - 1) * WINDOW;
    var up = ratio > 1;

    var unit = { nodes: [], sources: [] };
    unit.input = ctx.createGain();
    unit.output = ctx.createGain();

    var rampBuf = ctx.createBuffer(1, Math.max(2, Math.round(WINDOW * ctx.sampleRate)), ctx.sampleRate);
    var ramp = rampBuf.getChannelData(0);
    var fadeBuf = ctx.createBuffer(1, rampBuf.length, ctx.sampleRate);
    var fade = fadeBuf.getChannelData(0);
    for (var i = 0; i < ramp.length; i++) {
      var t = i / ramp.length;
      // Delay ramps down for pitch-up, up for pitch-down.
      ramp[i] = up ? (span * (1 - t)) : (span * t);
      // Equal-power-ish crossfade window (0 at the ramp discontinuity).
      fade[i] = Math.sin(Math.PI * t);
    }

    for (var lane = 0; lane < 2; lane++) {
      var delay = ctx.createDelay(1.0);
      delay.delayTime.value = 0;
      var gain = ctx.createGain();
      gain.gain.value = 0;

      var mod = ctx.createBufferSource();
      mod.buffer = rampBuf; mod.loop = true;
      mod.connect(delay.delayTime);

      var win = ctx.createBufferSource();
      win.buffer = fadeBuf; win.loop = true;
      win.connect(gain.gain);

      unit.input.connect(delay);
      delay.connect(gain);
      gain.connect(unit.output);

      var at = ctx.currentTime + 0.02 + (lane === 1 ? WINDOW / 2 : 0);
      mod.start(at);
      win.start(at);
      unit.sources.push(mod, win);
      unit.nodes.push(delay, gain);
    }
    return unit;
  }

  function teardownPitch() {
    if (!pitchUnit) return;
    pitchUnit.sources.forEach(function (s) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} });
    pitchUnit.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
    try { pitchUnit.input.disconnect(); } catch (e) {}
    try { pitchUnit.output.disconnect(); } catch (e) {}
    pitchUnit = null;
  }

  function applyPitch() {
    if (!nodes) return;
    var semis = fx.params.pitch || 0;
    try { nodes.pitchIn.disconnect(); } catch (e) {}
    teardownPitch();
    if (!semis || !fx.enabled) {
      nodes.pitchIn.connect(nodes.pitchOut);
      return;
    }
    var ratio = Math.pow(2, semis / 12);
    pitchUnit = buildPitchUnit(fx.ctx, ratio);
    nodes.pitchIn.connect(pitchUnit.input);
    pitchUnit.output.connect(nodes.pitchOut);
  }

  /* ------------------------------------------------------------ attachment */

  /* Route a media element through the graph. Returns true on success.
   * Cross-origin media without CORS headers would be silenced by the Web Audio
   * API, so the caller must only attach sources it knows are CORS-clean
   * (local files/blobs, or remote media that loaded with crossOrigin set). */
  fx.attach = function (el) {
    if (!el) return false;
    var ctx = ensureContext();
    if (!ctx) return false;
    try {
      var src = sources.get(el);
      if (!src) {
        src = ctx.createMediaElementSource(el);
        sources.set(el, src);
      }
      try { src.disconnect(); } catch (e) { /* ignore */ }
      src.connect(nodes.input);
      activeEl = el;
      fx.attached = true;
      fx.resume();
      return true;
    } catch (e) {
      fx.lastError = "This media source can't be routed through the audio engine: " +
        (e && e.message ? e.message : e);
      fx.attached = false;
      return false;
    }
  };

  fx.resume = function () {
    if (!fx.ctx) return;
    if (fx.ctx.state === "suspended") { try { fx.ctx.resume(); } catch (e) {} }
    // The pitch unit is torn down while idle to save CPU; rebuild it on resume.
    if (fx.enabled && fx.params.pitch && !pitchUnit) applyPitch();
  };
  /* Called when playback stops/unloads: park the context so no node keeps
   * processing (and no timers keep the CPU awake) while nothing is playing. */
  fx.idle = function () {
    teardownPitch();
    if (nodes) nodes.pitchIn.connect(nodes.pitchOut);
    if (fx.keepAlive && fx.keepAlive()) return;
    if (fx.ctx && fx.ctx.state === "running") { try { fx.ctx.suspend(); } catch (e) {} }
  };

  /* --------------------------------------------------------------- setters */

  fx.setEnabled = function (on) {
    fx.enabled = !!on;
    if (!fx.ctx) { if (!on) return false; if (!ensureContext()) return false; }
    routeBypass();
    routeOutput();
    applyAll();
    return true;
  };

  fx.setBoost = function (multiplier) {
    fx.boost = Math.max(1, Math.min(4, multiplier || 1));
    if (!fx.ctx) { if (fx.boost === 1) return true; if (!ensureContext()) return false; }
    nodes.boost.gain.setTargetAtTime(fx.boost, fx.ctx.currentTime, 0.02);
    routeOutput();
    return true;
  };

  fx.set = function (name, value) {
    if (!(name in DEFAULTS)) return false;
    fx.params[name] = value;
    fx.preset = "custom";
    if (!fx.ctx) return true;
    applyParam(name);
    return true;
  };

  fx.applyPreset = function (key) {
    var p = PRESETS[key];
    if (!p) return false;
    fx.params = assign(assign({}, DEFAULTS), p.params);
    fx.preset = key;
    if (fx.ctx) applyAll();
    return true;
  };

  fx.reset = function () {
    fx.params = assign({}, DEFAULTS);
    fx.preset = "normal";
    if (fx.ctx) applyAll();
  };

  function applyParam(name) {
    if (!nodes) return;
    var ctx = fx.ctx, now = ctx.currentTime, v = fx.params[name];
    switch (name) {
      case "bass": nodes.bass.gain.setTargetAtTime(v, now, 0.02); break;
      case "treble": nodes.treble.gain.setTargetAtTime(v, now, 0.02); break;
      case "lowpass": nodes.lowpass.frequency.setTargetAtTime(clampHz(v), now, 0.02); break;
      case "highpass": nodes.highpass.frequency.setTargetAtTime(clampHz(v), now, 0.02); break;
      case "distortion": nodes.shaper.curve = distortionCurve(Math.max(0, Math.min(100, v)) / 100); break;
      case "echo": nodes.echoWet.gain.setTargetAtTime(Math.max(0, Math.min(100, v)) / 100, now, 0.03); break;
      case "reverb":
        if (nodes.convolver) nodes.reverbWet.gain.setTargetAtTime(Math.max(0, Math.min(100, v)) / 100, now, 0.03);
        break;
      case "balance":
        if (nodes.panner) nodes.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, v)), now, 0.02);
        break;
      case "night": setLimiter(nodes.limiter, !!v && fx.enabled); break;
      case "pitch": applyPitch(); break;
    }
  }
  function clampHz(v) { return Math.max(20, Math.min(20000, v)); }

  function applyAll() {
    Object.keys(DEFAULTS).forEach(applyParam);
    nodes.boost.gain.value = fx.boost;
    if (!fx.enabled) {
      // Neutralise the chain so a later re-enable is instant and, while
      // bypassed, nothing in the chain colours or costs anything.
      setLimiter(nodes.limiter, false);
      teardownPitch();
      try { nodes.pitchIn.disconnect(); } catch (e) {}
      nodes.pitchIn.connect(nodes.pitchOut);
    }
  }

  fx.getState = function () {
    return {
      supported: fx.isSupported(),
      enabled: fx.enabled,
      attached: fx.attached,
      boost: fx.boost,
      preset: fx.preset,
      params: assign({}, fx.params),
      unavailable: fx.unavailable,
      contextState: fx.ctx ? fx.ctx.state : "none",
      lastError: fx.lastError
    };
  };

  global.GhostAudioFX = fx;
})(window);
