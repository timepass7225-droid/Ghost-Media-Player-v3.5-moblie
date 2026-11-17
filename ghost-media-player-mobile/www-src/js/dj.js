/* Ghost Media Player — DJ Mode
 *
 * Two real decks that play local audio files, a crossfader and a small mixer, built on the
 * app's single shared AudioContext (GhostAudioFX.getContext) — the normal player graph is never touched.
 *
 *   deck:  <audio> ─▶ trim ─▶ bass ─▶ treble ─▶ highpass ─▶ lowpass ─▶ [distortion] ─▶ channel fader ─▶ crossfader gain ─┬▶ master ─▶ limiter ─▶ out
 *                                                                                                                         ├▶ echo send ─▶ delay (feedback) ─▶ master
 *                                                                                                                         └▶ reverb send ─▶ shared convolver ─▶ master
 *
 * Every control on the screen is wired to something that changes the audio or the deck:
 *  - Crossfader: equal-power gains for Deck A / Deck B.   - Channel faders, master volume, gain/bass/treble.
 *  - Filter (low-pass left / high-pass right), echo + delay time, reverb, distortion.
 *  - Tempo ±12 % (real time-stretch, key lock on/off), cue, loops (manual + beat loops), SYNC, TAP.
 *  - Beat-aware features use a ONE-TIME analysis (GhostBeat) of the loaded file, only when the user
 *    asks for it or a feature needs it. Constant tempo is assumed; phase is approximate — the UI shows
 *    the confidence and the measured beat offset instead of claiming perfect sync.
 *
 * Cost model: no analysis unless needed; the animation frame loop only runs while a deck is playing
 * or a transition is running; the reverb convolver is only connected while a reverb amount is > 0;
 * the distortion shaper is only in the path while drive > 0; the waveform is one static SVG path.
 */
