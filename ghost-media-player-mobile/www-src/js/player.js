/* Ghost Media Player — playback engine
 * Wraps the active <video>/<audio> element with one small, consistent API
 * so the UI layer doesn't need to know which element is active.
 */
(function (global) {
  "use strict";

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return h > 0 ? (h + ":" + pad(m) + ":" + pad(s)) : (m + ":" + pad(s));
  }

  // Desktop app only: find out once whether ffmpeg conversion is available (undefined until known).
  if (global.ghostStream && global.ghostStream.ffmpeg) {
    try { global.ghostStream.ffmpeg().then(function (r) { global.ghostFfmpegOk = !!(r && r.ok); }, function () { global.ghostFfmpegOk = false; }); } catch (e) { /* ignore */ }
  }

  function GhostPlayer(videoEl, audioEl) {
    this.videoEl = videoEl;
    this.audioEl = audioEl;
    this.activeEl = null;
    this.listeners = {};
    this.rate = 1;
    this.loopOne = false;
    this.loadSeq = 0;
    this.volume = 1;
    this.muted = false;
    this.curSpec = "";
    this.triedTv = false;

    this._bind(videoEl);
    this._bind(audioEl);
  }

  GhostPlayer.prototype._bind = function (el) {
    var self = this;
    el.addEventListener("timeupdate", function () { self._emit("timeupdate"); });
    el.addEventListener("durationchange", function () { self._emit("timeupdate"); });
    el.addEventListener("progress", function () { self._emit("progress"); });
    el.addEventListener("play", function () { self._emit("play"); });
    el.addEventListener("playing", function () { self._emit("playing"); });
    el.addEventListener("pause", function () { self._emit("pause"); });
    el.addEventListener("ended", function () { self._emit("ended"); });
    el.addEventListener("volumechange", function () { self._emit("volumechange"); });
    el.addEventListener("error", function () {
      // Video-to-video (or audio-to-audio) switches reuse the same element, so a
      // stale error event queued for a previous, already-replaced source can
      // arrive after a new one has loaded. Guard with a load generation token
      // so only an error for the *current* load is treated as real.
      var mySeq = parseInt(el.getAttribute("data-load-seq") || "-1", 10);
      if (el === self.activeEl && el.getAttribute("data-active") === "1" && mySeq === self.loadSeq) {
        if (self._tvFallback(el)) return;          // live TV / network stream: let ffmpeg convert it and retry once
        self._emit("error", el.error);
      }
    });
    el.addEventListener("waiting", function () { self._emit("waiting"); });
    el.addEventListener("stalled", function () { if (el.readyState < 3) self._emit("waiting"); });
    el.addEventListener("loadstart", function () {
      if (el === self.activeEl) self._emit("loading");
    });
    el.addEventListener("canplay", function () { self._emit("canplay"); });
    el.addEventListener("loadedmetadata", function () { self._emit("canplay"); });
  };

  GhostPlayer.prototype.on = function (evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    return this;
  };
  GhostPlayer.prototype._emit = function (evt, data) {
    (this.listeners[evt] || []).forEach(function (fn) { fn(data); });
  };

  GhostPlayer.prototype._killHls = function () {
    if (this.hls) { try { this.hls.destroy(); } catch (e) { /* ignore */ } this.hls = null; }
  };

  // Network streams the browser engine cannot decode (HEVC, MPEG-2, MP3-in-TS, odd containers, a failing HLS feed)
  // are retried ONCE through ffmpeg (desktop app, see electron/main.js: ghost-tv://). Returns true when a retry started.
  GhostPlayer.prototype._tvFallback = function (el) {
    var gs = global.ghostStream, spec = this.curSpec || "";
    if (this.triedTv || !gs || !gs.tvUrl || global.ghostFfmpegOk === false) return false;
    var url = "", opt = {}, i;
    if (/^hls:/i.test(spec)) {
      url = spec.replace(/^hls:/i, ""); i = url.indexOf("#ghost=");
      if (i >= 0) { try { opt = JSON.parse(decodeURIComponent(url.slice(i + 7))); } catch (e) { /* ignore */ } url = url.slice(0, i); }
    } else if (/^ghost-stream:/i.test(spec)) {
      try { var q = new URL(spec).searchParams; url = q.get("u") || ""; opt = { ref: q.get("r") || "", ua: q.get("a") || "" }; } catch (e) { return false; }
    } else return false;
    if (!/^https?:\/\//i.test(url)) return false;
    this.triedTv = true;
    this._killHls();
    this.loadSeq++;
    el.setAttribute("data-load-seq", String(this.loadSeq));
    el.crossOrigin = "anonymous";
    el.src = gs.tvUrl(url, opt, el === this.audioEl ? "audio" : "video");
    el.playbackRate = this.rate;
    this._emit("loading");
    var p = el.play(); if (p && p.catch) p.catch(function () { /* user gesture may be needed */ });
    return true;
  };

  // "hls:<url>[#ghost=<json>]" items are played by the built-in HLS engine (live TV channels etc.)
  GhostPlayer.prototype._startHls = function (el, spec) {
    var self = this, opt = {}, url = spec.replace(/^hls:/i, ""), i = url.indexOf("#ghost=");
    if (i >= 0) { try { opt = JSON.parse(decodeURIComponent(url.slice(i + 7))); } catch (e) { /* ignore */ } url = url.slice(0, i); }
    var seq = this.loadSeq;
    var noTv = "This channel needs ffmpeg to be converted. Linux: sudo apt install ffmpeg  (or run npm install again so the bundled one downloads).";
    function failed(msg) {
      if (self.loadSeq !== seq) return;
      if (self._tvFallback(el)) return;
      self._emit("error", { code: 4, message: global.ghostStream && global.ghostFfmpegOk === false ? msg + " " + noTv : msg });
    }
    if (!global.GhostHLS || !global.GhostHLS.supported) { setTimeout(function () { failed("This engine can't play HLS streams."); }, 0); return; }
    this.hls = new global.GhostHLS(el, url, {
      wrap: global.ghostStream ? function (u) { return global.ghostStream.proxyUrl(u, opt); } : null,
      onFatal: failed
    });
  };

  GhostPlayer.prototype.loadKind = function (kind, url) {
    this._killHls();
    this.curSpec = url; this.triedTv = false;
    var incoming = kind === "video" ? this.videoEl : this.audioEl;
    var outgoing = kind === "video" ? this.audioEl : this.videoEl;

    outgoing.pause();
    outgoing.removeAttribute("src");
    outgoing.removeAttribute("data-active");
    try { outgoing.load(); } catch (e) { /* ignore */ }

    this.loadSeq++;
    incoming.setAttribute("data-active", "1");
    incoming.setAttribute("data-load-seq", String(this.loadSeq));
    incoming.preload = "auto";
    if (/^ghost-(iso|stream):/i.test(url) || /^hls:/i.test(url)) incoming.crossOrigin = "anonymous"; else incoming.removeAttribute("crossorigin");
    if (/^hls:/i.test(url)) this._startHls(incoming, url); else incoming.src = url;
    incoming.playbackRate = this.rate;
    incoming.loop = this.loopOne;
    this.activeEl = incoming;
    return incoming;
  };

  GhostPlayer.prototype.play = function () {
    if (!this.activeEl) return Promise.resolve();
    var p = this.activeEl.play();
    return p && p.catch ? p.catch(function () { /* autoplay blocked — user gesture required */ }) : Promise.resolve();
  };
  GhostPlayer.prototype.pause = function () { if (this.activeEl) this.activeEl.pause(); };
  GhostPlayer.prototype.togglePlay = function () {
    if (!this.activeEl) return;
    if (this.activeEl.paused) this.play(); else this.pause();
  };
  GhostPlayer.prototype.isPaused = function () { return !this.activeEl || this.activeEl.paused; };

  GhostPlayer.prototype.seekTo = function (sec) {
    if (!this.activeEl || !isFinite(this.activeEl.duration)) return;
    this.activeEl.currentTime = Math.max(0, Math.min(sec, this.activeEl.duration));
  };
  GhostPlayer.prototype.seekBy = function (deltaSec) {
    if (!this.activeEl) return;
    this.seekTo((this.activeEl.currentTime || 0) + deltaSec);
  };
  GhostPlayer.prototype.seekFraction = function (frac) {
    if (!this.activeEl || !isFinite(this.activeEl.duration)) return;
    this.seekTo(frac * this.activeEl.duration);
  };

  GhostPlayer.prototype.getProgress = function () {
    if (!this.activeEl || !isFinite(this.activeEl.duration) || this.activeEl.duration === 0) {
      return { current: 0, duration: 0, fraction: 0, buffered: 0 };
    }
    var buffered = 0;
    try {
      if (this.activeEl.buffered.length) buffered = this.activeEl.buffered.end(this.activeEl.buffered.length - 1);
    } catch (e) { /* ignore */ }
    return {
      current: this.activeEl.currentTime,
      duration: this.activeEl.duration,
      fraction: this.activeEl.currentTime / this.activeEl.duration,
      buffered: Math.min(1, buffered / this.activeEl.duration)
    };
  };

  GhostPlayer.prototype.setVolume = function (v01) {
    v01 = Math.max(0, Math.min(1, v01));
    this.volume = v01;
    this.videoEl.volume = v01;
    this.audioEl.volume = v01;
  };
  GhostPlayer.prototype.getVolume = function () { return this.activeEl ? this.activeEl.volume : this.volume; };
  GhostPlayer.prototype.setMuted = function (m) {
    this.muted = !!m;
    this.videoEl.muted = !!m;
    this.audioEl.muted = !!m;
  };
  GhostPlayer.prototype.isMuted = function () { return this.activeEl ? this.activeEl.muted : this.muted; };

  GhostPlayer.prototype.canSeek = function () {
    return !!(this.activeEl && isFinite(this.activeEl.duration) && this.activeEl.duration > 0);
  };

  GhostPlayer.prototype.setRate = function (r) {
    this.rate = r;
    this.videoEl.playbackRate = r;
    this.audioEl.playbackRate = r;
  };

  GhostPlayer.prototype.setLoopOne = function (on) {
    this.loopOne = on;
    this.videoEl.loop = on;
    this.audioEl.loop = on;
  };

  GhostPlayer.prototype.stopAll = function () {
    this._killHls();
    [this.videoEl, this.audioEl].forEach(function (el) {
      el.pause();
      el.removeAttribute("src");
      el.removeAttribute("data-active");
      try { el.load(); } catch (e) { /* ignore */ }
    });
    this.activeEl = null;
    this._emit("stopped");
  };

  global.GhostPlayer = GhostPlayer;
  global.ghostFormatTime = formatTime;
})(window);
