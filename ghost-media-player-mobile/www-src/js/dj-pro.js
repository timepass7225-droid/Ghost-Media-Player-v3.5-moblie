/* Ghost Media Player — DJ Pro add-on
 *
 *  1. Scratch engine  : position-driven sampler. Drag the jog disc forward / backward and the
 *                       decoded track is read at exactly that speed and direction, like a real
 *                       turntable or CDJ. Backspin, vinyl brake, reverse and wheel scratch use it too.
 *  2. Beat pads       : drums and DJ sounds synthesised with Web Audio (no sample files).
 *  3. Step sequencer  : dhol / bhangra / EDM / trap patterns that you can edit.
 *  4. Pro rack UI     : voice changer, vocal remover, bass monster, loudness, HD sound.
 */
(function (global) {
  "use strict";
  if (global.GhostDJPro) return;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  /* ======================================================================= scratch */
  var SEC_PER_REV = 1.8;                  // 33 1/3 rpm
  var Scratch = {
    SEC_PER_REV: SEC_PER_REV,
    create: function (ctx) {
      var s = {
        ctx: ctx, buf: null, pos: 0, vel: 0, target: 0, gain: 0, gainTarget: 0,
        active: false, auto: false, lastMove: 0, node: null, out: null, dest: null, closeTimer: 0
      };
      s.out = ctx.createGain();
      s.setBuffer = function (b) { s.buf = b; };
      s.hasBuffer = function () { return !!s.buf; };

      function process(e) {
        var L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), n = L.length, i;
        var b = s.buf;
        if (!b) { for (i = 0; i < n; i++) { L[i] = 0; R[i] = 0; } return; }
        var bl = b.getChannelData(0), br = b.numberOfChannels > 1 ? b.getChannelData(1) : bl, len = bl.length - 2;
        var rate = b.sampleRate / ctx.sampleRate;
        var pos = s.pos, vel = s.vel, tg = s.target, g = s.gain, gt = s.gainTarget;
        if (!s.auto && performance.now() - s.lastMove > 55) tg = 0;     // finger held still = record held still
        for (i = 0; i < n; i++) {
          vel += (tg - vel) * 0.006;
          g += (gt - g) * 0.012;
          pos += vel * rate;
          if (pos < 0) { pos = 0; vel = 0; tg = 0; }
          else if (pos > len) { pos = len; vel = 0; tg = 0; }
          var k = pos | 0, f = pos - k;
          var av = vel < 0 ? -vel : vel, ag = av * 12 > 1 ? 1 : av * 12;     // a held record is silent (no DC click)
          L[i] = (bl[k] * (1 - f) + bl[k + 1] * f) * g * ag;
          R[i] = (br[k] * (1 - f) + br[k + 1] * f) * g * ag;
        }
        s.pos = pos; s.vel = vel; s.target = tg; s.gain = g;
      }

      s.begin = function (seconds, dest) {
        if (!s.buf) return false;
        clearTimeout(s.closeTimer);
        s.pos = clamp(seconds * s.buf.sampleRate, 0, s.buf.length - 3);
        s.vel = 0; s.target = 0; s.auto = false; s.gain = 0; s.gainTarget = 1; s.lastMove = performance.now();
        if (!s.node) {
          s.node = ctx.createScriptProcessor(512, 0, 2);
          s.node.onaudioprocess = process;
          s.node.connect(s.out);
        }
        s.dest = dest;
        try { s.out.disconnect(); } catch (e) { /* ignore */ }
        s.out.connect(dest);
        s.active = true;
        return true;
      };
      s.setTarget = function (v, auto) { s.target = v; s.auto = !!auto; s.lastMove = performance.now(); };
      s.seconds = function () { return s.buf ? s.pos / s.buf.sampleRate : 0; };
      s.end = function () {
        if (!s.active) return s.seconds();
        s.active = false; s.gainTarget = 0; s.auto = false;
        var sec = s.seconds();
        s.closeTimer = setTimeout(function () {
          if (s.active) return;
          try { s.out.disconnect(); } catch (e) { /* ignore */ }
          if (s.node) { try { s.node.disconnect(); } catch (e) { /* ignore */ } s.node.onaudioprocess = null; s.node = null; }
        }, 90);
        return sec;
      };
      return s;
    }
  };

  /* ========================================================================= pads */
  var PADS = [
    { k: "kick",    label: "808 KICK",  key: "Q" }, { k: "dhol",   label: "DHOL",      key: "W" },
    { k: "tilli",   label: "TILLI",     key: "E" }, { k: "snare",  label: "SNARE",     key: "R" },
    { k: "clap",    label: "CLAP",      key: "A" }, { k: "hat",    label: "HI-HAT",    key: "S" },
    { k: "ohat",    label: "OPEN HAT",  key: "D" }, { k: "tom",    label: "TOM",       key: "F" },
    { k: "horn",    label: "AIR HORN",  key: "Z" }, { k: "siren",  label: "SIREN",     key: "X" },
    { k: "laser",   label: "LASER",     key: "C" }, { k: "impact", label: "BASS DROP", key: "V" },
    { k: "riser",   label: "RISER",     key: "T" }, { k: "bass",   label: "SUB BOOM",  key: "G" },
    { k: "stab",    label: "SYNTH STAB",key: "B" }, { k: "rev",    label: "REWIND",    key: "Y" }
  ];

  var Pads = {
    LIST: PADS, ctx: null, bus: null, noise: null, level: 1,
    init: function (ctx, out) {
      if (Pads.ctx === ctx) return;
      Pads.ctx = ctx;
      Pads.bus = ctx.createGain(); Pads.bus.gain.value = Pads.level;
      Pads.bus.connect(out);
      var len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      Pads.noise = b;
    },
    setLevel: function (v) { Pads.level = v; if (Pads.bus) Pads.bus.gain.setTargetAtTime(v, Pads.ctx.currentTime, 0.01); },

    trigger: function (name, vel, when) {
      var c = Pads.ctx; if (!c) return;
      var t = when || c.currentTime, v = clamp(vel == null ? 1 : vel, 0.05, 1.5);
      var f = Pads[name + "_"]; if (f) f(t, v);
    },

    // helpers
    _env: function (g, t, a, d, peak) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    },
    _osc: function (type, f0, f1, t, glide, dur, peak, atk) {
      var c = Pads.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
      Pads._env(g, t, atk || 0.003, dur, peak);
      o.connect(g); g.connect(Pads.bus); o.start(t); o.stop(t + (atk || 0.003) + dur + 0.05);
      return g;
    },
    _noise: function (t, dur, peak, type, freq, q, atk) {
      var c = Pads.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = Pads.noise; f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7;
      Pads._env(g, t, atk || 0.002, dur, peak);
      s.connect(f); f.connect(g); g.connect(Pads.bus);
      s.start(t, Math.random() * 1.5); s.stop(t + (atk || 0.002) + dur + 0.05);
    },

    kick_: function (t, v) {
      Pads._osc("sine", 170, 42, t, 0.11, 0.75, 1.15 * v);
      Pads._osc("sine", 52, 38, t, 0.3, 0.95, 0.9 * v);                 // sub tail
      Pads._noise(t, 0.012, 0.5 * v, "highpass", 2500, 0.7);            // click
    },
    dhol_: function (t, v) {
      Pads._osc("sine", 125, 56, t, 0.09, 0.6, 1.15 * v);
      Pads._osc("triangle", 190, 120, t, 0.12, 0.3, 0.35 * v);
      Pads._noise(t, 0.14, 0.45 * v, "bandpass", 190, 2.2);
    },
    tilli_: function (t, v) {
      Pads._noise(t, 0.09, 0.8 * v, "bandpass", 3300, 3.5);
      Pads._osc("triangle", 540, 470, t, 0.08, 0.12, 0.3 * v);
    },
    snare_: function (t, v) {
      Pads._noise(t, 0.2, 0.75 * v, "bandpass", 1900, 0.8);
      Pads._osc("triangle", 210, 165, t, 0.06, 0.12, 0.55 * v);
    },
    clap_: function (t, v) {
      [0, 0.011, 0.023].forEach(function (o) { Pads._noise(t + o, 0.025, 0.7 * v, "bandpass", 1300, 1.1); });
      Pads._noise(t + 0.03, 0.22, 0.45 * v, "bandpass", 1250, 0.9);
    },
    hat_: function (t, v) { Pads._noise(t, 0.05, 0.45 * v, "highpass", 7200, 0.7); },
    ohat_: function (t, v) { Pads._noise(t, 0.32, 0.4 * v, "highpass", 6800, 0.7); },
    tom_: function (t, v) { Pads._osc("sine", 210, 88, t, 0.15, 0.4, 0.95 * v); },
    horn_: function (t, v) {
      var c = Pads.ctx, g = c.createGain(), lp = c.createBiquadFilter(), vib = c.createOscillator(), vg = c.createGain();
      lp.type = "lowpass"; lp.frequency.value = 3600;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * v, t + 0.03);
      g.gain.setValueAtTime(0.5 * v, t + 0.85); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
      vib.frequency.value = 5.5; vg.gain.value = 5; vib.connect(vg);
      [440, 554.4, 659.3].forEach(function (f, i) {
        var o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = (i - 1) * 6;
        vg.connect(o.detune); o.connect(lp); o.start(t); o.stop(t + 1.2);
      });
      lp.connect(g); g.connect(Pads.bus); vib.start(t); vib.stop(t + 1.2);
    },
    siren_: function (t, v) {
      var c = Pads.ctx, o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain(), lp = c.createBiquadFilter();
      o.type = "sawtooth"; o.frequency.value = 1000; lfo.frequency.value = 1.3; lg.gain.value = 420; lfo.connect(lg); lg.connect(o.frequency);
      lp.type = "lowpass"; lp.frequency.value = 3200;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * v, t + 0.05);
      g.gain.setValueAtTime(0.32 * v, t + 1.7); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
      o.connect(lp); lp.connect(g); g.connect(Pads.bus); o.start(t); lfo.start(t); o.stop(t + 2.2); lfo.stop(t + 2.2);
    },
    laser_: function (t, v) { Pads._osc("sawtooth", 3000, 160, t, 0.32, 0.12, 0.4 * v); },
    impact_: function (t, v) {
      var c = Pads.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = Pads.noise; f.type = "lowpass"; f.frequency.setValueAtTime(9000, t); f.frequency.exponentialRampToValueAtTime(90, t + 1.3);
      Pads._env(g, t, 0.004, 1.4, 0.9 * v); s.connect(f); f.connect(g); g.connect(Pads.bus); s.start(t); s.stop(t + 1.5);
      Pads._osc("sine", 90, 30, t, 0.9, 2.0, 1.25 * v);
    },
    riser_: function (t, v) {
      var c = Pads.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = Pads.noise; s.loop = true; f.type = "bandpass"; f.Q.value = 2.5;
      f.frequency.setValueAtTime(260, t); f.frequency.exponentialRampToValueAtTime(9000, t + 3.6);
      g.gain.setValueAtTime(0.02, t); g.gain.exponentialRampToValueAtTime(0.85 * v, t + 3.5); g.gain.linearRampToValueAtTime(0, t + 3.7);
      s.connect(f); f.connect(g); g.connect(Pads.bus); s.start(t); s.stop(t + 3.8);
    },
    bass_: function (t, v) { Pads._osc("sine", 46, 42, t, 0.5, 1.3, 1.3 * v, 0.01); },
    stab_: function (t, v) {
      var c = Pads.ctx, lp = c.createBiquadFilter(), g = c.createGain();
      lp.type = "lowpass"; lp.frequency.setValueAtTime(5200, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.4);
      Pads._env(g, t, 0.004, 0.4, 0.42 * v);
      [261.6, 329.6, 392].forEach(function (f) {
        var o = c.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + 0.5);
      });
      lp.connect(g); g.connect(Pads.bus);
    },
    rev_: function (t, v) {
      var c = Pads.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = Pads.noise; f.type = "bandpass"; f.Q.value = 5;
      f.frequency.setValueAtTime(8000, t); f.frequency.exponentialRampToValueAtTime(250, t + 0.9);
      Pads._env(g, t, 0.01, 0.9, 0.6 * v); s.connect(f); f.connect(g); g.connect(Pads.bus); s.start(t); s.stop(t + 1);
    }
  };

  /* ================================================================== sequencer */
  var ROWS = [
    { k: "kick", label: "KICK" }, { k: "dhol", label: "DHOL" }, { k: "tilli", label: "TILLI" },
    { k: "snare", label: "SNARE" }, { k: "clap", label: "CLAP" }, { k: "hat", label: "HAT" }, { k: "bass", label: "SUB" }
  ];
  function pat(str) { return str.replace(/\s+/g, "").split("").map(function (c) { return c === "x" ? 1 : 0; }); }
  var PATTERNS = {
    wedding: { label: "Wedding Baraat", bpm: 132, rows: {
      kick: pat("x... x... x... x..."), dhol: pat("x..x ..x. x..x ..x."), tilli: pat("..x. x... ..x. x.x."),
      snare: pat("...."+"...."+"...."+"...."), clap: pat(".... x... .... x..."), hat: pat("x.x. x.x. x.x. x.x."), bass: pat("x... .... x... ....") } },
    bhangra: { label: "Punjabi Bhangra", bpm: 104, rows: {
      kick: pat("x... ..x. x... ..x."), dhol: pat("x.xx ..x. x.xx ..xx"), tilli: pat(".x.. x.x. .x.. x.x."),
      snare: pat(".... .... .... ...."), clap: pat(".... x... .... x..."), hat: pat("x.x. x.x. x.x. x.xx"), bass: pat("x... .... .... ....") } },
    dhamaal: { label: "Dhamaal Max", bpm: 142, rows: {
      kick: pat("x.x. x.x. x.x. x.xx"), dhol: pat("xx.x xx.x xx.x xxxx"), tilli: pat(".x.x .x.x .x.x .xx."),
      snare: pat(".... x... .... x..x"), clap: pat(".... x... .... x..."), hat: pat("xxxx xxxx xxxx xxxx"), bass: pat("x... x... x... x...") } },
    edm: { label: "EDM 4/4", bpm: 128, rows: {
      kick: pat("x... x... x... x..."), dhol: pat(".... .... .... ...."), tilli: pat(".... .... .... ...."),
      snare: pat(".... .... .... ...."), clap: pat(".... x... .... x..."), hat: pat("..x. ..x. ..x. ..x."), bass: pat(".x.. .x.. .x.. .x..") } },
    trap: { label: "Trap 808", bpm: 142, rows: {
      kick: pat("x... ..x. ..x. ...."), dhol: pat(".... .... .... ...."), tilli: pat(".... .... .... ...."),
      snare: pat(".... x... .... x..."), clap: pat(".... x... .... x..."), hat: pat("xxxx xxxx xxxx xxxx"), bass: pat("x... ..x. ..x. ....") } },
    dembow: { label: "Dembow", bpm: 96, rows: {
      kick: pat("x... x... x... x..."), dhol: pat(".... .... .... ...."), tilli: pat(".... .... .... ...."),
      snare: pat("...x ..x. ...x ..x."), clap: pat(".... .... .... ...."), hat: pat("x.x. x.x. x.x. x.x."), bass: pat("x... .... x... ....") } },
    empty: { label: "Empty", bpm: 120, rows: {} }
  };

  var Seq = {
    ROWS: ROWS, PATTERNS: PATTERNS,
    grid: {}, bpm: 128, swing: 0, playing: false, step: 0, nextTime: 0, timer: 0, onStep: null,
    load: function (key) {
      var p = PATTERNS[key] || PATTERNS.empty;
      ROWS.forEach(function (r) { Seq.grid[r.k] = (p.rows[r.k] || []).slice(0, 16); while (Seq.grid[r.k].length < 16) Seq.grid[r.k].push(0); });
      Seq.bpm = p.bpm;
    },
    toggle: function (row, i) { Seq.grid[row][i] = Seq.grid[row][i] ? 0 : 1; },
    start: function () {
      if (Seq.playing || !Pads.ctx) return;
      Seq.playing = true; Seq.step = 0; Seq.nextTime = Pads.ctx.currentTime + 0.06;
      Seq.timer = setInterval(Seq.tick, 25);
    },
    stop: function () { Seq.playing = false; clearInterval(Seq.timer); Seq.timer = 0; if (Seq.onStep) Seq.onStep(-1); },
    tick: function () {
      var c = Pads.ctx; if (!c) return;
      while (Seq.nextTime < c.currentTime + 0.12) {
        var i = Seq.step, t = Seq.nextTime + (i % 2 ? Seq.swing * (60 / Seq.bpm / 4) * 0.5 : 0);
        ROWS.forEach(function (r) {
          if (Seq.grid[r.k][i]) Pads.trigger(r.k, (i % 4 === 0 ? 1 : 0.8), t);
        });
        (function (idx, when) {
          setTimeout(function () { if (Seq.playing && Seq.onStep) Seq.onStep(idx); }, Math.max(0, (when - c.currentTime) * 1000));
        })(i, t);
        Seq.nextTime += 60 / Seq.bpm / 4;
        Seq.step = (i + 1) % 16;
      }
    }
  };
  Seq.load("wedding");

  /* ==================================================================== rack UI */
  function rackHTML() {
    var D = global.GhostDSP, st = D ? D.state : {};
    var voices = D ? Object.keys(D.VOICES).map(function (k) {
      return '<button type="button" class="dj-chip2' + (st.voice === k ? " is-on" : "") + '" data-voice="' + k + '">' + esc(D.VOICES[k].label) + '</button>';
    }).join("") : "";
    var pads = PADS.map(function (p) {
      return '<button type="button" class="dj-pad" data-pad="' + p.k + '"><b>' + p.label + '</b><i>' + p.key + '</i></button>';
    }).join("");
    var pats = Object.keys(PATTERNS).map(function (k) { return '<option value="' + k + '">' + esc(PATTERNS[k].label) + '</option>'; }).join("");
    var seqRows = ROWS.map(function (r) {
      var cells = "";
      for (var i = 0; i < 16; i++) cells += '<button type="button" class="dj-cell' + (i % 4 === 0 ? " is-beat" : "") + '" data-row="' + r.k + '" data-i="' + i + '" aria-label="' + r.label + ' step ' + (i + 1) + '"></button>';
      return '<div class="dj-seqrow"><span class="dj-seqlabel">' + r.label + '</span><div class="dj-seqcells">' + cells + '</div></div>';
    }).join("");
    function sl(id, label, min, max, val, hint) {
      return '<label class="dj-fx"><span class="dj-fx__head"><span>' + label + '</span><b id="' + id + 'Val"></b></span>' +
        '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" aria-label="' + label + '">' +
        (hint ? '<span class="dj-rack__hint">' + hint + '</span>' : '') + '</label>';
    }
    return '' +
      '<section class="dj-rack" id="djRack" aria-label="Pro rack">' +
        '<header class="dj-rack__head"><div class="dj-kicker">PRO RACK</div><h3>Voice, bass and beats \u2014 free, built in</h3></header>' +
        '<div class="dj-rack__grid">' +

          '<div class="dj-rackbox dj-rackbox--bass">' +
            '<h4>BASS MONSTER</h4>' +
            sl("djrBass", "Bass punch", 0, 100, st.bass || 0, "Deep shelf + harmonics, so even laptop speakers hit") +
            sl("djrSub", "Earthquake sub", 0, 100, st.sub || 0, "Squashed 30\u201380 Hz layer \u2014 this is what shakes the table") +
            sl("djrLoud", "Loudness maximizer", 100, 300, 100, "Pushes the level through the limiter (louder, not clipped)") +
            '<button type="button" class="dj-maxbeat" id="djrMax">MAX BEAT</button>' +
            '<p class="dj-rack__warn">Max Beat can be extremely loud and can damage small speakers or hearing. Start low and raise slowly.</p>' +
          '</div>' +

          '<div class="dj-rackbox">' +
            '<h4>VOICE CHANGER</h4>' +
            '<div class="dj-chips2">' + voices + '</div>' +
            sl("djrPitch", "Extra pitch (semitones)", -12, 12, st.pitch || 0, "") +
          '</div>' +

          '<div class="dj-rackbox">' +
            '<h4>VOCAL REMOVER</h4>' +
            sl("djrVocal", "Amount", 0, 100, st.vocal || 0, "Cancels the centre of a stereo song (karaoke). Not AI \u2014 reverb and doubled vocals stay a little") +
            '<div class="dj-row"><label class="dj-check"><input type="radio" name="djrVMode" value="remove"' + (st.vocalMode !== "only" ? " checked" : "") + '><span>Remove voice</span></label>' +
              '<label class="dj-check"><input type="radio" name="djrVMode" value="only"' + (st.vocalMode === "only" ? " checked" : "") + '><span>Voice only</span></label></div>' +
            '<h4 class="dj-rackbox__sub">HD SOUND</h4>' +
            sl("djrHd", "HD clarity", 0, 100, st.hd || 0, "Adds air and detail. It cannot add what a low-quality file never had") +
            '<label class="dj-check"><input type="checkbox" id="djrHires"' + (D && D.hiresEnabled() ? " checked" : "") + '><span>96 kHz engine (restart the app to apply)</span></label>' +
          '</div>' +

          '<div class="dj-rackbox dj-rackbox--pads">' +
            '<h4>BEAT PADS <span class="dj-rack__hint">keyboard: Q W E R / A S D F / Z X C V / T G B Y</span></h4>' +
            '<div class="dj-pads">' + pads + '</div>' +
            sl("djrPad", "Pad level", 0, 200, 100, "") +
          '</div>' +

          '<div class="dj-rackbox dj-rackbox--seq">' +
            '<h4>BEAT SEQUENCER</h4>' +
            '<div class="dj-row"><select id="djSeqPat" aria-label="Pattern">' + pats + '</select>' +
              '<button type="button" class="dj-btn dj-btn--wide" id="djSeqPlay">\u25B6 START</button>' +
              '<button type="button" class="dj-btn dj-btn--sm" id="djSeqA" title="Use Deck A tempo">= A</button>' +
              '<button type="button" class="dj-btn dj-btn--sm" id="djSeqB" title="Use Deck B tempo">= B</button></div>' +
            sl("djSeqBpm", "Tempo (BPM)", 60, 200, Seq.bpm, "") +
            sl("djSeqSwing", "Swing", 0, 60, 0, "") +
            '<div class="dj-seq" id="djSeq">' + seqRows + '</div>' +
          '</div>' +

        '</div>' +
      '</section>';
  }

  function wireRack(root, api) {
    var D = global.GhostDSP;
    var $ = function (id) { return root.querySelector("#" + id); };
    function eng() { return api.engine(); }
    function ensurePads() {
      var e = eng(); if (!e) { api.toast("DJ audio engine isn't available here"); return null; }
      Pads.init(e.ctx, e.master);
      if (e.ctx.state === "suspended") { try { e.ctx.resume(); } catch (err) { /* ignore */ } }
      return e;
    }
    function bindRange(id, fn, fmt) {
      var el = $(id), out = $(id + "Val");
      function paint() { if (out) out.textContent = fmt ? fmt(parseFloat(el.value)) : el.value; }
      el.addEventListener("input", function () { paint(); fn(parseFloat(el.value)); });
      el.addEventListener("dblclick", function () { el.value = el.defaultValue; paint(); fn(parseFloat(el.value)); });
      paint();
    }
    var pct = function (v) { return Math.round(v) + "%"; };

    function syncFromState() {
      var s = D.state;
      $("djrBass").value = s.bass; $("djrBassVal").textContent = pct(s.bass);
      $("djrSub").value = s.sub; $("djrSubVal").textContent = pct(s.sub);
      $("djrVocal").value = s.vocal; $("djrVocalVal").textContent = pct(s.vocal);
      $("djrHd").value = s.hd; $("djrHdVal").textContent = pct(s.hd);
      $("djrPitch").value = s.pitch; $("djrPitchVal").textContent = (s.pitch > 0 ? "+" : "") + s.pitch;
      root.querySelectorAll("[data-voice]").forEach(function (b) { b.classList.toggle("is-on", b.dataset.voice === s.voice); });
      var max = $("djrMax"); if (max) max.classList.toggle("is-on", s.bass >= 100 && s.sub >= 100);
    }
    if (D) D.onChange.push(function () { if (root.isConnected) syncFromState(); });

    bindRange("djrBass", function (v) { D.set("bass", v); }, pct);
    bindRange("djrSub", function (v) { D.set("sub", v); }, pct);
    bindRange("djrVocal", function (v) { D.set("vocal", v); }, pct);
    bindRange("djrHd", function (v) { D.set("hd", v); }, pct);
    bindRange("djrPitch", function (v) { D.set("pitch", v); }, function (v) { return (v > 0 ? "+" : "") + v; });
    bindRange("djrLoud", function (v) { api.setLoudness(v / 100); }, pct);
    bindRange("djrPad", function (v) { Pads.setLevel(v / 100); }, pct);
    bindRange("djSeqBpm", function (v) { Seq.bpm = v; }, function (v) { return v + " BPM"; });
    bindRange("djSeqSwing", function (v) { Seq.swing = v / 100; }, pct);

    root.querySelectorAll("[data-voice]").forEach(function (b) {
      b.addEventListener("click", function () { D.set("voice", b.dataset.voice); if (b.dataset.voice !== "off") api.toast("Voice: " + D.VOICES[b.dataset.voice].label); });
    });
    root.querySelectorAll('input[name="djrVMode"]').forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) D.set("vocalMode", r.value); });
    });
    $("djrMax").addEventListener("click", function () {
      var on = !(D.state.bass >= 100 && D.state.sub >= 100);
      D.maxBeat(on);
      if (on) { $("djrLoud").value = 220; $("djrLoudVal").textContent = "220%"; api.setLoudness(2.2); api.toast("MAX BEAT on \u2014 turn your volume down first if it is too loud"); }
      else { $("djrLoud").value = 100; $("djrLoudVal").textContent = "100%"; api.setLoudness(1); }
    });
    $("djrHires").addEventListener("change", function (e) {
      D.setHires(e.target.checked);
      api.toast(e.target.checked ? "96 kHz engine will start next time you open the app (if your sound card supports it)" : "Standard engine will be used next time you open the app");
    });

    // pads
    function hit(k, el) {
      if (!ensurePads()) return;
      Pads.trigger(k, 1);
      if (el) { el.classList.add("is-hit"); setTimeout(function () { el.classList.remove("is-hit"); }, 110); }
    }
    root.querySelectorAll("[data-pad]").forEach(function (b) {
      b.addEventListener("pointerdown", function (e) { if (e.button > 0) return; e.preventDefault(); hit(b.dataset.pad, b); });
    });
    var keymap = {};
    PADS.forEach(function (p) { keymap[p.key.toLowerCase()] = p.k; });
    global.addEventListener("keydown", function (e) {
      if (!api.isOpen() || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      var k = keymap[(e.key || "").toLowerCase()];
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      hit(k, root.querySelector('[data-pad="' + k + '"]'));
    }, true);

    // sequencer
    var cells = {};
    root.querySelectorAll(".dj-cell").forEach(function (c) { cells[c.dataset.row + c.dataset.i] = c; });
    function paintGrid() {
      ROWS.forEach(function (r) { for (var i = 0; i < 16; i++) cells[r.k + i].classList.toggle("is-on", !!Seq.grid[r.k][i]); });
      $("djSeqBpm").value = Seq.bpm; $("djSeqBpmVal").textContent = Seq.bpm + " BPM";
    }
    paintGrid();
    root.querySelectorAll(".dj-cell").forEach(function (c) {
      c.addEventListener("click", function () { Seq.toggle(c.dataset.row, +c.dataset.i); c.classList.toggle("is-on", !!Seq.grid[c.dataset.row][+c.dataset.i]); });
    });
    var lastStep = -1;
    Seq.onStep = function (i) {
      if (lastStep >= 0) ROWS.forEach(function (r) { cells[r.k + lastStep].classList.remove("is-now"); });
      lastStep = i;
      if (i >= 0) ROWS.forEach(function (r) { cells[r.k + i].classList.add("is-now"); });
      $("djSeqPlay").textContent = Seq.playing ? "\u25A0 STOP" : "\u25B6 START";
    };
    $("djSeqPat").value = "wedding";
    $("djSeqPat").addEventListener("change", function () { Seq.load($("djSeqPat").value); paintGrid(); });
    $("djSeqPlay").addEventListener("click", function () {
      if (Seq.playing) { Seq.stop(); return; }
      if (!ensurePads()) return;
      api.claim && api.claim();
      Seq.start();
      $("djSeqPlay").textContent = "\u25A0 STOP";
    });
    ["A", "B"].forEach(function (id) {
      $("djSeq" + id).addEventListener("click", function () {
        var bpm = api.deckBpm(id.toLowerCase());
        if (!bpm) { api.toast("Deck " + id + " has no BPM yet \u2014 load a track and press ANALYZE"); return; }
        Seq.bpm = clamp(Math.round(bpm), 60, 200); paintGrid();
        api.toast("Sequencer tempo = Deck " + id + " (" + Seq.bpm + " BPM)");
      });
    });
    syncFromState();
  }

  global.GhostDJPro = { Scratch: Scratch, Pads: Pads, Seq: Seq, rackHTML: rackHTML, wireRack: wireRack };
})(window);