(function () {
  "use strict";
  if (window.GhostDJ) return;

  var LS_KEY = "ghost.dj.v1";
  var RATE_MIN = 0.88, RATE_MAX = 1.12;
  var MAX_ANALYZE_SEC = 12 * 60, MAX_ANALYZE_BYTES = 80 * 1024 * 1024;
  var ANALYSIS_RATE = 11025;
  var LOOP_BEATS = [0.5, 1, 2, 4, 8, 16];
  var AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba|webm|mka|wma|aif|aiff)$/i;

  var FX = [
    { k: "trim", label: "Gain", min: -12, max: 12, step: 0.5, def: 0 },
    { k: "bass", label: "Bass", min: -12, max: 12, step: 0.5, def: 0 },
    { k: "treble", label: "Treble", min: -12, max: 12, step: 0.5, def: 0 },
    { k: "filter", label: "Filter", min: -100, max: 100, step: 1, def: 0 },
    { k: "echo", label: "Echo", min: 0, max: 100, step: 1, def: 0 },
    { k: "delay", label: "Delay time", min: 50, max: 1000, step: 5, def: 375 },
    { k: "reverb", label: "Reverb", min: 0, max: 100, step: 1, def: 0 },
    { k: "dist", label: "Distortion", min: 0, max: 100, step: 1, def: 0 }
  ];

  /* ---------------------------------------------------------------- helpers */
  function core() { return window.GhostCore || null; }
  function toast(m) { var c = core(); if (c && c.toast) c.toast(m); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(t) { return window.ghostFormatTime ? window.ghostFormatTime(t) : String(Math.floor(t)); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ext(name) { return ((String(name || "").split(".").pop()) || "").toLowerCase(); }
  function loadPrefs() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function savePrefs() { try { localStorage.setItem(LS_KEY, JSON.stringify({ master: S.master, mode: S.mode, len: S.len })); } catch (e) { /* ignore */ } }
  function noop() {}

  /* ------------------------------------------------------------------ state */
  var prefs = loadPrefs();
  var S = {
    open: false, built: false,
    xf: 0.5,                                   // crossfader 0 = Deck A .. 1 = Deck B
    master: typeof prefs.master === "number" ? clamp(prefs.master, 0, 1) : 0.9,
    mode: prefs.mode === "beat" || prefs.mode === "loop" ? prefs.mode : "fade",
    len: prefs.len > 0 ? prefs.len : 8,
    raf: 0, loopTimer: 0, revOffTimer: 0, revOn: false
  };
  var E = null;                                // shared engine nodes (built lazily on first track load)
  var T = { active: false };                   // running transition
  var $ = {};                                  // screen elements

  function newDeck(id) {
    var fxv = {};
    FX.forEach(function (f) { fxv[f.k] = f.def; });
    return {
      id: id, name: "Deck " + id.toUpperCase(),
      el: null, n: null, file: null, url: null, loadId: 0,
      title: "", artist: "", duration: 0, ready: false,
      vol: 0.85, rate: 1, keyLock: true, fx: fxv,
      cue: 0, cuePreview: false, loop: { in: null, out: null, on: false, beats: 0 },
      peaks: null, an: null, analyzing: null,
      bpm: 0, offset: 0, conf: "none", manual: false, oct: 1,
      taps: [], ui: {}, last: {}
    };
  }
  var decks = { a: newDeck("a"), b: newDeck("b") };
  function other(d) { return d.id === "a" ? decks.b : decks.a; }
  function isPlaying(d) { return !!(d.el && d.ready && !d.el.paused && !d.el.ended); }
  function anyPlaying() { return isPlaying(decks.a) || isPlaying(decks.b); }
  function pos(d) { return d.scrOn && d.scr ? d.scr.seconds() : (d.el ? (d.el.currentTime || 0) : 0); }
  function seqPlaying() { return !!(window.GhostDJPro && window.GhostDJPro.Seq.playing); }
  function scratching() { return decks.a.scrOn || decks.b.scrOn; }
  function beatOK(d) { return !!(d.ready && d.bpm > 0 && d.conf !== "low" && d.conf !== "none"); }

  /* ---------------------------------------------------------------- engine */
  function distortionCurve(amount) {
    var n = 1024, curve = new Float32Array(n), k = amount * 60;
    for (var i = 0; i < n; i++) {
      var x = (i * 2) / n - 1;
      curve[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }
  function makeImpulse(ctx, seconds, decay) {
    var rate = ctx.sampleRate, len = Math.max(1, Math.floor(rate * seconds)), buf = ctx.createBuffer(2, len, rate);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function engine() {
    if (E) return E;
    var fx = window.GhostAudioFX;
    if (!fx || !fx.isSupported()) return null;
    var ctx = fx.getContext();
    if (!ctx) return null;
    var e = { ctx: ctx };
    e.master = ctx.createGain(); e.master.gain.value = S.master;
    e.limiter = ctx.createDynamicsCompressor();
    e.limiter.threshold.value = -2; e.limiter.knee.value = 0; e.limiter.ratio.value = 20;
    e.limiter.attack.value = 0.003; e.limiter.release.value = 0.2;
    e.loud = ctx.createGain(); e.loud.gain.value = 1;
    e.dsp = window.GhostDSP && window.GhostDSP.create ? window.GhostDSP.create(ctx) : null;
    if (e.dsp) { e.master.connect(e.dsp.input); e.dsp.output.connect(e.loud); } else { e.master.connect(e.loud); }
    e.loud.connect(e.limiter); e.limiter.connect(ctx.destination);
    e.meter = ctx.createAnalyser(); e.meter.fftSize = 256; e.master.connect(e.meter);
    e.revIn = ctx.createGain();
    e.revOut = ctx.createGain(); e.revOut.gain.value = 1;
    if (ctx.createConvolver) {
      e.conv = ctx.createConvolver(); e.conv.buffer = makeImpulse(ctx, 1.8, 2.6);
      e.revIn.connect(e.conv); e.conv.connect(e.revOut);      // revOut -> master only while a reverb amount is set
    }
    E = e;
    fx.keepAlive = function () { return anyPlaying() || seqPlaying() || scratching(); };
    return e;
  }

  function setReverbBus() {
    if (!E || !E.conv) return;
    var want = decks.a.fx.reverb > 0 || decks.b.fx.reverb > 0;
    if (want) {
      clearTimeout(S.revOffTimer); S.revOffTimer = 0;
      if (!S.revOn) { try { E.revOut.connect(E.master); } catch (err) { /* ignore */ } S.revOn = true; }
    } else if (S.revOn && !S.revOffTimer) {
      S.revOffTimer = setTimeout(function () {     // let the tail ring out, then stop the convolver costing CPU
        S.revOffTimer = 0;
        if (decks.a.fx.reverb > 0 || decks.b.fx.reverb > 0) return;
        try { E.revOut.disconnect(); } catch (err) { /* ignore */ }
        S.revOn = false;
      }, 2800);
    }
  }

  function buildDeckAudio(d) {
    if (d.n) return true;
    var e = engine();
    if (!e) return false;
    var c = e.ctx, n = {};
    try { n.src = c.createMediaElementSource(d.el); } catch (err) { return false; }
    n.trim = c.createGain();
    n.bass = c.createBiquadFilter(); n.bass.type = "lowshelf"; n.bass.frequency.value = 200;
    n.treble = c.createBiquadFilter(); n.treble.type = "highshelf"; n.treble.frequency.value = 3200;
    n.hp = c.createBiquadFilter(); n.hp.type = "highpass"; n.hp.frequency.value = 20; n.hp.Q.value = 0.9;
    n.lp = c.createBiquadFilter(); n.lp.type = "lowpass"; n.lp.frequency.value = 20000; n.lp.Q.value = 0.9;
    n.dpre = c.createGain(); n.dpost = c.createGain();
    n.shaper = c.createWaveShaper(); n.shaper.oversample = "none";
    n.fader = c.createGain(); n.xf = c.createGain();
    n.meter = c.createAnalyser(); n.meter.fftSize = 256;
    n.echoSend = c.createGain(); n.echoSend.gain.value = 0;
    n.delay = c.createDelay(2.0); n.delay.delayTime.value = 0.375;
    n.fb = c.createGain(); n.fb.gain.value = 0.42;
    n.echoOut = c.createGain();
    n.revSend = c.createGain(); n.revSend.gain.value = 0;

    n.live = c.createGain(); n.src.connect(n.live); n.live.connect(n.trim); n.trim.connect(n.bass); n.bass.connect(n.treble); n.treble.connect(n.hp);
    n.hp.connect(n.lp); n.lp.connect(n.dpre); n.dpre.connect(n.dpost);
    n.dpost.connect(n.fader); n.fader.connect(n.xf); n.fader.connect(n.meter);
    n.xf.connect(e.master);
    n.xf.connect(n.echoSend); n.echoSend.connect(n.delay); n.delay.connect(n.fb); n.fb.connect(n.delay);
    n.delay.connect(n.echoOut); n.echoOut.connect(e.master);
    n.xf.connect(n.revSend); n.revSend.connect(e.revIn);
    d.n = n;
    if (window.GhostDJPro) d.scr = window.GhostDJPro.Scratch.create(c);
    FX.forEach(function (f) { applyFx(d, f.k, true); });
    applyVol(d, true);
    applyXf(true);
    return true;
  }

  function T0(imm) { return imm ? 0.0001 : 0.02; }
  function applyFx(d, k, imm) {
    var n = d.n; if (!n) return;
    var now = E.ctx.currentTime, v = d.fx[k], tc = T0(imm);
    switch (k) {
      case "trim": n.trim.gain.setTargetAtTime(Math.pow(10, v / 20), now, tc); break;
      case "bass": n.bass.gain.setTargetAtTime(v, now, tc); break;
      case "treble": n.treble.gain.setTargetAtTime(v, now, tc); break;
      case "filter": {
        var x = v / 100;
        n.lp.frequency.setTargetAtTime(x < 0 ? 20000 * Math.pow(80 / 20000, -x) : 20000, now, tc);
        n.hp.frequency.setTargetAtTime(x > 0 ? 20 * Math.pow(400, x) : 20, now, tc);
        break;
      }
      case "echo": n.echoSend.gain.setTargetAtTime(v / 100 * 0.9, now, tc); break;
      case "delay": n.delay.delayTime.setTargetAtTime(v / 1000, now, 0.05); break;
      case "reverb": n.revSend.gain.setTargetAtTime(v / 100 * 0.9, now, tc); setReverbBus(); break;
      case "dist": {
        var amt = v / 100;
        try { n.dpre.disconnect(); } catch (err) { /* ignore */ }
        try { n.shaper.disconnect(); } catch (err) { /* ignore */ }
        if (amt > 0) {
          n.shaper.curve = distortionCurve(amt);
          n.dpost.gain.setTargetAtTime(1 / (1 + amt * 1.2), now, tc);
          n.dpre.connect(n.shaper); n.shaper.connect(n.dpost);
        } else {
          n.dpost.gain.setTargetAtTime(1, now, tc);
          n.dpre.connect(n.dpost);
        }
        break;
      }
    }
  }
  function applyVol(d, imm) { if (d.n) d.n.fader.gain.setTargetAtTime(d.vol * d.vol, E.ctx.currentTime, T0(imm)); }
  function xfGains(x) { return { a: Math.cos(x * Math.PI / 2), b: Math.sin(x * Math.PI / 2) }; }
  function applyXf(imm) {
    if (!E) return;
    var g = xfGains(S.xf), now = E.ctx.currentTime, tc = T0(imm);
    if (decks.a.n) decks.a.n.xf.gain.setTargetAtTime(g.a, now, tc);
    if (decks.b.n) decks.b.n.xf.gain.setTargetAtTime(g.b, now, tc);
  }

  /* ------------------------------------------------------------ deck audio element */
  function ensureEl(d) {
    if (d.el) return d.el;
    var el = new Audio();
    el.preload = "auto";
    el.addEventListener("loadedmetadata", function () {
      if (el.getAttribute("data-load") !== String(d.loadId)) return;
      d.duration = isFinite(el.duration) ? el.duration : 0;
      d.ready = d.duration > 0;
      el.playbackRate = d.rate * (d.slow ? 0.5 : 1);
      renderDeck(d); renderWaveBase(d); prepareScratch(d);
    });
    el.addEventListener("error", function () {
      if (!d.file || el.getAttribute("data-load") !== String(d.loadId)) return;
      toast(d.name + ": this file can't be played \u2014 it may be corrupt or use an unsupported codec");
      unloadDeck(d);
    });
    ["play", "pause", "ended"].forEach(function (ev) {
      el.addEventListener(ev, function () { if (ev === "ended") d.cuePreview = false; onDeckState(d); });
    });
    ["timeupdate", "seeked"].forEach(function (ev) {
      el.addEventListener(ev, function () { if (S.open && !S.raf) renderTime(d, true); });
    });
    d.el = el;
    setKeyLock(d, d.keyLock);
    return el;
  }
  function setKeyLock(d, on) {
    d.keyLock = !!on;
    if (!d.el) return;
    d.el.preservesPitch = d.keyLock; d.el.mozPreservesPitch = d.keyLock; d.el.webkitPreservesPitch = d.keyLock;
  }

  function claimOutput() {
    var c = core();
    if (c && c.player && !c.player.isPaused()) c.player.pause();
    if (window.GhostRadio && window.GhostRadio.isActive && window.GhostRadio.isActive()) window.GhostRadio.stop();
  }

  function isAudioFile(f) { return !!f && ((f.type || "").indexOf("audio/") === 0 || AUDIO_EXT.test(f.name || "")); }

  function loadDeck(d, file) {
    if (!file) return;
    if (!isAudioFile(file)) { toast(d.name + ": that isn't an audio file"); return; }
    if (!engine()) { toast("DJ Mode needs the Web Audio API, which isn't available here"); return; }
    cancelTransitionIf(d);
    var el = ensureEl(d);
    if (!buildDeckAudio(d)) { toast("This audio engine can't route the deck"); return; }
    try { el.pause(); } catch (err) { /* ignore */ }
    if (d.url) { try { URL.revokeObjectURL(d.url); } catch (err) { /* ignore */ } }
    d.loadId++;
    d.file = file; d.url = URL.createObjectURL(file);
    d.title = file.name.replace(/\.[^.]+$/, ""); d.artist = ""; d.duration = 0; d.ready = false;
    d.cue = 0; d.cuePreview = false; d.loop = { in: null, out: null, on: false, beats: 0 };
    d.peaks = null; d.an = null; d.analyzing = null; d.bpm = 0; d.offset = 0; d.conf = "none"; d.manual = false; d.oct = 1; d.taps = [];
    setRate(d, 1, true);
    el.setAttribute("data-load", String(d.loadId));
    el.src = d.url;
    try { el.load(); } catch (err) { /* ignore */ }
    var id = d.loadId;
    if (window.GhostTags) window.GhostTags.read(file).then(function (t) {
      if (id !== d.loadId) return;
      if (t.title) d.title = t.title;
      if (t.artist) d.artist = t.artist;
      renderDeck(d); renderSide();
    });
    renderDeck(d); renderWaveBase(d); updateLoopTimer(); renderSide(); renderDeck(other(d));
  }

  function unloadDeck(d) {
    cancelTransitionIf(d);
    if (d.el) { try { d.el.pause(); } catch (err) { /* ignore */ } d.el.removeAttribute("src"); d.el.removeAttribute("data-load"); try { d.el.load(); } catch (err) { /* ignore */ } }
    if (d.url) { try { URL.revokeObjectURL(d.url); } catch (err) { /* ignore */ } }
    d.loadId++;
    if (d.scr) { d.scr.end(); d.scr.setBuffer(null); } d.scrOn = false; d.scrReady = false; d.slow = false;
    d.file = null; d.url = null; d.title = ""; d.artist = ""; d.duration = 0; d.ready = false; d.peaks = null; d.an = null;
    d.analyzing = null; d.bpm = 0; d.conf = "none"; d.loop = { in: null, out: null, on: false, beats: 0 }; d.cue = 0;
    renderDeck(d); renderWaveBase(d); updateLoopTimer(); renderSide(); renderDeck(other(d));
  }

  /* --------------------------------------------------------------- transport */
  function playDeck(d) {
    if (!d.ready || !d.el) return;
    var e = engine(); if (!e) return;
    claimOutput();
    var p = e.ctx.state === "suspended" ? e.ctx.resume() : null;
    Promise.resolve(p).catch(noop).then(function () {
      var r = d.el.play();
      if (r && r.catch) r.catch(function () { toast(d.name + ": playback was blocked \u2014 tap Play again"); });
    });
  }
  function pauseDeck(d) { if (d.el) d.el.pause(); }
  function togglePlay(d) { if (!d.ready) { toast("Load a track on " + d.name + " first"); return; } if (isPlaying(d)) pauseDeck(d); else playDeck(d); }
  function stopDeck(d) {
    if (!d.ready) return;
    cancelTransitionIf(d);
    d.cuePreview = false;
    d.el.pause(); d.el.currentTime = 0;
    renderTime(d, true);
  }
  function seekTo(d, t) {
    if (!d.ready) return;
    d.el.currentTime = clamp(t, 0, Math.max(0, d.duration - 0.05));
  }
  function cueDown(d, keyboard) {
    if (!d.ready) { toast("Load a track on " + d.name + " first"); return; }
    if (!d.el.paused) { d.el.currentTime = d.cue; d.el.pause(); }
    else if (Math.abs(pos(d) - d.cue) < 0.06) { if (!keyboard) { d.cuePreview = true; playDeck(d); } }
    else { d.cue = pos(d); renderMarkers(d); toast(d.name + ": cue point set"); }
  }
  function cueUp(d) {
    if (!d.cuePreview) return;
    d.cuePreview = false;
    d.el.pause(); d.el.currentTime = d.cue;
  }

  function setRate(d, r, silent) {
    d.rate = clamp(r, RATE_MIN, RATE_MAX);
    if (d.el) d.el.playbackRate = d.rate * (d.slow ? 0.5 : 1);
    if (d.ui.tempo) { d.ui.tempo.value = ((d.rate - 1) * 100).toFixed(1); }
    if (!silent) renderDeck(d);
  }

  function onDeckState(d) {
    renderDeck(d);
    renderSide();
    updateLoopTimer();
    kick();
    var pl = anyPlaying() || seqPlaying() || scratching();
    if (!pl && E) {                              // everything stopped: park the context if the player isn't using it either
      var c = core();
      if (window.GhostAudioFX && (!c || c.player.isPaused())) window.GhostAudioFX.idle();
    }
  }

  /* ------------------------------------------------------- scratch / backspin / reverse */
  function readFile(file) {
    return file.arrayBuffer ? file.arrayBuffer() : new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); });
  }
  function scrNote(d, txt) { if (d.ui && d.ui.scrnote) d.ui.scrnote.textContent = txt; }
  function prepareScratch(d) {
    if (!E || !d.file || !d.scr || !window.GhostDJPro) return;
    var id = d.loadId;
    d.scr.setBuffer(null); d.scrReady = false;
    var est = d.duration * E.ctx.sampleRate * 2 * 4;                // decoded stereo float32
    if (est > 640 * 1024 * 1024) { scrNote(d, "Scratch off: track is too long to hold in memory (limit \u2248 " + Math.floor(640 * 1024 * 1024 / (E.ctx.sampleRate * 8) / 60) + " min)"); return; }
    scrNote(d, "Scratch: preparing the track\u2026");
    readFile(d.file).then(function (ab) {
      return new Promise(function (res, rej) { var p = E.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
    }).then(function (buf) {
      if (id !== d.loadId) return;
      d.scr.setBuffer(buf); d.scrReady = true;
      scrNote(d, "Scratch ready \u2014 drag the disc, or scroll over it");
    }, function () { if (id === d.loadId) scrNote(d, "Scratch unavailable: this file couldn't be decoded"); });
  }
  function startScratch(d) {
    if (!d.ready || !d.n || !d.scr) return false;
    if (!d.scr.hasBuffer()) { toast(d.scrReady === false ? "Scratch is still preparing this track \u2014 a few seconds" : "Scratch isn't available for this track"); return false; }
    if (d.scr.active && d.scrOn) return true;
    cancelTransitionIf(d);
    if (E.ctx.state === "suspended") { try { E.ctx.resume(); } catch (err) { /* ignore */ } }
    d.scrWas = isPlaying(d);
    d.scr.begin(d.el.currentTime, d.n.trim);
    d.n.live.gain.setTargetAtTime(0, E.ctx.currentTime, 0.003);
    d.scrOn = true;
    renderDeck(d); kick();
    return true;
  }
  function endScratch(d) {
    if (!d.scrOn) return;
    var sec = d.scr.end();
    d.scrOn = false;
    clearInterval(d.curveT); d.curveT = 0;
    try { d.el.currentTime = clamp(sec, 0, Math.max(0, d.duration - 0.05)); } catch (err) { /* ignore */ }
    setTimeout(function () { if (!d.scrOn && d.n) d.n.live.gain.setTargetAtTime(1, E.ctx.currentTime, 0.006); }, 45);
    renderTime(d, true); renderDeck(d); kick();
  }
  function runCurve(d, pts, done) {
    clearInterval(d.curveT);
    var t0 = performance.now();
    d.curveT = setInterval(function () {
      if (!d.scrOn) { clearInterval(d.curveT); d.curveT = 0; return; }
      var t = (performance.now() - t0) / 1000, i = 0;
      while (i < pts.length - 2 && t > pts[i + 1][0]) i++;
      var a = pts[i], b = pts[i + 1], f = clamp((t - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
      d.scr.setTarget(a[1] + (b[1] - a[1]) * f, true);
      if (t >= pts[pts.length - 1][0]) { clearInterval(d.curveT); d.curveT = 0; done(); }
    }, 16);
  }
  function backspin(d) {
    if (!startScratch(d)) return;
    var was = d.scrWas; d.scr.vel = was ? 1 : 0;
    runCurve(d, [[0, was ? 1 : 0], [0.1, -8], [0.5, -5], [1.0, -2], [1.35, 0]], function () { endScratch(d); playDeck(d); });
  }
  function brake(d) {
    if (!isPlaying(d)) { toast(d.name + ": brake works while a track is playing"); return; }
    if (!startScratch(d)) return;
    d.scr.vel = 1;
    runCurve(d, [[0, 1], [1.0, 0]], function () { try { d.el.pause(); } catch (err) { /* ignore */ } endScratch(d); });
  }
  function spinUp(d) {
    if (isPlaying(d)) return;
    if (!startScratch(d)) return;
    runCurve(d, [[0, 0], [0.8, 1]], function () { endScratch(d); playDeck(d); });
  }
  function setSlow(d, on) {
    d.slow = !!on;
    if (d.el) d.el.playbackRate = d.rate * (d.slow ? 0.5 : 1);
    if (d.ui.slow) d.ui.slow.classList.toggle("is-on", d.slow);
    toast(d.name + (d.slow ? ": slow-motion \u00bd" : ": normal speed"));
  }
  function wireJog(d) {
    var jog = d.ui.discbtn, J = null, TAU = Math.PI * 2;
    function ang(e, j) { return Math.atan2(e.clientY - j.cy, e.clientX - j.cx); }
    jog.addEventListener("pointerdown", function (e) {
      if (e.button > 0 || !d.ready) return;
      var r = jog.getBoundingClientRect();
      J = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x0: e.clientX, y0: e.clientY, a: 0, t: performance.now(), v: 0, on: false, id: e.pointerId };
      J.a = ang(e, J);
      try { jog.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    jog.addEventListener("pointermove", function (e) {
      if (!J || e.pointerId !== J.id) return;
      if (!J.on) {
        if (Math.hypot(e.clientX - J.x0, e.clientY - J.y0) < 5) return;
        clearInterval(d.curveT);
        if (!startScratch(d)) { J = null; return; }
        J.on = true; J.a = ang(e, J); J.t = performance.now();
        return;
      }
      var a = ang(e, J), da = a - J.a;
      if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
      var now = performance.now(), dt = Math.max(0.004, (now - J.t) / 1000);
      var v = clamp(da / TAU * window.GhostDJPro.Scratch.SEC_PER_REV / dt, -14, 14);
      J.v = J.v * 0.45 + v * 0.55;
      d.scr.setTarget(J.v, false);
      J.a = a; J.t = now;
    });
    function up(e) {
      if (!J || (e && e.pointerId !== J.id)) return;
      var was = J.on; J = null;
      try { jog.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (was) { d.suppressClick = true; setTimeout(function () { d.suppressClick = false; }, 60); endScratch(d); }
    }
    jog.addEventListener("pointerup", up);
    jog.addEventListener("pointercancel", up);
    jog.addEventListener("wheel", function (e) {
      if (!d.ready) return;
      e.preventDefault();
      if (!d.scrOn && !startScratch(d)) return;
      clearInterval(d.curveT);
      d.scr.setTarget(clamp(e.deltaY / 55, -9, 9), false);
      clearTimeout(d.wheelT);
      d.wheelT = setTimeout(function () { endScratch(d); }, 170);
    }, { passive: false });
    // reverse (hold)
    var rev = d.ui.reverse;
    rev.addEventListener("pointerdown", function (e) {
      if (e.button > 0 || !d.ready) return; e.preventDefault();
      try { rev.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!startScratch(d)) return;
      d.scr.vel = d.scrWas ? 1 : 0; d.scr.setTarget(-1, true); rev.classList.add("is-on");
    });
    ["pointerup", "pointercancel"].forEach(function (ev) {
      rev.addEventListener(ev, function () { rev.classList.remove("is-on"); if (d.scrOn) { var w = d.scrWas; endScratch(d); if (w) playDeck(d); } });
    });
  }

  /* -------------------------------------------------------------------- loops */
  function beatLen(d) { return 60 / d.bpm; }
  function gridPeriod(d) { return 60 / (d.bpm * d.oct); }
  function prevBeat(d, t) { var p = gridPeriod(d); return d.offset + Math.floor((t - d.offset) / p + 1e-6) * p; }
  function nextBeat(d, t) { var p = gridPeriod(d); return d.offset + Math.ceil((t - d.offset) / p - 1e-6) * p; }
  function beatPhase(d, t) { var x = (t - d.offset) / gridPeriod(d); return x - Math.floor(x); }

  function loopCheck() {
    [decks.a, decks.b].forEach(function (d) {
      var L = d.loop;
      if (!L.on || L.in == null || L.out == null || !isPlaying(d)) return;
      var t = d.el.currentTime, lead = 0.014 * d.rate;
      if (t >= L.out - lead || t < L.in - 0.25) d.el.currentTime = L.in + Math.max(0, t - L.out + lead);
    });
  }
  function updateLoopTimer() {
    var need = [decks.a, decks.b].some(function (d) { return d.loop.on && isPlaying(d); });
    if (need && !S.loopTimer) S.loopTimer = setInterval(loopCheck, 15);
    else if (!need && S.loopTimer) { clearInterval(S.loopTimer); S.loopTimer = 0; }
  }
  function setLoopOn(d, on) { d.loop.on = !!on; updateLoopTimer(); renderMarkers(d); renderLoopBtns(d); }

  function loopIn(d) {
    if (!d.ready) return;
    d.loop.in = pos(d); d.loop.out = null; d.loop.on = false; d.loop.beats = 0;
    renderMarkers(d); renderLoopBtns(d); updateLoopTimer();
  }
  function loopOut(d) {
    if (!d.ready) return;
    if (d.loop.in == null) { toast("Set a loop IN point first"); return; }
    var t = pos(d);
    if (t <= d.loop.in + 0.05) { toast("Loop OUT must be after IN"); return; }
    d.loop.out = t; d.loop.beats = 0;
    setLoopOn(d, true);
    if (isPlaying(d)) d.el.currentTime = d.loop.in;
  }
  function loopExit(d) {
    if (!d.ready) return;
    if (d.loop.on) { setLoopOn(d, false); }
    else if (d.loop.in != null && d.loop.out != null) { setLoopOn(d, true); if (isPlaying(d) && (pos(d) > d.loop.out || pos(d) < d.loop.in)) d.el.currentTime = d.loop.in; }
  }
  function beatLoop(d, beats) {
    if (!d.ready) { toast("Load a track on " + d.name + " first"); return; }
    if (d.loop.on && d.loop.beats === beats) { setLoopOn(d, false); return; }
    ensureAnalysis(d).then(function (ok) {
      if (!ok) { toast("Beat loops need a clear beat \u2014 use ANALYZE, or TAP along to set the BPM"); return; }
      var t = pos(d), start = prevBeat(d, t);
      if (start < 0) start = Math.max(0, d.offset);
      var len = beats * beatLen(d);
      if (start + len > d.duration) { toast("Not enough track left for that loop"); return; }
      d.loop.in = start; d.loop.out = start + len; d.loop.beats = beats;
      setLoopOn(d, true);
    });
  }

  /* ------------------------------------------------------------- analysis / BPM */
  function analyzeFile(d) {
    var file = d.file;
    if (file.size > MAX_ANALYZE_BYTES || d.duration > MAX_ANALYZE_SEC) return Promise.reject(new Error("This track is too long to analyze (limit about 12 minutes)."));
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || !window.GhostBeat) return Promise.reject(new Error("Analysis isn't available in this browser engine."));
    return (file.arrayBuffer ? file.arrayBuffer() : new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(file); }))
      .then(function (buf) {
        var oac = new OAC(1, 1, ANALYSIS_RATE);        // decoding at 11 kHz keeps the temporary memory small
        return new Promise(function (res, rej) { var p = oac.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
      })
      .then(function (ab) {
        var n = ab.length, ch = ab.numberOfChannels, mono;
        if (ch === 1) mono = ab.getChannelData(0);
        else {
          mono = new Float32Array(n);
          for (var c = 0; c < ch; c++) { var data = ab.getChannelData(c); for (var i = 0; i < n; i++) mono[i] += data[i] / ch; }
        }
        return window.GhostBeat.analyze(mono, ab.sampleRate);
      }, function () { throw new Error("This file couldn't be decoded for analysis."); });
  }

  /* Resolves true when the deck has a trustworthy beat grid afterwards. Never re-analyzes a deck. */
  function ensureAnalysis(d) {
    if (!d.file) return Promise.resolve(false);
    if (d.an || d.manual) return Promise.resolve(beatOK(d));
    if (d.analyzing) return d.analyzing;
    var id = d.loadId;
    d.analyzing = analyzeFile(d).then(function (r) {
      if (id !== d.loadId) return false;
      d.an = r; d.peaks = r.peaks;
      if (r.bpm > 0) { d.bpm = r.bpm; d.offset = r.offset; d.conf = r.confidence; d.oct = 1; }
      else { d.bpm = 0; d.conf = "none"; }
      d.analyzing = null;
      renderWaveBase(d); renderDeck(d);
      if (!beatOK(d)) toast(d.name + ": " + (r.bpm > 0 ? "no clear beat found (low confidence)" : "no beat found") + " \u2014 you can TAP the tempo instead");
      return beatOK(d);
    }, function (err) {
      if (id === d.loadId) { d.analyzing = null; renderDeck(d); toast(d.name + ": " + (err && err.message ? err.message : "analysis failed")); }
      return false;
    });
    renderDeck(d);
    return d.analyzing;
  }

  function tap(d) {
    if (!d.ready) { toast("Load a track on " + d.name + " first"); return; }
    if (!isPlaying(d)) { toast("Tap along while the track is playing"); return; }
    var now = performance.now();
    if (d.taps.length && now - d.taps[d.taps.length - 1].at > 2000) d.taps = [];
    d.taps.push({ at: now, t: pos(d) });
    if (d.taps.length > 12) d.taps.shift();
    if (d.taps.length < 4) { d.last.tapHint = "TAP " + d.taps.length + "/4"; renderDeck(d); return; }
    var span = (d.taps[d.taps.length - 1].at - d.taps[0].at) / (d.taps.length - 1) / 1000;     // real seconds per beat
    var bpm = 60 / span / d.rate;                                                              // track BPM (rate removed)
    bpm = Math.round(bpm * 10) / 10;
    if (bpm < 40 || bpm > 240) { d.taps = []; toast("That tapping speed isn't a plausible tempo"); return; }
    var period = 60 / bpm, sx = 0, sy = 0;
    d.taps.forEach(function (tp) { var a = 2 * Math.PI * (tp.t % period) / period; sx += Math.cos(a); sy += Math.sin(a); });
    var ang = Math.atan2(sy, sx); if (ang < 0) ang += 2 * Math.PI;
    d.bpm = bpm; d.offset = ang / (2 * Math.PI) * period; d.conf = "manual"; d.manual = true; d.oct = 1; d.last.tapHint = "";
    renderDeck(d);
  }

  /* ------------------------------------------------------------------- sync */
  function matchTempo(d, o) {
    var target = o.bpm * o.rate, best = null;
    [1, 2, 0.5].forEach(function (m) {
      var rate = target / (d.bpm * m), dist = Math.abs(Math.log(rate));
      if (!best || dist < best.dist) best = { m: m, rate: rate, dist: dist };
    });
    if (best.rate < RATE_MIN || best.rate > RATE_MAX) return null;
    d.oct = best.m; o.oct = 1;
    setRate(d, best.rate);
    return best;
  }
  /* Moves d so its beat grid lines up with o's. Returns the correction in ms, or null. */
  function alignPhase(d, o) {
    if (!isPlaying(d) || !isPlaying(o)) return null;
    var diff = beatPhase(d, pos(d)) - beatPhase(o, pos(o));
    diff -= Math.round(diff);
    var deltaTrack = diff * gridPeriod(d);
    d.el.currentTime = clamp(pos(d) - deltaTrack, 0, d.duration - 0.1);
    return deltaTrack / d.rate * 1000;
  }
  function phaseOffsetMs(a, b) {                 // measured offset of deck a relative to deck b, in ms (real time)
    var diff = beatPhase(a, pos(a)) - beatPhase(b, pos(b));
    diff -= Math.round(diff);
    return diff * gridPeriod(a) / a.rate * 1000;
  }

  function syncDeck(d) {
    var o = other(d);
    if (!d.ready || !o.ready) { toast("Load a track on both decks to use SYNC"); return; }
    Promise.all([ensureAnalysis(d), ensureAnalysis(o)]).then(function (ok) {
      if (!ok[0] || !ok[1]) { toast("SYNC needs a clear beat on both decks \u2014 try ANALYZE or TAP"); return; }
      var m = matchTempo(d, o);
      if (!m) { toast("Tempos are too far apart to sync (limit \u00b112 %)"); return; }
      var bpmTxt = (o.bpm * o.rate).toFixed(1) + " BPM" + (m.m === 2 ? " (double-time)" : m.m === 0.5 ? " (half-time)" : "");
      var ms = alignPhase(d, o);
      toast(ms == null ? d.name + " tempo matched to " + bpmTxt + " \u2014 start both decks, then press SYNC again to line up the beats"
                       : d.name + " matched to " + bpmTxt + " and beat-aligned (approximate)");
    });
  }

  /* ---------------------------------------------------------------- transitions */
  function ease(p) { return p * p * (3 - 2 * p); }
  function setXf(x) {
    S.xf = clamp(x, 0, 1);
    if ($.xf) $.xf.value = Math.round(S.xf * 1000);
    applyXf();
    renderAir();
  }
  function cancelTransition(silent) {
    if (!T.active) return;
    if (T.loopDeck) { setLoopOn(T.loopDeck, false); }
    T = { active: false };
    renderTrans();
    if (!silent) toast("Transition cancelled");
  }
  function cancelTransitionIf(d) { if (T.active && (T.from === d || T.to === d)) cancelTransition(true); }

  function startTransition(toId) {
    if (T.active) { toast("A transition is already running \u2014 cancel it first"); return; }
    var to = decks[toId], from = other(to);
    if (!to.ready) { toast("Load a track on " + to.name + " first"); return; }
    var endX = toId === "b" ? 1 : 0;
    if (S.mode === "fade") {
      if (Math.abs(S.xf - endX) < 0.01 && isPlaying(to)) { toast("The crossfader is already on " + to.name); return; }
      if (!isPlaying(to)) playDeck(to);
      T = { active: true, mode: "fade", phase: "fade", from: from, to: to, t0: performance.now(), dur: S.len * 1000, x0: S.xf, x1: endX, beats: 0 };
      renderTrans(); kick();
      return;
    }
    // beat-aware modes
    if (!from.ready) { toast("Load a track on " + from.name + " too \u2014 a beat-synced transition mixes between two tracks"); return; }
    if (!isPlaying(from)) { toast("Start " + from.name + " first \u2014 the transition mixes into " + to.name + " on its beat"); return; }
    T = { active: true, mode: S.mode, phase: "prep", from: from, to: to, x1: endX };
    renderTrans();
    Promise.all([ensureAnalysis(from), ensureAnalysis(to)]).then(function (ok) {
      if (!T.active || T.phase !== "prep") return;
      if (!ok[0] || !ok[1]) { T = { active: false }; renderTrans(); toast("Beat-synced transitions need a clear beat on both decks (ANALYZE, or TAP the tempo)"); return; }
      if (!isPlaying(from)) { T = { active: false }; renderTrans(); return; }
      var m = matchTempo(to, from);
      if (!m) { T = { active: false }; renderTrans(); toast("Tempos are too far apart to beat-match (limit \u00b112 %)"); return; }
      var t = pos(from), nb = nextBeat(from, t);
      if ((nb - t) / from.rate < 0.12) nb += gridPeriod(from);
      var wait = (nb - t) / from.rate;
      // the incoming deck starts on its own nearest beat, so its beats land on the outgoing deck's beats
      if (!isPlaying(to)) {
        var startPos = Math.max(0, prevBeat(to, pos(to)));
        if (startPos < to.offset) startPos = to.offset;
        to.el.currentTime = startPos;
      }
      if (T.mode === "loop") {
        // loop the 4 beats that start on the current beat (always available, even right after the track began)
        var lp = 4 * beatLen(from), lin = Math.max(0, prevBeat(from, t));
        if (lin + lp > from.duration - 0.2) lin = Math.max(0, from.duration - 0.2 - lp);
        from.loop = { in: lin, out: lin + lp, on: true, beats: 4 };
        T.loopDeck = from; updateLoopTimer(); renderMarkers(from); renderLoopBtns(from);
      }
      T.phase = "wait"; T.startAt = performance.now() + wait * 1000;
      T.beats = S.len; T.dur = S.len * 60 / (from.bpm * from.rate) * 1000; T.x0 = S.xf;
      renderTrans(); kick();
    });
  }

  function stepTransition(now) {
    if (!T.active) return;
    if (T.phase === "wait") {
      if (now < T.startAt) return;
      var to = T.to, from = T.from;
      if (isPlaying(to)) alignPhase(to, from); else playDeck(to);
      T.phase = "fade"; T.t0 = now; T.fixAt = now + 450; T.fixed = false;
      renderTrans();
    }
    if (T.phase !== "fade") return;
    if (T.fixAt && now >= T.fixAt && !T.fixed && T.mode !== "fade") {       // one correction pass after the incoming deck's real start
      T.fixed = true;
      if (isPlaying(T.to) && isPlaying(T.from)) alignPhase(T.to, T.from);
    }
    var p = clamp((now - T.t0) / T.dur, 0, 1);
    setXf(T.x0 + (T.x1 - T.x0) * ease(p));
    if (p >= 1) {
      var done = T;
      T = { active: false };
      if (done.loopDeck) setLoopOn(done.loopDeck, false);
      if (isPlaying(done.from)) pauseDeck(done.from);
      renderTrans();
      toast("Transition complete \u2014 " + done.from.name + " paused");
    }
  }

  /* ----------------------------------------------------------------- main tick */
  function needTick() { return anyPlaying() || T.active || scratching(); }
  function kick() { if (!S.raf && needTick()) S.raf = requestAnimationFrame(tick); }
  function tick(now) {
    S.raf = 0;
    stepTransition(performance.now());
    if (S.open) {
      renderTime(decks.a); renderTime(decks.b);
      renderMeters();
      renderBeatInfo();
      renderTransProgress(performance.now());
    }
    if (needTick()) S.raf = requestAnimationFrame(tick);
    else if (S.open) { renderMeters(true); renderBeatInfo(); }
  }

  /* ------------------------------------------------------------------ rendering */
  function K(d, k) { return d.ui[k]; }
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }

  function renderTime(d, force) {
    if (!d.ui.cur) return;
    var t = pos(d), dur = d.duration;
    var sec = Math.floor(t * 10);
    if (force || d.last.sec !== sec) {
      d.last.sec = sec;
      setText(d.ui.cur, fmt(t)); setText(d.ui.rem, dur ? "-" + fmt(Math.max(0, dur - t)) : "-0:00"); setText(d.ui.dur, fmt(dur));
    }
    var f = dur ? clamp(t / dur, 0, 1) : 0, fk = Math.round(f * 2000);
    if (force || d.last.f !== fk) {
      d.last.f = fk;
      d.ui.played.style.clipPath = "inset(0 " + (100 - f * 100).toFixed(2) + "% 0 0)";
      d.ui.head.style.left = (f * 100).toFixed(2) + "%";
      if (!d.seeking) d.ui.seek.value = Math.round(f * 1000);
    }
    if (d.ui.disc) d.ui.disc.style.transform = "rotate(" + ((t / 1.8) % 1 * 360).toFixed(2) + "deg)";
    var on = isPlaying(d) && beatOK(d) && beatPhase(d, t) < 0.14;
    if (d.last.led !== on) { d.last.led = on; d.ui.led.classList.toggle("is-on", on); }
  }

  function renderMarkers(d) {
    if (!d.ui.cuemark) return;
    var dur = d.duration || 1;
    d.ui.cuemark.hidden = !(d.ready && d.cue > 0);
    d.ui.cuemark.style.left = (d.cue / dur * 100) + "%";
    var L = d.loop, has = d.ready && L.in != null;
    d.ui.loopreg.hidden = !has;
    if (has) {
      var out = L.out != null ? L.out : L.in;
      d.ui.loopreg.style.left = (L.in / dur * 100) + "%";
      d.ui.loopreg.style.width = (Math.max(0, out - L.in) / dur * 100) + "%";
      d.ui.loopreg.classList.toggle("is-on", L.on);
      d.ui.loopreg.classList.toggle("is-open", L.out == null);
    }
  }
  function renderLoopBtns(d) {
    if (!d.ui.root) return;
    var L = d.loop, set = L.in != null && L.out != null;
    d.ui.root.querySelectorAll("[data-beats]").forEach(function (b) { b.classList.toggle("is-on", L.on && L.beats === parseFloat(b.dataset.beats)); });
    d.ui.loopin.classList.toggle("is-on", L.in != null && L.out == null);
    d.ui.loopout.classList.toggle("is-on", L.on && L.beats === 0);
    d.ui.loopexit.textContent = L.on ? "EXIT" : "RELOOP";
    d.ui.loopexit.disabled = !d.ready || !(L.on || set);
    d.ui.loopexit.classList.toggle("is-on", L.on);
  }

  function renderWaveBase(d) {
    if (!d.ui.wave) return;
    var path = "M0,50 L1000,50";
    var has = !!d.peaks;
    if (has) {
      var cols = 500, top = "", bot = "", p = d.peaks;
      for (var i = 0; i < cols; i++) {
        var h = Math.max(p[i * 2], p[i * 2 + 1]), y = 2 + (1 - h) * 46;     // 2..48
        top += (i ? "L" : "M") + (i * 2) + "," + y.toFixed(1);
        bot = "L" + (i * 2) + "," + (100 - y).toFixed(1) + bot;
      }
      path = top + bot + "Z";
    }
    d.ui.wave.querySelectorAll("path").forEach(function (el) { el.setAttribute("d", path); el.classList.toggle("is-line", !has); });
    d.ui.hint.hidden = !(d.ready && !has);
    d.ui.hint.textContent = d.analyzing ? "Analyzing\u2026" : "Press ANALYZE for the waveform and BPM";
    d.ui.wave.classList.toggle("is-empty", !d.ready);
    renderMarkers(d);
    renderTime(d, true);
  }

  function stateLabel(d) {
    if (!d.file) return "EMPTY";
    if (!d.ready) return "LOADING";
    if (isPlaying(d)) return "PLAYING";
    return pos(d) > 0.05 ? "PAUSED" : "READY";
  }
  function audible(d) { var g = xfGains(S.xf); return isPlaying(d) && (d.id === "a" ? g.a : g.b) * d.vol > 0.1; }

  function renderAir() {
    [decks.a, decks.b].forEach(function (d) {
      if (!d.ui.air) return;
      var on = audible(d);
      d.ui.air.hidden = !on;
      d.ui.root.classList.toggle("is-air", on);
    });
  }

  function renderDeck(d) {
    var u = d.ui;
    if (!u.root) { return; }
    var st = stateLabel(d), playing = isPlaying(d);
    setText(u.state, st);
    u.root.classList.toggle("is-playing", playing);
    u.root.classList.toggle("is-scratching", !!d.scrOn);
    u.root.classList.toggle("is-empty", !d.file);
    setText(u.title, d.file ? d.title : "No track loaded");
    setText(u.artist, d.file ? (d.artist || "") : "Load a local audio file or drop one here");
    u.playicon.innerHTML = playing ? ICON.pause : ICON.play;
    u.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    var haveBpm = d.bpm > 0;
    setText(u.bpm, haveBpm ? (d.bpm * d.rate).toFixed(1) : "\u2014");
    var confTxt = d.analyzing ? "analyzing\u2026" : d.last.tapHint ? d.last.tapHint : !d.file ? "" : d.conf === "manual" ? "manual" : d.conf === "none" ? (d.an ? "no beat found" : "not analyzed") : d.conf === "low" ? "low confidence" : d.conf + " confidence";
    setText(u.conf, confTxt);
    u.conf.className = "dj-conf" + (d.conf === "low" || (d.an && d.conf === "none") ? " is-warn" : d.conf === "high" || d.conf === "manual" ? " is-good" : "");
    u.analyze.disabled = !d.ready || !!d.analyzing || !!d.an || d.manual;
    u.analyze.textContent = d.analyzing ? "ANALYZING\u2026" : (d.an || d.manual) ? "ANALYZED" : "ANALYZE";
    var beat = beatOK(d);
    u.half.disabled = !haveBpm; u.dbl.disabled = !haveBpm;
    u.tempoval.textContent = ((d.rate - 1) * 100 >= 0 ? "+" : "") + ((d.rate - 1) * 100).toFixed(1) + "%";
    u.sync.disabled = !d.ready || !other(d).ready;
    u.tap.disabled = !d.ready;
    ["cue", "stop", "loopin", "loopout", "backspin", "reverse", "brake", "spinup", "slow"].forEach(function (k) { if (u[k]) u[k].disabled = !d.ready; });
    u.root.querySelectorAll("[data-beats]").forEach(function (b) { b.disabled = !d.ready; b.title = beat ? "Loop " + b.dataset.beats + " beat(s) from the current beat" : "Needs a beat grid \u2014 analyzes the track first"; });
    u.play.disabled = !d.ready; u.discbtn.disabled = !d.ready;
    u.seek.disabled = !d.ready;
    u.unload.disabled = !d.file;
    u.kl.checked = d.keyLock;
    renderLoopBtns(d);
    renderAir();
    renderTime(d, true);
    renderTrans();
  }

  function renderMeters(zero) {
    if (!E) return;
    var buf = renderMeters.buf || (renderMeters.buf = new Uint8Array(128));
    function level(an) {
      if (zero) return 0;
      an.getByteTimeDomainData(buf);
      var pk = 0;
      for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i] - 128); if (v > pk) pk = v; }
      return pk / 128;
    }
    [decks.a, decks.b].forEach(function (d) {
      if (!d.n || !d.ui.meter) return;
      var l = level(d.n.meter), prev = d.last.m || 0;
      l = l > prev ? l : prev * 0.88;
      d.last.m = l;
      d.ui.meterfill.style.transform = "scaleX(" + Math.min(1, l * 1.4).toFixed(3) + ")";
    });
    if ($.mmeter) {
      var m = level(E.meter), pm = renderMeters.m || 0; m = m > pm ? m : pm * 0.88; renderMeters.m = m;
      $.mmeterfill.style.transform = "scaleX(" + Math.min(1, m * 1.4).toFixed(3) + ")";
    }
  }

  function renderBeatInfo() {
    if (!$.offset) return;
    var a = decks.a, b = decks.b, txt = "\u2014", cls = "";
    if (isPlaying(a) && isPlaying(b) && beatOK(a) && beatOK(b)) {
      var ratio = (a.bpm * a.rate * a.oct) / (b.bpm * b.rate * b.oct);
      if (Math.abs(ratio - 1) > 0.002) { txt = "tempos differ " + ((ratio - 1) * 100).toFixed(1) + "%"; cls = "is-warn"; }
      else {
        var ms = Math.round(phaseOffsetMs(a, b) / 2) * 2;
        txt = (ms > 0 ? "+" : "") + ms + " ms"; cls = Math.abs(ms) <= 15 ? "is-good" : "is-warn";
      }
    }
    setText($.offset, txt);
    $.offset.className = "dj-offset__val " + cls;
  }

  function renderTrans() {
    if (!$.transstate) return;
    var busy = T.active;
    $.cancel.hidden = !busy;
    $.toA.disabled = busy; $.toB.disabled = busy;
    $.mode.disabled = busy; $.len.disabled = busy;
    $.transbar.hidden = !busy;
    if (!busy) setText($.transstate, "Idle");
    else if (T.phase === "prep") setText($.transstate, "Analyzing / matching tempo\u2026");
    else if (T.phase === "wait") setText($.transstate, "Waiting for the next beat\u2026");
    else setText($.transstate, T.from.name + " \u2192 " + T.to.name);
    renderTransProgress(performance.now());
  }
  function renderTransProgress(now) {
    if (!$.transfill) return;
    var p = 0;
    if (T.active && T.phase === "fade") p = clamp((now - T.t0) / T.dur, 0, 1);
    $.transfill.style.transform = "scaleX(" + p.toFixed(3) + ")";
    if (T.active && T.phase === "fade") {
      var left = Math.max(0, T.dur - (now - T.t0)) / 1000;
      setText($.transstate, T.from.name + " \u2192 " + T.to.name + " \u00b7 " + left.toFixed(0) + "s left");
    }
  }

  function renderSide() {
    var panel = document.getElementById("panel-dj");
    if (!panel) return;
    function line(d) {
      return '<div class="dj-side__deck' + (isPlaying(d) ? " is-playing" : "") + '"><b>' + d.name + '</b><span>' +
        esc(d.file ? d.title : "empty") + '</span><i>' + stateLabel(d).toLowerCase() + '</i></div>';
    }
    panel.innerHTML =
      '<div class="radio-side">' +
        '<p class="radio-side__intro">Two decks, a crossfader, loops, effects and beat-aware transitions for your local audio files. ' +
        'Beat features only use a tempo that was really measured from the file (or tapped by you).</p>' +
        line(decks.a) + line(decks.b) +
      '</div>';
  }

  /* ------------------------------------------------------------------ screen UI */
  var ICON = {
    play: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>',
    pause: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/></svg>',
    stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    cue: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 4v16M9 5l11 7-11 7V5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    file: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.1a1 1 0 0 1 .8.4l1.2 1.6h6A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    dj: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="12" r="5.6" stroke="currentColor" stroke-width="1.8"/><circle cx="8" cy="12" r="1.4" fill="currentColor"/><circle cx="17.5" cy="9" r="3.4" stroke="currentColor" stroke-width="1.8"/><path d="M17.5 14.5V21M14.8 18h5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  function fxRow(f) {
    return '<label class="dj-fx" data-fxrow="' + f.k + '"><span class="dj-fx__head"><span>' + f.label + '</span><b data-fxval="' + f.k + '"></b></span>' +
      '<input type="range" data-fx="' + f.k + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + f.def + '" aria-label="' + f.label + '"></label>';
  }
  function deckHTML(d) {
    var id = d.id.toUpperCase();
    var loopBtns = LOOP_BEATS.map(function (b) { return '<button type="button" class="dj-btn dj-btn--sm" data-beats="' + b + '">' + (b === 0.5 ? "\u00bd" : b) + '</button>'; }).join("");
    return '' +
      '<section class="dj-deck" data-deck="' + d.id + '" aria-label="' + d.name + '">' +
        '<header class="dj-deck__head">' +
          '<span class="dj-chip">DECK ' + id + '</span>' +
          '<span class="dj-state" data-k="state">EMPTY</span>' +
          '<span class="dj-air" data-k="air" hidden>ON AIR</span>' +
          '<span class="dj-led" data-k="led" title="Beat indicator (from the analyzed beat grid)"></span>' +
        '</header>' +
        '<div class="dj-info">' +
          '<div class="dj-info__text"><div class="dj-title" data-k="title">No track loaded</div><div class="dj-artist" data-k="artist"></div></div>' +
          '<div class="dj-bpm"><b data-k="bpm">\u2014</b><span>BPM</span><em data-k="conf" class="dj-conf"></em></div>' +
        '</div>' +
        '<button type="button" class="dj-discwrap" data-k="discbtn" data-act="play" aria-label="Play / pause ' + d.name + '" title="Play / pause">' +
          '<span class="dj-disc" data-k="disc"><span class="dj-disc__label"><b>' + id + '</b></span><span class="dj-disc__mark"></span></span>' +
          '<span class="dj-disc__sheen"></span><span class="dj-disc__spindle"></span>' +
        '</button>' +
        '<div class="dj-wave is-empty" data-k="wave">' +
          '<svg viewBox="0 0 1000 100" preserveAspectRatio="none" class="dj-wave__base" aria-hidden="true"><path d="M0,50 L1000,50"/></svg>' +
          '<svg viewBox="0 0 1000 100" preserveAspectRatio="none" class="dj-wave__played" data-k="played" aria-hidden="true"><path d="M0,50 L1000,50"/></svg>' +
          '<div class="dj-loopreg" data-k="loopreg" hidden></div>' +
          '<div class="dj-cuemark" data-k="cuemark" hidden title="Cue point"></div>' +
          '<div class="dj-playhead" data-k="head"></div>' +
          '<div class="dj-wave__hint" data-k="hint" hidden></div>' +
          '<input type="range" class="dj-wave__seek" data-k="seek" min="0" max="1000" value="0" step="1" aria-label="Seek ' + d.name + '" disabled>' +
        '</div>' +
        '<div class="dj-time"><span data-k="cur">0:00</span><span class="dj-time__rem" data-k="rem">-0:00</span><span data-k="dur">0:00</span></div>' +
        '<div class="dj-transport">' +
          '<button type="button" class="dj-btn dj-btn--cue" data-k="cue" aria-label="Cue" title="Cue: jump to the cue point. When stopped on it, hold to preview; elsewhere, sets the cue point here">' + ICON.cue + '<span>CUE</span></button>' +
          '<button type="button" class="dj-btn dj-btn--play" data-k="play" data-act="play" aria-label="Play"><span data-k="playicon">' + ICON.play + '</span></button>' +
          '<button type="button" class="dj-btn" data-k="stop" data-act="stop" aria-label="Stop" title="Stop and return to the start">' + ICON.stop + '</button>' +
          '<span class="dj-spacer"></span>' +
          '<button type="button" class="dj-btn dj-btn--load" data-act="load">' + ICON.file + '<span>Load</span></button>' +
          '<button type="button" class="dj-btn dj-btn--icon" data-k="unload" data-act="unload" aria-label="Eject track" title="Eject">' + ICON.x + '</button>' +
        '</div>' +
        '<div class="dj-libpick"><select data-k="libsel" aria-label="Load ' + d.name + ' from library"><option value="">Load from library\u2026</option></select></div>' +
        '<div class="dj-group"><div class="dj-group__label">Scratch &amp; vinyl</div>' +
          '<div class="dj-row">' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="backspin" data-act="backspin" title="Spin the record backwards fast, then drop back in">BACKSPIN</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="reverse" title="Hold to play the song in reverse">\u23EA REVERSE</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="brake" data-act="brake" title="Vinyl stop: slows down like a turntable losing power">BRAKE</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="spinup" data-act="spinup" title="Start like a platter winding up">SPIN-UP</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="slow" data-act="slow" title="Slow-motion: half speed">SLOW-MO \u00bd</button>' +
          '</div>' +
          '<div class="dj-scrnote" data-k="scrnote">Drag the disc to scratch: drag backwards to hear the song in reverse. Mouse wheel over the disc also scratches.</div>' +
        '</div>' +
        '<div class="dj-group"><div class="dj-group__label">Loop</div><div class="dj-row">' +
          '<button type="button" class="dj-btn dj-btn--sm" data-k="loopin" data-act="loopin" title="Set loop start at the current position">IN</button>' +
          '<button type="button" class="dj-btn dj-btn--sm" data-k="loopout" data-act="loopout" title="Set loop end here and start looping">OUT</button>' +
          '<button type="button" class="dj-btn dj-btn--sm" data-k="loopexit" data-act="loopexit">RELOOP</button>' +
          '<span class="dj-sep"></span>' + loopBtns +
        '</div></div>' +
        '<div class="dj-group"><div class="dj-group__label">Tempo &amp; beat</div>' +
          '<div class="dj-row dj-row--tempo"><input type="range" data-k="tempo" min="-12" max="12" step="0.1" value="0" aria-label="Tempo"><b class="dj-tempoval" data-k="tempoval">+0.0%</b>' +
            '<button type="button" class="dj-btn dj-btn--sm" data-act="temporeset" title="Back to the original tempo">0</button></div>' +
          '<div class="dj-row">' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="sync" data-act="sync" title="Match tempo to the other deck and line up the beats">SYNC</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="analyze" data-act="analyze" title="Measure the BPM and beat grid, and draw the waveform (once per track)">ANALYZE</button>' +
            '<button type="button" class="dj-btn dj-btn--sm dj-btn--wide" data-k="tap" data-act="tap" title="Tap along to the beat while the track plays">TAP</button>' +
            '<button type="button" class="dj-btn dj-btn--sm" data-k="half" data-act="half" title="Detected tempo is double the real one: halve it">\u00bd\u00d7</button>' +
            '<button type="button" class="dj-btn dj-btn--sm" data-k="dbl" data-act="dbl" title="Detected tempo is half the real one: double it">2\u00d7</button>' +
            '<label class="dj-check" title="Keep the pitch when the tempo changes"><input type="checkbox" data-k="kl" checked><span>Key lock</span></label>' +
          '</div></div>' +
        '<div class="dj-group"><div class="dj-group__label">Deck volume</div>' +
          '<div class="dj-row"><input type="range" data-k="vol" min="0" max="100" step="1" value="85" aria-label="' + d.name + ' volume"><b class="dj-volval" data-k="volval">85%</b></div>' +
          '<div class="dj-meter" data-k="meter" aria-hidden="true"><i data-k="meterfill"></i></div></div>' +
        '<div class="dj-group"><div class="dj-group__label dj-group__label--row"><span>Effects</span><button type="button" class="link-btn" data-act="fxreset">Reset effects</button></div>' +
          '<div class="dj-fxgrid">' + FX.map(fxRow).join("") + '</div>' +
          '<div class="dj-row"><button type="button" class="dj-btn dj-btn--sm" data-act="delaybeat" title="Set the delay to half a beat at this deck\\u2019s tempo">Delay = \u00bd beat</button></div>' +
        '</div>' +
      '</section>';
  }

  function build() {
    if (S.built) return;
    S.built = true;
    $.screen.innerHTML =
      '<div class="dj-wrap">' +
        '<header class="dj-head"><div><div class="dj-kicker"><span class="dj-kicker__ico" aria-hidden="true">'+ICON.dj+'</span> DJ MODE</div>' +
          '<h2 class="dj-heading">Two decks. One crossfader.</h2></div>' +
          '<div class="dj-head__note" id="djNote"></div></header>' +
        '<div class="dj-grid">' + deckHTML(decks.a) + mixerHTML() + deckHTML(decks.b) + '</div>' +
        (window.GhostDJPro ? window.GhostDJPro.rackHTML() : '') +
        '<input type="file" id="djFile" accept="audio/*" hidden />' +
      '</div>';

    $.file = document.getElementById("djFile");
    $.note = document.getElementById("djNote");
    [decks.a, decks.b].forEach(function (d) {
      var root = $.screen.querySelector('[data-deck="' + d.id + '"]');
      d.ui = { root: root };
      root.querySelectorAll("[data-k]").forEach(function (el) { d.ui[el.dataset.k] = el; });
    });
    var q = function (id) { return document.getElementById(id); };
    $.xf = q("djXf"); $.master = q("djMaster"); $.masterval = q("djMasterVal"); $.mmeter = q("djMMeter"); $.mmeterfill = q("djMMeterFill");
    $.mode = q("djMode"); $.len = q("djLen"); $.toA = q("djToA"); $.toB = q("djToB"); $.cancel = q("djCancel");
    $.transstate = q("djTransState"); $.transbar = q("djTransBar"); $.transfill = q("djTransFill"); $.offset = q("djOffset"); $.modehint = q("djModeHint");

    $.mode.value = S.mode;
    fillLenOptions();
    $.master.value = Math.round(S.master * 100); $.masterval.textContent = Math.round(S.master * 100) + "%";
    $.xf.value = Math.round(S.xf * 1000);

    // ---- per-deck wiring (delegated)
    [decks.a, decks.b].forEach(function (d) {
      var root = d.ui.root;
      root.addEventListener("click", function (e) {
        var b = e.target.closest("[data-act], [data-beats]");
        if (!b || !root.contains(b) || b.disabled) return;
        if (d.suppressClick && b.dataset.act === "play") { d.suppressClick = false; return; }
        if (b.dataset.beats) { beatLoop(d, parseFloat(b.dataset.beats)); return; }
        switch (b.dataset.act) {
          case "load": pendingDeck = d; $.file.click(); break;
          case "unload": unloadDeck(d); break;
          case "play": togglePlay(d); break;
          case "stop": stopDeck(d); break;
          case "loopin": loopIn(d); break;
          case "loopout": loopOut(d); break;
          case "loopexit": loopExit(d); break;
          case "analyze": ensureAnalysis(d); break;
          case "tap": tap(d); break;
          case "sync": syncDeck(d); break;
          case "temporeset": setRate(d, 1); d.oct = 1; break;
          case "half": if (d.bpm > 0) { d.bpm = Math.round(d.bpm / 2 * 100) / 100; renderDeck(d); } break;
          case "dbl": if (d.bpm > 0) { d.bpm = Math.round(d.bpm * 2 * 100) / 100; renderDeck(d); } break;
          case "backspin": backspin(d); break;
          case "brake": brake(d); break;
          case "spinup": spinUp(d); break;
          case "slow": setSlow(d, !d.slow); break;
          case "fxreset": FX.forEach(function (f) { d.fx[f.k] = f.def; applyFx(d, f.k); }); syncFxUI(d); break;
          case "delaybeat":
            if (!beatOK(d)) { toast("Needs a beat grid \u2014 ANALYZE the track or TAP the tempo first"); break; }
            var ms = clamp(Math.round(30000 / (d.bpm * d.rate)), 50, 1000);
            d.fx.delay = ms; applyFx(d, "delay"); syncFxUI(d);
            break;
        }
      });
      // cue: press / release
      var cue = d.ui.cue;
      cue.addEventListener("pointerdown", function (e) { if (e.button > 0) return; e.preventDefault(); d.cueHeld = true; try { cue.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } cueDown(d, false); });
      ["pointerup", "pointercancel"].forEach(function (ev) { cue.addEventListener(ev, function () { if (d.cueHeld) { d.cueHeld = false; cueUp(d); } }); });
      cue.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!e.repeat) cueDown(d, true); } });
      wireJog(d);
      // seek
      var sk = d.ui.seek;
      sk.addEventListener("pointerdown", function () { d.seeking = true; });
      ["pointerup", "pointercancel", "blur"].forEach(function (ev) { sk.addEventListener(ev, function () { d.seeking = false; }); });
      sk.addEventListener("input", function () { if (d.ready) { seekTo(d, sk.value / 1000 * d.duration); renderTime(d, true); } });
      // tempo, volume, key lock
      d.ui.tempo.addEventListener("input", function () { setRate(d, 1 + parseFloat(d.ui.tempo.value) / 100); });
      d.ui.tempo.addEventListener("dblclick", function () { setRate(d, 1); });
      d.ui.vol.addEventListener("input", function () { d.vol = d.ui.vol.value / 100; d.ui.volval.textContent = d.ui.vol.value + "%"; applyVol(d); renderAir(); });
      d.ui.kl.addEventListener("change", function () { setKeyLock(d, d.ui.kl.checked); });
      // effects
      root.querySelectorAll("[data-fx]").forEach(function (inp) {
        var k = inp.dataset.fx, f = FX.filter(function (x) { return x.k === k; })[0];
        inp.addEventListener("input", function () { d.fx[k] = parseFloat(inp.value); applyFx(d, k); syncFxVal(d, k); });
        inp.addEventListener("dblclick", function () { inp.value = f.def; d.fx[k] = f.def; applyFx(d, k); syncFxVal(d, k); });
      });
      // library picker
      d.ui.libsel.addEventListener("change", function () {
        var id = d.ui.libsel.value; d.ui.libsel.value = "";
        var c = core(), item = c && c.getItems().filter(function (m) { return m.id === id; })[0];
        if (item && item.file) loadDeck(d, item.file);
      });
      FX.forEach(function (f) { syncFxVal(d, f.k); });
    });

    // ---- mixer wiring
    $.xf.addEventListener("input", function () { if (T.active) cancelTransition(true); setXf($.xf.value / 1000); });
    $.xf.addEventListener("dblclick", function () { if (T.active) cancelTransition(true); setXf(0.5); });
    $.screen.querySelectorAll("[data-xfsnap]").forEach(function (b) {
      b.addEventListener("click", function () { if (T.active) cancelTransition(true); setXf(parseFloat(b.dataset.xfsnap)); });
    });
    $.master.addEventListener("input", function () {
      S.master = $.master.value / 100; $.masterval.textContent = $.master.value + "%";
      if (E) E.master.gain.setTargetAtTime(S.master, E.ctx.currentTime, 0.02);
      savePrefs();
    });
    $.mode.addEventListener("change", function () { S.mode = $.mode.value; fillLenOptions(); savePrefs(); });
    $.len.addEventListener("change", function () { S.len = parseFloat($.len.value); savePrefs(); });
    $.toA.addEventListener("click", function () { startTransition("a"); });
    $.toB.addEventListener("click", function () { startTransition("b"); });
    $.cancel.addEventListener("click", function () { cancelTransition(false); });
    if (window.GhostDJPro && window.GhostDSP) {
      window.GhostDJPro.wireRack($.screen.querySelector("#djRack"), {
        engine: engine, toast: toast, claim: claimOutput,
        isOpen: function () { return S.open; },
        deckBpm: function (id) { var d = decks[id]; return d && d.bpm > 0 ? d.bpm * d.rate : 0; },
        setLoudness: function (m) {
          var e = engine(); if (!e) return;
          e.loud.gain.setTargetAtTime(m, e.ctx.currentTime, 0.05);
          e.limiter.threshold.setTargetAtTime(m > 1 ? -7 : -2, e.ctx.currentTime, 0.05);
          e.limiter.attack.value = m > 1 ? 0.001 : 0.003;
        }
      });
    }
    $.file.addEventListener("change", function () {
      var f = $.file.files && $.file.files[0], d = pendingDeck; $.file.value = ""; pendingDeck = null;
      if (f && d) loadDeck(d, f);
    });

    // one sound source at a time: the normal player starting pauses the decks
    var c = core();
    if (c && c.player) [c.player.audioEl, c.player.videoEl].forEach(function (el) {
      el.addEventListener("play", function () { [decks.a, decks.b].forEach(function (d) { if (isPlaying(d)) pauseDeck(d); }); cancelTransition(true); });
    });
    document.addEventListener("ghost:librarychange", function () { if (S.built) fillLibraryPickers(); });

    [decks.a, decks.b].forEach(function (d) { renderDeck(d); renderWaveBase(d); syncFxUI(d); });
    renderTrans(); renderBeatInfo();
    var fx = window.GhostAudioFX;
    if (!fx || !fx.isSupported()) $.note.textContent = "The Web Audio API isn't available here, so DJ Mode can't play.";
  }
  var pendingDeck = null;

  function mixerHTML() {
    return '' +
      '<section class="dj-mixer" aria-label="Mixer">' +
        '<div class="dj-group"><div class="dj-group__label">Crossfader</div>' +
          '<div class="dj-xf"><span class="dj-xf__end">A</span>' +
            '<input type="range" id="djXf" min="0" max="1000" step="1" value="500" aria-label="Crossfader A to B">' +
            '<span class="dj-xf__end">B</span></div>' +
          '<div class="dj-row dj-row--center">' +
            '<button type="button" class="dj-btn dj-btn--sm" data-xfsnap="0">A</button>' +
            '<button type="button" class="dj-btn dj-btn--sm" data-xfsnap="0.5">CENTER</button>' +
            '<button type="button" class="dj-btn dj-btn--sm" data-xfsnap="1">B</button></div>' +
          '<p class="dj-hint">Equal-power curve. Double-click to center.</p></div>' +
        '<div class="dj-group"><div class="dj-group__label">Master</div>' +
          '<div class="dj-row"><input type="range" id="djMaster" min="0" max="100" step="1" value="90" aria-label="Master volume"><b class="dj-volval" id="djMasterVal">90%</b></div>' +
          '<div class="dj-meter dj-meter--master" id="djMMeter" aria-hidden="true"><i id="djMMeterFill"></i></div></div>' +
        '<div class="dj-group"><div class="dj-group__label">Transition</div>' +
          '<div class="dj-row dj-row--stack">' +
            '<select id="djMode" aria-label="Transition type">' +
              '<option value="fade">Crossfade (time)</option>' +
              '<option value="beat">Beat-synced crossfade</option>' +
              '<option value="loop">Loop + beat-synced crossfade</option></select>' +
            '<select id="djLen" aria-label="Transition length"></select></div>' +
          '<p class="dj-hint" id="djModeHint"></p>' +
          '<div class="dj-row dj-row--center">' +
            '<button type="button" class="dj-btn dj-btn--go" id="djToB">A \u2192 B</button>' +
            '<button type="button" class="dj-btn dj-btn--go" id="djToA">B \u2192 A</button></div>' +
          '<div class="dj-trans"><div class="dj-trans__state" id="djTransState">Idle</div>' +
            '<div class="dj-trans__bar" id="djTransBar" hidden><i id="djTransFill"></i></div>' +
            '<button type="button" class="dj-btn dj-btn--sm" id="djCancel" hidden>Cancel</button></div></div>' +
        '<div class="dj-group"><div class="dj-group__label">Beat offset (B vs A)</div>' +
          '<div class="dj-offset"><b class="dj-offset__val" id="djOffset">\u2014</b></div>' +
          '<p class="dj-hint">Measured live from the decks\u2019 beat grids when both are playing. Approximate \u2014 within a few ms at best.</p></div>' +
      '</section>';
  }

  function fillLenOptions() {
    var beat = S.mode !== "fade", opts = beat ? [4, 8, 16, 32] : [2, 4, 8, 16, 32];
    if (opts.indexOf(S.len) === -1) S.len = beat ? 16 : 8;
    $.len.innerHTML = opts.map(function (v) { return '<option value="' + v + '"' + (v === S.len ? " selected" : "") + '>' + v + (beat ? " beats" : " seconds") + '</option>'; }).join("");
    $.modehint.textContent = S.mode === "fade"
      ? "Smooth crossfade over the chosen time. Starts the incoming deck if it is stopped; the outgoing deck is paused at the end."
      : S.mode === "beat"
        ? "Matches the incoming tempo, starts it on the outgoing deck\u2019s next beat and fades over whole beats. Needs a clear beat on both decks (analyzed on demand)."
        : "Like beat-synced, but the outgoing deck loops its last 4 beats while fading so it never runs out. Needs a clear beat on both decks.";
  }

  function fillLibraryPickers() {
    var c = core(); if (!c) return;
    var items = c.getItems().filter(function (m) { return m.kind === "audio"; });
    [decks.a, decks.b].forEach(function (d) {
      var sel = d.ui.libsel; if (!sel) return;
      sel.innerHTML = '<option value="">Load from library\u2026</option>' + items.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join("");
      sel.disabled = !items.length;
      sel.title = items.length ? "" : "Open audio files in the player first, or use Load / drag and drop";
    });
  }

  function syncFxVal(d, k) {
    var el = d.ui.root.querySelector('[data-fxval="' + k + '"]'), v = d.fx[k], row = d.ui.root.querySelector('[data-fxrow="' + k + '"]');
    if (!el) return;
    var txt;
    switch (k) {
      case "trim": case "bass": case "treble": txt = (v > 0 ? "+" : "") + v.toFixed(1) + " dB"; break;
      case "filter": txt = v === 0 ? "off" : v < 0 ? "LP " + Math.round(20000 * Math.pow(80 / 20000, -v / 100)) + " Hz" : "HP " + Math.round(20 * Math.pow(400, v / 100)) + " Hz"; break;
      case "delay": txt = v + " ms"; break;
      default: txt = Math.round(v) + "%";
    }
    el.textContent = txt;
    var f = FX.filter(function (x) { return x.k === k; })[0];
    row.classList.toggle("is-hot", v !== f.def);
  }
  function syncFxUI(d) {
    FX.forEach(function (f) { var inp = d.ui.root.querySelector('[data-fx="' + f.k + '"]'); inp.value = d.fx[f.k]; syncFxVal(d, f.k); });
  }

  /* ------------------------------------------------------------------ drop */
  function handleDrop(e) {
    if (!S.open || !e.dataTransfer || !e.dataTransfer.files) return false;
    var files = [].slice.call(e.dataTransfer.files).filter(isAudioFile);
    if (!files.length) { toast("Drop audio files onto a deck"); return true; }
    var el = document.elementFromPoint(e.clientX, e.clientY), deckEl = el && el.closest ? el.closest("[data-deck]") : null;
    if (deckEl) { loadDeck(decks[deckEl.dataset.deck], files[0]); return true; }
    if (files.length >= 2) { loadDeck(decks.a, files[0]); loadDeck(decks.b, files[1]); }
    else loadDeck(!decks.a.file ? decks.a : !decks.b.file ? decks.b : decks.a, files[0]);
    return true;
  }

  /* ---------------------------------------------------------------- open / leave */
  function open() { if (window.GhostScreens) window.GhostScreens.show("dj"); }
  function leave() { if (window.GhostScreens) window.GhostScreens.hide("dj"); }
  function onShow() {
    build();
    S.open = true;
    fillLibraryPickers();
    [decks.a, decks.b].forEach(function (d) { renderDeck(d); renderWaveBase(d); });
    renderBeatInfo(); renderSide();
    kick();
  }
  function onHide() { S.open = false; }       // decks keep playing; only the screen closes

  function init() {
    $.screen = document.getElementById("djScreen");
    if (!$.screen || !window.GhostScreens) return;
    window.GhostScreens.register("dj", { el: $.screen, title: "DJ Mode", onShow: onShow, onHide: onHide });
    document.querySelectorAll(".navitem").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.panel;
        if (p === "dj") open();
        else if (p === "library" || p === "recent" || p === "radio" || p === "lyrics") leave();
      });
    });
    // While the DJ screen is up the player shortcuts (which would drive the hidden player) are swallowed.
    window.addEventListener("keydown", function (e) {
      if (!S.open) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      var dlg = document.getElementById("dialog"); if (dlg && !dlg.hidden) return;
      if ((e.key === " " || e.key === "Enter") && e.target.closest && e.target.closest("button")) return;
      if (/^(\s|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|m|M|f|F|n|N|p|P|l|L)$/.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    renderSide();
  }

  window.GhostDJ = {
    open: open, leave: leave, handleDrop: handleDrop,
    isOpen: function () { return S.open; },
    // exposed for the automated tests; the UI never needs them
    _t: { decks: decks, state: S, engine: function () { return E; }, trans: function () { return T; }, loadDeck: loadDeck, xfGains: xfGains, beatPhase: beatPhase, phaseOffsetMs: phaseOffsetMs }
  };

  document.addEventListener("DOMContentLoaded", init);
})();
