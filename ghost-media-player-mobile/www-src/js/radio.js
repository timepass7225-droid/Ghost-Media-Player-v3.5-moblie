/* Ghost Media Player — Radio (worldwide ONLINE internet radio)
 *
 * Stations and real stream URLs come from the public Radio Browser API
 * (https://docs.radio-browser.info/) — no API key, no account.
 *
 *  - Completely separate screen; the existing player/library/effects are untouched.
 *  - Uses its OWN <audio> element. The main audio element can be routed through the
 *    Web Audio effects graph, which would silence a cross-origin stream, so radio
 *    must never share it.
 *  - No network request is made until the Radio screen is opened for the first time.
 *  - Favorites / recently played / filters / volume are stored in localStorage.
 *  - There is NO listening limit of any kind: no timers that stop playback, no caps
 *    on plays or stations. (The only timers are a 20 s *connect* timeout and the
 *    reconnect backoff after a dropped stream.)
 *  - Plain fetch + <audio> + localStorage only, so it also works in the Capacitor
 *    Android WebView. No desktop-only APIs.
 */
(function () {
  "use strict";

  if (window.GhostRadio) return;
  document.addEventListener("DOMContentLoaded", init);

  // ------------------------------------------------------------------ constants
  var LS = {
    favs: "ghost.radio.favs.v1",
    recents: "ghost.radio.recents.v1",
    prefs: "ghost.radio.prefs.v1",
    servers: "ghost.radio.servers.v1",
    lists: "ghost.radio.lists.v1"
  };
  var PAGE = 40;                       // stations fetched / rendered per page
  var MAX_RECENTS = 30;                // history list only; never limits listening
  var LIST_TTL = 24 * 3600 * 1000;     // countries / languages / tags cache
  var SERVER_TTL = 12 * 3600 * 1000;   // API server list cache
  var MEMO_TTL = 5 * 60 * 1000;        // identical API request cache (in memory)
  var CONNECT_TIMEOUT = 20000;
  var RECONNECT_DELAYS = [1500, 3000, 6000, 10000];
  var FALLBACK_SERVERS = [
    "https://de1.api.radio-browser.info",
    "https://de2.api.radio-browser.info",
    "https://fi1.api.radio-browser.info",
    "https://nl1.api.radio-browser.info",
    "https://at1.api.radio-browser.info",
    "https://all.api.radio-browser.info"
  ];

  // ------------------------------------------------------------------ small utils
  function loadJSON(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function cap(s) { s = clean(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function debounce(fn, ms) {
    var t = null;
    var d = function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
    d.cancel = function () { clearTimeout(t); };
    return d;
  }
  function flag(cc) {
    if (!/^[A-Za-z]{2}$/.test(cc || "")) return "\uD83C\uDF0D";
    cc = cc.toUpperCase();
    return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
  }
  // The API uses official country names ("The United Kingdom Of Great Britain And Northern Ireland").
  // Shorten only for display; filtering always uses the API's own code / name.
  function dispCountry(n) {
    n = clean(n);
    var m = { "the united kingdom of great britain and northern ireland": "United Kingdom", "the united states of america": "United States",
      "the russian federation": "Russia", "the netherlands": "Netherlands", "the philippines": "Philippines" };
    var k = n.toLowerCase();
    if (m[k]) return m[k];
    return n.replace(/^the /i, "");
  }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || ""); }
  function pageIsSecure() { return location.protocol === "https:"; }

  // ------------------------------------------------------------------ station model
  function splitTags(t) {
    if (!t) return [];
    var seen = {}, out = [];
    String(t).split(",").forEach(function (x) {
      x = clean(x).toLowerCase();
      if (x && x.length <= 30 && !seen[x]) { seen[x] = 1; out.push(x); }
    });
    return out;
  }
  // Only fields the API actually returned are kept — nothing is invented.
  function normStation(r) {
    if (!r) return null;
    var url = clean(r.url_resolved || r.url);
    if (!/^https?:\/\//i.test(url)) return null;
    return {
      id: r.stationuuid || url,
      name: clean(r.name) || "Unnamed station",
      url: url,
      country: clean(r.country),
      cc: clean(r.countrycode).toUpperCase(),
      state: clean(r.state),
      lang: clean(r.language),
      tags: splitTags(r.tags),
      codec: /^unknown$/i.test(clean(r.codec)) ? "" : clean(r.codec),
      bitrate: +r.bitrate > 0 ? +r.bitrate : 0,
      hls: r.hls === 1 || r.hls === "1" || r.hls === true || /\.m3u8(\?|$)/i.test(url),
      https: /^https:/i.test(url)
    };
  }
  function slim(st) {            // what is persisted for favorites / recents
    return {
      id: st.id, name: st.name, url: st.url, country: st.country, cc: st.cc, state: st.state,
      lang: st.lang, tags: (st.tags || []).slice(0, 6), codec: st.codec, bitrate: st.bitrate,
      hls: !!st.hls, https: !!st.https
    };
  }
  function sanitizeStored(list) {
    return (Array.isArray(list) ? list : []).filter(function (s) {
      return s && typeof s.id === "string" && typeof s.name === "string" && /^https?:\/\//i.test(s.url || "");
    }).map(function (s) {
      s.tags = Array.isArray(s.tags) ? s.tags : [];
      s.hls = !!s.hls; s.https = /^https:/i.test(s.url);
      return s;
    });
  }

  // ------------------------------------------------------------------ Radio Browser API client
  var API = (function () {
    var bases = null, idx = 0, memo = {}, memoKeys = [];
    var statusCb = function () {};

    function shuffle(a) {
      a = a.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    }
    function withTimeout(ms, outer) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, ms);
      var onAbort = function () { ctl.abort(); };
      if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener("abort", onAbort); }
      return {
        signal: ctl.signal,
        done: function () { clearTimeout(timer); if (outer) outer.removeEventListener("abort", onAbort); }
      };
    }

    // Server discovery: the service publishes its mirrors; pick one at random (as the docs recommend).
    function discover() {
      if (window.GHOST_RADIO_API) {            // explicit override (used for offline testing)
        return Promise.resolve([].concat(window.GHOST_RADIO_API));
      }
      var cached = loadJSON(LS.servers, null);
      if (cached && cached.list && cached.list.length && Date.now() - cached.t < SERVER_TTL) {
        return Promise.resolve(shuffle(cached.list));
      }
      var w = withTimeout(6000);
      return fetch("https://all.api.radio-browser.info/json/servers", { signal: w.signal })
        .then(function (r) { w.done(); if (!r.ok) throw new Error("servers " + r.status); return r.json(); })
        .then(function (arr) {
          var seen = {}, list = [];
          (arr || []).forEach(function (s) {
            var n = s && s.name;
            if (n && /^[a-z0-9.-]+$/i.test(n) && !seen[n]) { seen[n] = 1; list.push("https://" + n); }
          });
          if (!list.length) throw new Error("no servers");
          saveJSON(LS.servers, { t: Date.now(), list: list });
          return shuffle(list);
        })
        .catch(function () { w.done(); return shuffle(FALLBACK_SERVERS); });
    }
    function getBases() {
      if (bases) return Promise.resolve(bases);
      return discover().then(function (l) { bases = l; idx = 0; return bases; });
    }
    function qs(params) {
      var out = [];
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v === undefined || v === null || v === "") return;
        out.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      });
      return out.length ? "?" + out.join("&") : "";
    }
    function remember(key, value) {
      memo[key] = { t: Date.now(), v: value };
      memoKeys.push(key);
      while (memoKeys.length > 60) delete memo[memoKeys.shift()];
    }

    // GET with server rotation. No custom headers are set, so the request stays a CORS "simple"
    // request (no preflight) — the API itself allows cross-origin reads.
    function get(path, params, o) {
      o = o || {};
      var query = qs(params), key = path + query;
      if (!o.fresh && memo[key] && Date.now() - memo[key].t < MEMO_TTL) return Promise.resolve(memo[key].v);
      return getBases().then(function (list) {
        var tries = Math.min(3, list.length), attempt = 0;
        function next(lastErr) {
          if (attempt >= tries) { statusCb(false); throw lastErr || new Error("unreachable"); }
          var base = list[(idx + attempt) % list.length];
          var w = withTimeout(o.timeout || 12000, o.signal);
          attempt++;
          return fetch(base + path + query, { signal: w.signal })
            .then(function (res) {
              w.done();
              if (!res.ok) { var e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
              return res.json();
            })
            .then(function (json) {
              idx = (idx + attempt - 1) % list.length;     // stay on the mirror that worked
              statusCb(true);
              remember(key, json);
              return json;
            })
            .catch(function (e) {
              w.done();
              if (o.signal && o.signal.aborted) { var a = new Error("aborted"); a.name = "AbortError"; throw a; }
              if (e && e.status && e.status < 500) { statusCb(false); throw e; }   // client error: another mirror won't help
              return next(e);
            });
        }
        return next();
      });
    }
    return { get: get, onStatus: function (cb) { statusCb = cb; } };
  })();

  // ------------------------------------------------------------------ init
  function init() {
    var screen = document.getElementById("radioScreen");
    var mini = document.getElementById("radioMini");
    var panel = document.getElementById("panel-radio");
    var stage = document.getElementById("stage");
    var viewport = document.getElementById("viewport");
    var nowTitle = document.getElementById("nowTitle");
    var sidebar = document.getElementById("sidebar");
    var navBtn = document.getElementById("navRadio");
    var toastEl = document.getElementById("toast");
    if (!screen || !mini || !panel || !stage || !viewport) return;

    // ---------------------------------------------------------------- persisted state
    var favs = sanitizeStored(loadJSON(LS.favs, []));
    var recents = sanitizeStored(loadJSON(LS.recents, [])).slice(0, MAX_RECENTS);
    var libSettings = loadJSON("ghost.settings.v1", {});
    var prefs = loadJSON(LS.prefs, {});
    if (typeof prefs.volume !== "number") prefs.volume = Math.max(0, Math.min(1, (+libSettings.defaultVolume || 80) / 100));
    if (typeof prefs.muted !== "boolean") prefs.muted = false;
    if (typeof prefs.httpsOnly !== "boolean") prefs.httpsOnly = pageIsSecure();   // plain http streams are blocked in secure WebViews
    prefs.country = prefs.country || ""; prefs.lang = prefs.lang || ""; prefs.tag = prefs.tag || "";
    function savePrefs() { saveJSON(LS.prefs, prefs); }

    // ---------------------------------------------------------------- UI state
    var S = {
      open: false, built: false, booted: false, prevTitle: "",
      tab: "discover", q: "", country: prefs.country, state: "", lang: prefs.lang, tag: prefs.tag,
      httpsOnly: prefs.httpsOnly,
      results: [], seen: {}, offset: 0, hasMore: false, loading: false, err: "", hiddenHls: 0,
      lists: { countries: [], languages: [], tags: [], states: [] }, listsReady: false, statesFor: "",
      api: "idle"
    };
    var $ = {};     // element refs, filled by build()

    // ---------------------------------------------------------------- toast (same element as the app)
    var toastTimer = null;
    function toast(msg) {
      if (!toastEl) return;
      toastEl.textContent = msg; toastEl.hidden = false;
      requestAnimationFrame(function () { toastEl.classList.add("is-visible"); });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.classList.remove("is-visible");
        setTimeout(function () { toastEl.hidden = true; }, 250);
      }, 2200);
    }

    // ================================================================ PLAYER
    var audio = new Audio();           // dedicated element — never connected to Web Audio
    audio.preload = "none";
    audio.volume = prefs.volume;
    audio.muted = prefs.muted;
    var HLS_OK = !!(audio.canPlayType("application/vnd.apple.mpegurl") || audio.canPlayType("application/x-mpegURL"));

    var P = {
      st: "idle",          // idle | loading | buffering | playing | paused | reconnecting | error | stopped
      station: null, err: "", token: 0,
      live: false,         // has this tune-in actually produced sound yet?
      counted: false, triedFresh: false, retries: 0,
      pausedAt: 0, connectTimer: null, retryTimer: null
    };
    var ACTIVE = { loading: 1, buffering: 1, playing: 1, reconnecting: 1 };

    function setState(s, err) {
      P.st = s; P.err = err || "";
      renderRx(); renderMini(); renderCardsState(); updateTitle(); mediaSession();
    }
    function clearTimers() { clearTimeout(P.connectTimer); clearTimeout(P.retryTimer); P.connectTimer = P.retryTimer = null; }
    function detach() {
      try { audio.pause(); } catch (e) { /* ignore */ }
      audio.removeAttribute("src");
      try { audio.load(); } catch (e) { /* ignore */ }
    }
    function pauseLocalMedia() {
      ["audioEl", "videoEl"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.paused) { try { el.pause(); } catch (e) { /* ignore */ } }
      });
    }

    function mixedBlocked(url) { return pageIsSecure() && /^http:/i.test(url || ""); }
    function errMessage(me) {
      if (navigator.onLine === false) return "You appear to be offline. Check your internet connection.";
      var code = me && me.code;
      if (code === 3) return "Unable to play this stream \u2014 its audio could not be decoded here. Try another station.";
      if (code === 4) {
        if (P.station && mixedBlocked(P.station.url)) {
          return "Unable to connect: this station uses an unencrypted (HTTP) stream that this app can't open. Try an HTTPS station.";
        }
        return "Station unavailable \u2014 the stream is offline or its format isn't supported on this device. Try another station.";
      }
      return "Unable to connect to this stream. Try another station.";
    }

    function fail(msg) {
      if (P.st === "error") return;
      clearTimers();
      P.token++;                    // invalidate anything in flight
      detach();
      setState("error", msg);
    }

    function startLoad(url, reconnecting) {
      var tok = P.token;
      clearTimeout(P.connectTimer);
      setState(reconnecting ? "reconnecting" : "loading");
      audio.src = url;
      audio.load();
      var p = audio.play();
      if (p && p.catch) {
        p.catch(function (e) {
          if (tok !== P.token) return;
          if (e && e.name === "AbortError") return;           // superseded by another load
          if (e && e.name === "NotAllowedError") {            // autoplay blocked: wait for the user
            clearTimers(); setState("paused"); P.pausedAt = 0;
            return;
          }
          /* NotSupportedError etc. also raise the element's "error" event, handled there */
        });
      }
      P.connectTimer = setTimeout(function () {
        if (tok !== P.token) return;
        if (P.st === "loading" || P.st === "reconnecting") {
          if (P.live) reconnectOrFail(null); else fail("Unable to connect to this stream (timed out). Try another station.");
        }
      }, CONNECT_TIMEOUT);
    }

    function play(station) {
      if (!station) return;
      if (station.hls && !HLS_OK) {
        pauseLocalMedia(); clearTimers(); P.token++; detach(); P.station = station; P.live = false;
        setState("error", "This station streams over HLS (.m3u8), which this device's audio engine can't play. Try another station.");
        return;
      }
      pauseLocalMedia();
      clearTimers();
      P.token++;
      P.station = station; P.live = false; P.counted = false; P.triedFresh = false; P.retries = 0;
      startLoad(station.url, false);
    }

    function pause() {
      if (!P.station || !ACTIVE[P.st]) return;
      clearTimers();
      try { audio.pause(); } catch (e) { /* ignore */ }
      P.pausedAt = Date.now();
      setState("paused");
    }
    function resume() {
      if (!P.station) return;
      pauseLocalMedia();
      // A paused live stream keeps buffering old audio; after more than a few seconds,
      // reconnect so the listener rejoins the live broadcast.
      var stale = !P.pausedAt || Date.now() - P.pausedAt > 4000 || audio.ended || !!audio.error || !audio.getAttribute("src");
      if (stale) { P.token++; P.retries = 0; startLoad(P.station.url, false); return; }
      var tok = P.token;
      setState("buffering");
      var p = audio.play();
      if (p && p.catch) p.catch(function (e) {
        if (tok !== P.token || (e && e.name === "AbortError")) return;
        P.token++; startLoad(P.station.url, false);
      });
    }
    function stop() {
      if (!P.station) return;
      clearTimers(); P.token++;
      P.live = false;
      detach();
      setState("stopped");
    }
    function toggle() {
      if (!P.station) return;
      if (P.st === "playing" || P.st === "buffering" || P.st === "loading" || P.st === "reconnecting") pause();
      else if (P.st === "paused") resume();
      else play(P.station);
    }
    function setVolume(v) {
      v = Math.max(0, Math.min(1, v));
      audio.volume = v; prefs.volume = v;
      if (v > 0 && audio.muted) { audio.muted = false; prefs.muted = false; }
      savePrefs(); renderVolume();
    }
    function toggleMute() { audio.muted = !audio.muted; prefs.muted = audio.muted; savePrefs(); renderVolume(); }

    function reconnectOrFail(me) {
      var tok = P.token;
      if (P.retries >= RECONNECT_DELAYS.length) { fail("The connection to this station was lost. Try again or pick another station."); return; }
      var delay = RECONNECT_DELAYS[P.retries++];
      clearTimers();
      detach();
      setState("reconnecting");
      P.retryTimer = setTimeout(function () {
        if (tok !== P.token) return;
        if (navigator.onLine === false) { reconnectOrFail(me); return; }
        startLoad(P.station.url, true);
      }, delay);
    }

    function onMediaError() {
      if (!P.station || !audio.getAttribute("src") || P.st === "error" || P.st === "stopped" || P.st === "idle") return;
      var me = audio.error;
      if (P.live) { reconnectOrFail(me); return; }
      // Never produced sound: the stored address may be stale (favorites / history). Ask the API once for the current one.
      var tok = P.token, st = P.station;
      if (!P.triedFresh && isUuid(st.id)) {
        P.triedFresh = true;
        clearTimers(); detach(); setState("loading");
        API.get("/json/stations/byuuid", { uuids: st.id }, { timeout: 6000, fresh: true }).then(function (list) {
          if (tok !== P.token) return;
          var r = list && list[0] && normStation(list[0]);
          if (r && r.url !== st.url && !(r.hls && !HLS_OK)) {
            st.url = r.url; updateStoredUrl(st.id, r.url);
            startLoad(r.url, false);
          } else fail(errMessage(me));
        }).catch(function () { if (tok === P.token) fail(errMessage(me)); });
        return;
      }
      fail(errMessage(me));
    }

    audio.addEventListener("playing", function () {
      if (!audio.getAttribute("src")) return;
      clearTimeout(P.connectTimer);
      P.live = true; P.retries = 0;
      if (!P.counted && P.station) {
        P.counted = true;
        addRecent(P.station);
        // Counts one listener "click" for the station on Radio Browser (as the API docs ask clients to do).
        if (isUuid(P.station.id)) API.get("/json/url/" + encodeURIComponent(P.station.id), null, { timeout: 6000, fresh: true }).catch(function () {});
      }
      setState("playing");
    });
    audio.addEventListener("waiting", function () { if (P.st === "playing") setState("buffering"); });
    audio.addEventListener("pause", function () {
      // Programmatic pauses change P.st first; this only reacts to external pauses (hardware media keys, OS).
      // A stream that simply ENDED also fires "pause" right before "ended" — that is a dropped stream, not a pause.
      if (audio.ended) return;
      if ((P.st === "playing" || P.st === "buffering") && audio.getAttribute("src")) {
        clearTimers(); P.pausedAt = Date.now(); setState("paused");
      }
    });
    audio.addEventListener("play", function () {
      if (P.st === "paused" && audio.getAttribute("src") && P.station) setState("buffering");
    });
    audio.addEventListener("error", onMediaError);
    audio.addEventListener("ended", function () {
      if (P.station && audio.getAttribute("src") && ACTIVE[P.st]) { if (P.live) reconnectOrFail(null); else onMediaError(); }
    });
    audio.addEventListener("volumechange", renderVolume);
    window.addEventListener("online", function () {
      if (P.station && P.live && (P.st === "error" || P.st === "reconnecting")) { P.token++; P.retries = 0; startLoad(P.station.url, false); }
      if (S.open && S.err && S.tab === "discover") boot(true);
    });

    // One sound source at a time: starting local media stops the stream.
    ["audioEl", "videoEl"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("play", function () { if (P.station && P.st !== "idle" && P.st !== "stopped" && P.st !== "error") stop(); });
    });

    // OS-level media controls (lock screen / headset / media keys) — attached only while radio is in use.
    var msAttached = false;
    function mediaSession() {
      if (!("mediaSession" in navigator)) return;
      try {
        var inUse = P.station && (ACTIVE[P.st] || P.st === "paused");
        if (inUse) {
          navigator.mediaSession.metadata = new window.MediaMetadata({
            title: P.station.name, artist: [P.station.country, "Ghost Radio"].filter(Boolean).join(" \u00b7 ")
          });
          navigator.mediaSession.playbackState = P.st === "paused" ? "paused" : "playing";
          if (!msAttached) {
            msAttached = true;
            navigator.mediaSession.setActionHandler("play", function () { if (P.st === "paused") resume(); else toggle(); });
            navigator.mediaSession.setActionHandler("pause", function () { pause(); });
            navigator.mediaSession.setActionHandler("stop", function () { stop(); });
          }
        } else if (msAttached) {
          msAttached = false;
          ["play", "pause", "stop"].forEach(function (a) { navigator.mediaSession.setActionHandler(a, null); });
          navigator.mediaSession.metadata = null;
          navigator.mediaSession.playbackState = "none";
        }
      } catch (e) { /* mediaSession unsupported */ }
    }

    // ================================================================ FAVORITES / RECENTS
    function isFav(id) { return favs.some(function (f) { return f.id === id; }); }
    function toggleFav(st) {
      if (!st) return;
      var i = favs.findIndex(function (f) { return f.id === st.id; });
      if (i >= 0) { favs.splice(i, 1); toast("Removed from favorites"); }
      else { favs.unshift(slim(st)); toast("Added to favorites"); }
      saveJSON(LS.favs, favs);
      afterFavChange();
    }
    function addRecent(st) {
      recents = recents.filter(function (r) { return r.id !== st.id; });
      recents.unshift(slim(st));
      if (recents.length > MAX_RECENTS) recents.length = MAX_RECENTS;
      saveJSON(LS.recents, recents);
      renderTabs(); renderPanel();
      if (S.open && S.tab === "recent") renderList();
    }
    function updateStoredUrl(id, url) {
      var ch = false;
      [favs, recents].forEach(function (list) { list.forEach(function (s) { if (s.id === id && s.url !== url) { s.url = url; s.https = /^https:/i.test(url); ch = true; } }); });
      if (ch) { saveJSON(LS.favs, favs); saveJSON(LS.recents, recents); }
    }
    function afterFavChange() {
      renderTabs(); renderPanel(); renderRx(); renderBar();
      if (S.open) {
        if (S.tab === "favorites") renderList(); else renderCardsState();
      }
    }

    function findStation(id) {
      var pools = [S.results, favs, recents, P.station ? [P.station] : []];
      for (var i = 0; i < pools.length; i++) for (var j = 0; j < pools[i].length; j++) if (pools[i][j].id === id) return pools[i][j];
      return null;
    }

    // ================================================================ SCREEN open / leave
    function open() {
      if (window.GhostScreens && window.GhostScreens.current()) window.GhostScreens.hide(window.GhostScreens.current(), true);
      ensureBuilt();
      if (!S.open) S.prevTitle = nowTitle.textContent;
      S.open = true;
      viewport.hidden = true; screen.hidden = false;
      stage.classList.add("is-radio");
      sidebar.classList.remove("is-open");        // on phones the drawer would cover the screen
      updateTitle(); renderMini();
      if (!S.booted) { S.booted = true; boot(false); }
      observeRx();
    }
    function leave() {
      if (!S.open) return;
      S.open = false;
      closePickers();
      screen.hidden = true; viewport.hidden = false;
      stage.classList.remove("is-radio");
      nowTitle.textContent = S.prevTitle || "Ghost Media Player";
      renderMini();
      // The stream is stopped by the local players' own "play" events (one sound source at a time).
    }
    function updateTitle() {
      if (!S.open) return;
      nowTitle.textContent = P.station && P.st !== "idle" && P.st !== "stopped" ? "Radio \u00b7 " + P.station.name : "Radio";
    }

    document.querySelectorAll(".navitem").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.panel;
        if (p === "radio") open();
        else if (p === "library" || p === "recent") leave();   // back to the player; a running stream keeps playing
      });
    });

    // ================================================================ BUILD (lazy)
    var ICON = {
      play: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>',
      pause: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/></svg>',
      playS: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>',
      pauseS: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/></svg>',
      stop: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
      heart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 20.2s-7.4-4.5-7.4-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.4 2.7c0 5.6-7.4 10.1-7.4 10.1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
      refresh: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="6.3" stroke="currentColor" stroke-width="1.6"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      chev: '<svg class="rp__chev" width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      volOn: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M4 10v4h3.5L12 17.5v-11L7.5 10H4Z" fill="currentColor"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.4 7.4 0 0 1 0 10.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      volOff: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M4 10v4h3.5L12 17.5v-11L7.5 10H4Z" fill="currentColor"/><path d="m15 10 4 4m0-4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      pager: '<svg viewBox="0 0 32 32" width="24" height="24" fill="none"><rect x="3.5" y="8" width="25" height="17" rx="4" stroke="currentColor" stroke-width="1.6"/><rect x="7" y="11.5" width="18" height="6.5" rx="1.6" fill="currentColor" opacity=".9"/><circle cx="9.5" cy="21.6" r="1.1" fill="currentColor"/><circle cx="13.2" cy="21.6" r="1.1" fill="currentColor"/><path d="M19 21.6h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M9 8V5.2M23 8V5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    };

    function ensureBuilt() {
      if (S.built) return;
      S.built = true;
      screen.innerHTML =
        '<div class="radio-wrap">' +
          '<header class="radio-head">' +
            '<span class="radio-head__mark" aria-hidden="true">' + ICON.pager + '</span>' +
            '<div class="radio-head__text"><h1>Radio</h1><p>Worldwide online radio \u00b7 live internet streams</p></div>' +
            '<span class="radio-api" id="rApi" data-s="idle"><i></i><span id="rApiTxt">Ready</span></span>' +
            '<button type="button" class="rbtn" id="rRefresh" aria-label="Refresh" title="Refresh stations">' + ICON.refresh + '</button>' +
          '</header>' +

          '<section class="rx" id="rx" data-state="idle" aria-label="Now playing">' +
            '<div class="rx__body">' +
              '<div class="rx__lcd">' +
                '<div class="rx__top"><span class="rx__led" aria-hidden="true"></span><span class="rx__status" id="rxStatus">STANDBY</span><span class="rx__spec" id="rxSpec"></span></div>' +
                '<div class="rx__name" id="rxName">No station selected</div>' +
                '<div class="rx__line" id="rxSub">Choose a station below to start listening</div>' +
                '<div class="rx__line rx__line--tags" id="rxTags"></div>' +
                '<div class="rx__msg" id="rxMsg" role="status" hidden><span id="rxMsgTxt"></span><button type="button" class="btn btn--ghost rx__retry" id="rxRetry">Try again</button></div>' +
              '</div>' +
              '<div class="rx__panel">' +
                '<div class="rx__bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
                '<div class="rx__btns">' +
                  '<button type="button" class="rbtn rbtn--fav" id="rxFav" aria-label="Add to favorites" aria-pressed="false" title="Favorite">' + ICON.heart + '</button>' +
                  '<button type="button" class="rbtn rbtn--play" id="rxPlay" aria-label="Play" title="Play / Pause (Space)">' + ICON.play + '</button>' +
                  '<button type="button" class="rbtn" id="rxStop" aria-label="Stop" title="Stop">' + ICON.stop + '</button>' +
                '</div>' +
                '<div class="rx__knobs" id="rxKnobs">' +
                  '<div class="knob" id="rxKnobVol" tabindex="0" role="slider" aria-label="Volume knob" aria-valuemin="0" aria-valuemax="100"><div class="knob__dial"><i></i></div><span>VOL</span></div>' +
                  '<div class="rx__tuner"><div class="rx__scale" id="rxScale"><i id="rxNeedle"></i></div><div class="rx__tunetxt" id="rxTuneTxt">\u2014</div>' +
                    '<div class="rx__presets" id="rxPresets"></div></div>' +
                  '<div class="knob knob--tune" id="rxKnobTune" tabindex="0" role="slider" aria-label="Tuning knob: change station"><div class="knob__dial"><i></i></div><span>TUNE</span></div>' +
                '</div>' +
                '<div class="rx__vol">' +
                  '<button type="button" class="rbtn" id="rxMute" aria-label="Mute" title="Mute (M)">' + ICON.volOn + '</button>' +
                  '<div class="volume rx__slider"><div class="volume__fill" id="rxVolFill"></div>' +
                    '<input class="volume__range" id="rxVol" type="range" min="0" max="100" step="1" value="80" aria-label="Volume"></div>' +
                  '<span class="rx__pct" id="rxPct">80%</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</section>' +

          '<nav class="radio-tabs" role="tablist" aria-label="Station lists">' +
            '<button type="button" class="rtab is-active" role="tab" data-tab="discover">Discover</button>' +
            '<button type="button" class="rtab" role="tab" data-tab="favorites">\u2764\uFE0F Favorites <span class="count-pill" id="rCntFav">0</span></button>' +
            '<button type="button" class="rtab" role="tab" data-tab="recent">\uD83D\uDD52 Recent <span class="count-pill" id="rCntRec">0</span></button>' +
          '</nav>' +

          '<div class="radio-filters" id="rFilters">' +
            '<label class="rsearch">' + ICON.search +
              '<input id="rSearch" type="text" inputmode="search" autocomplete="off" spellcheck="false" placeholder="Search stations, countries, genres, languages\u2026" aria-label="Search stations">' +
              '<button type="button" class="rsearch__clear" id="rSearchClear" aria-label="Clear search" hidden>' + ICON.x + '</button>' +
            '</label>' +
            '<div class="radio-pickers" id="rPickers">' +
              '<div class="rp" id="pCountry"></div><div class="rp" id="pState"></div><div class="rp" id="pLang"></div><div class="rp" id="pTag"></div>' +
            '</div>' +
            '<div class="radio-filters__row" id="rFilterRow">' +
              '<button type="button" class="chip" id="rHttps" aria-pressed="false" title="Only list stations that stream over HTTPS">\uD83D\uDD12 HTTPS only</button>' +
              '<button type="button" class="link-btn" id="rClearFilters">Clear filters</button>' +
            '</div>' +
          '</div>' +

          '<div class="radio-quick" id="rQuick" hidden></div>' +

          '<div class="radio-listhead"><h2 id="rListTitle">Popular worldwide</h2><span class="radio-listhead__count" id="rListCount"></span>' +
            '<button type="button" class="link-btn" id="rClearRecent" hidden>Clear history</button></div>' +
          '<div class="rgrid" id="rGrid" aria-live="polite"></div>' +
          '<div class="radio-foot"><p class="radio-foot__note" id="rNote" hidden></p><button type="button" class="btn btn--ghost" id="rMore" hidden>Load more stations</button></div>' +
        '</div>' +

        '<div class="rbar" id="rBar" hidden>' +
          '<button type="button" class="rbar__info" id="rBarInfo" title="Back to the receiver"><span class="rbar__led" aria-hidden="true"></span><span class="rbar__meta"><b id="rBarName"></b><i id="rBarStatus"></i></span></button>' +
          '<button type="button" class="rbtn rbtn--play rbtn--sm" id="rBarPlay" aria-label="Play">' + ICON.playS + '</button>' +
          '<button type="button" class="rbtn rbtn--sm" id="rBarStop" aria-label="Stop">' + ICON.stop + '</button>' +
        '</div>' +
        '<div class="rp-scrim" id="rScrim" hidden></div>';

      var ids = ["rApi", "rApiTxt", "rRefresh", "rx", "rxStatus", "rxSpec", "rxName", "rxSub", "rxTags", "rxMsg", "rxMsgTxt", "rxRetry",
        "rxFav", "rxPlay", "rxStop", "rxMute", "rxVol", "rxVolFill", "rxPct", "rCntFav", "rCntRec", "rFilters", "rSearch", "rSearchClear",
        "rPickers", "rFilterRow", "rHttps", "rClearFilters", "rQuick", "rListTitle", "rListCount", "rClearRecent", "rGrid", "rNote", "rMore",
        "rBar", "rBarInfo", "rBarName", "rBarStatus", "rBarPlay", "rBarStop", "rScrim"];
      ids.forEach(function (id) { $[id] = document.getElementById(id); });

      // pickers
      $.pCountry = makePicker(document.getElementById("pCountry"), { cap: "Country", all: "\uD83C\uDF0D All countries", onChange: onCountry });
      $.pState = makePicker(document.getElementById("pState"), { cap: "Region", all: "All regions", onChange: onState });
      $.pLang = makePicker(document.getElementById("pLang"), { cap: "Language", all: "Any language", onChange: onLang });
      $.pTag = makePicker(document.getElementById("pTag"), { cap: "Genre", all: "Any genre", onChange: onTag });
      $.pState.setDisabled(true, "Pick a country first");
      [$.pCountry, $.pLang, $.pTag].forEach(function (p) { p.setLoading(true); });

      wire();
      wireKnobs();
      renderRx(); renderVolume(); renderTabs(); renderBar(); syncFilterUI();
    }

    // ================================================================ PICKER (custom searchable select)
    var openPicker = null;
    function closePickers() { if (openPicker) openPicker.close(); }
    function makePicker(host, cfg) {
      host.innerHTML =
        '<button type="button" class="rp__btn" aria-haspopup="listbox" aria-expanded="false">' +
          '<span class="rp__cap">' + esc(cfg.cap) + '</span><span class="rp__val"></span>' + ICON.chev + '</button>' +
        '<div class="rp__pop" hidden><input class="rp__filter" type="text" autocomplete="off" spellcheck="false" placeholder="Filter\u2026" aria-label="Filter ' + esc(cfg.cap) + '">' +
          '<ul class="rp__list" role="listbox"></ul></div>';
      var btn = host.querySelector(".rp__btn"), val = host.querySelector(".rp__val");
      var pop = host.querySelector(".rp__pop"), filter = host.querySelector(".rp__filter"), list = host.querySelector(".rp__list");
      var self = { items: [], value: "", disabled: false, loading: false, hl: -1, note: "" };
      var shown = [];

      function labelFor(v) {
        if (!v) return cfg.all;
        for (var i = 0; i < self.items.length; i++) if (self.items[i].value === v) return self.items[i].label;
        return v;
      }
      function paintBtn() {
        val.textContent = self.loading ? "Loading\u2026" : (self.disabled && self.note ? self.note : labelFor(self.value));
        btn.disabled = self.disabled || self.loading;
        host.classList.toggle("is-set", !!self.value);
        host.classList.toggle("is-disabled", btn.disabled);
      }
      function paintList() {
        var q = filter.value.trim().toLowerCase();
        shown = [{ value: "", label: cfg.all, sub: "" }].concat(self.items.filter(function (it) {
          return !q || (it.label + " " + (it.search || "")).toLowerCase().indexOf(q) !== -1;
        })).slice(0, 400);
        if (self.hl >= shown.length) self.hl = shown.length - 1;
        list.innerHTML = shown.map(function (it, i) {
          return '<li role="option" data-i="' + i + '" class="rp__item' + (it.value === self.value ? " is-selected" : "") + (i === self.hl ? " is-hl" : "") +
            '" aria-selected="' + (it.value === self.value) + '"><span class="rp__label">' + esc(it.label) + '</span>' +
            (it.sub ? '<span class="rp__sub">' + esc(it.sub) + '</span>' : "") + '</li>';
        }).join("") || '<li class="rp__empty">No matches</li>';
      }
      function choose(i) {
        var it = shown[i]; if (!it) return;
        self.value = it.value; paintBtn(); self.close();
        cfg.onChange(it.value);
      }
      self.open = function () {
        if (btn.disabled) return;
        closePickers();
        openPicker = self;
        pop.hidden = false; btn.setAttribute("aria-expanded", "true");
        host.classList.add("is-open");
        $.rScrim.hidden = false;
        filter.value = ""; self.hl = -1; paintList();
        pop.classList.remove("rp__pop--right");
        var r = pop.getBoundingClientRect();
        if (r.right > window.innerWidth - 8) pop.classList.add("rp__pop--right");
        var sel = list.querySelector(".is-selected"); if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
        if (window.matchMedia("(pointer: fine)").matches) filter.focus();     // don't pop the soft keyboard on touch screens
      };
      self.close = function () {
        if (openPicker !== self) return;
        openPicker = null;
        pop.hidden = true; btn.setAttribute("aria-expanded", "false");
        host.classList.remove("is-open");
        $.rScrim.hidden = true;
      };
      self.setItems = function (items) { self.items = items || []; paintBtn(); if (openPicker === self) paintList(); };
      self.setValue = function (v) { self.value = v || ""; paintBtn(); };
      self.setDisabled = function (d, note) { self.disabled = !!d; self.note = note || ""; paintBtn(); };
      self.setLoading = function (l) { self.loading = !!l; paintBtn(); };

      btn.addEventListener("click", function () { if (openPicker === self) self.close(); else self.open(); });
      filter.addEventListener("input", function () { self.hl = -1; paintList(); });
      filter.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          self.hl = Math.max(0, Math.min(shown.length - 1, self.hl + (e.key === "ArrowDown" ? 1 : -1)));
          paintList();
          var h = list.querySelector(".is-hl"); if (h && h.scrollIntoView) h.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault();
          choose(self.hl >= 0 ? self.hl : (filter.value.trim() && shown.length > 1 ? 1 : 0));
        } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self.close(); btn.focus(); }
      });
      list.addEventListener("click", function (e) {
        var li = e.target.closest(".rp__item"); if (li) choose(parseInt(li.getAttribute("data-i"), 10));
      });
      paintBtn();
      return self;
    }
    document.addEventListener("mousedown", function (e) {
      if (openPicker && !e.target.closest(".rp")) openPicker.close();
    }, true);

    // ================================================================ DATA: lists
    function listCache() { return loadJSON(LS.lists, {}); }
    function loadList(key, path, params, mapper, fresh) {
      var c = listCache();
      if (!fresh && c[key] && Date.now() - c[key].t < LIST_TTL && c[key].v && c[key].v.length) return Promise.resolve(c[key].v);
      return API.get(path, params, { fresh: !!fresh }).then(function (raw) {
        var v = mapper(raw || []);
        var cc = listCache(); cc[key] = { t: Date.now(), v: v }; saveJSON(LS.lists, cc);
        return v;
      }).catch(function (e) {
        if (c[key] && c[key].v) return c[key].v;          // stale cache beats nothing
        throw e;
      });
    }
    function loadCountries(fresh) {
      return loadList("countries", "/json/countries", { hidebroken: "true", order: "name" }, function (raw) {
        return raw.filter(function (c) { return c && c.name && c.stationcount > 0; }).map(function (c) {
          return { code: clean(c.iso_3166_1).toUpperCase(), name: clean(c.name), count: c.stationcount | 0 };
        });
      }, fresh);
    }
    function loadLanguages(fresh) {
      return loadList("languages", "/json/languages", { hidebroken: "true", order: "stationcount", reverse: "true" }, function (raw) {
        return raw.filter(function (l) { return l && l.name && l.stationcount >= 3; }).slice(0, 250).map(function (l) {
          return { name: clean(l.name), count: l.stationcount | 0 };
        });
      }, fresh);
    }
    function loadTags(fresh) {
      return loadList("tags", "/json/tags", { hidebroken: "true", order: "stationcount", reverse: "true", limit: 200 }, function (raw) {
        return raw.filter(function (t) { return t && t.name && t.name.length <= 28 && t.stationcount >= 15; }).slice(0, 150).map(function (t) {
          return { name: clean(t.name), count: t.stationcount | 0 };
        });
      }, fresh);
    }
    function loadStates(countryName, fresh) {
      return API.get("/json/states/" + encodeURIComponent(countryName) + "/", { hidebroken: "true" }, { fresh: !!fresh }).then(function (raw) {
        var want = countryName.toLowerCase();
        return (raw || []).filter(function (s) {
          // the API reports each state's country; ignore anything that isn't for the chosen one
          return s && s.name && s.stationcount > 0 && (!s.country || clean(s.country).toLowerCase() === want);
        }).map(function (s) {
          return { name: clean(s.name), count: s.stationcount | 0 };
        }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      });
    }

    function fmtCount(n) { return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : String(n); }
    function feedPickers() {
      $.pCountry.setItems(S.lists.countries.map(function (c) {
        return { value: c.code || c.name, label: flag(c.code) + " " + dispCountry(c.name), sub: fmtCount(c.count), search: (c.code || "") + " " + c.name };
      }));
      $.pLang.setItems(S.lists.languages.map(function (l) { return { value: l.name, label: cap(l.name), sub: fmtCount(l.count) }; }));
      $.pTag.setItems(S.lists.tags.map(function (t) { return { value: t.name, label: cap(t.name), sub: fmtCount(t.count) }; }));
      [$.pCountry, $.pLang, $.pTag].forEach(function (p) { p.setLoading(false); });
      $.pCountry.setValue(S.country); $.pLang.setValue(S.lang); $.pTag.setValue(S.tag);
      renderQuick();
    }
    function countryByValue(v) {
      for (var i = 0; i < S.lists.countries.length; i++) { var c = S.lists.countries[i]; if ((c.code || c.name) === v) return c; }
      return null;
    }
    function refreshStates() {
      var c = countryByValue(S.country);
      if (!c) { S.lists.states = []; S.statesFor = ""; $.pState.setItems([]); $.pState.setDisabled(true, "Pick a country first"); $.pState.setValue(""); return; }
      if (S.statesFor === c.name) return;
      S.statesFor = c.name;
      $.pState.setLoading(true);
      var mine = c.name;
      loadStates(c.name).then(function (st) {
        if (S.statesFor !== mine) return;
        S.lists.states = st;
        $.pState.setLoading(false);
        $.pState.setItems(st.map(function (s) { return { value: s.name, label: s.name, sub: fmtCount(s.count) }; }));
        if (st.length) { $.pState.setDisabled(false); $.pState.setValue(S.state); }
        else { $.pState.setDisabled(true, "No regions listed"); S.state = ""; }
      }).catch(function () {
        if (S.statesFor !== mine) return;
        S.statesFor = "";                      // allow a retry on the next country change
        $.pState.setLoading(false); $.pState.setItems([]); $.pState.setDisabled(true, "Regions unavailable");
      });
    }

    // ================================================================ DATA: search
    var searchSeq = 0, searchCtl = null;
    function baseParams() {
      var p = { hidebroken: "true", order: "clickcount", reverse: "true", limit: PAGE };
      if (S.country) { if (/^[A-Z]{2}$/.test(S.country)) p.countrycode = S.country; else { p.country = S.country; p.countryExact = "true"; } }
      if (S.state) { p.state = S.state; p.stateExact = "true"; }
      if (S.lang) { p.language = S.lang; p.languageExact = "true"; }
      if (S.tag) { p.tag = S.tag; p.tagExact = "true"; }
      if (S.httpsOnly) p.is_https = "true";
      return p;
    }
    // A typed query is matched against station names, genres/tags and — when it is the
    // name of a known country or language — that country / language as well.
    function buildSources() {
      var q = clean(S.q);
      if (!q) return [{}];
      var out = [{ name: q }];
      var ql = q.toLowerCase();
      if (!S.country) {
        var c = S.lists.countries.filter(function (x) { return x.name.toLowerCase() === ql || (x.code && x.code.toLowerCase() === ql && ql.length === 2); })[0];
        if (c) out.push(c.code ? { countrycode: c.code } : { country: c.name, countryExact: "true" });
      }
      if (!S.lang) {
        var l = S.lists.languages.filter(function (x) { return x.name.toLowerCase() === ql; })[0];
        if (l) out.push({ language: l.name, languageExact: "true" });
      }
      if (!S.tag) out.push({ tag: q });
      return out;
    }
    function hasFilters() { return !!(S.q.trim() || S.country || S.state || S.lang || S.tag); }

    function search(reset, fresh) {
      if (S.tab !== "discover") return Promise.resolve();
      if (searchCtl) searchCtl.abort();
      searchCtl = new AbortController();
      var ctl = searchCtl, seq = ++searchSeq;
      if (reset) { S.offset = 0; S.results = []; S.seen = {}; S.hasMore = false; S.hiddenHls = 0; }
      S.loading = true; S.err = "";
      renderList();

      var sources = buildSources(), added = 0, pagesTried = 0;
      function fetchPage() {
        pagesTried++;
        var jobs = sources.map(function (extra) {
          var params = baseParams();
          Object.keys(extra).forEach(function (k) { params[k] = extra[k]; });
          if (S.offset) params.offset = S.offset;
          return API.get("/json/stations/search", params, { signal: ctl.signal, fresh: !!fresh }).then(
            function (v) { return { ok: true, v: v }; },
            function (e) { return { ok: false, e: e }; });
        });
        return Promise.all(jobs).then(function (res) {
          if (seq !== searchSeq) return;
          var anyOk = false, full = false, got = 0;
          res.forEach(function (r) {
            if (!r.ok) return;
            anyOk = true;
            if ((r.v || []).length >= PAGE) full = true;
            (r.v || []).forEach(function (raw) {
              var st = normStation(raw);
              if (!st || S.seen[st.id]) return;
              S.seen[st.id] = 1;
              if (S.httpsOnly && !st.https) return;
              if (st.hls && !HLS_OK) { S.hiddenHls++; return; }
              S.results.push(st); got++;
            });
          });
          if (!anyOk) { var err = res[0] && res[0].e; if (err && err.name === "AbortError") return; throw err || new Error("failed"); }
          S.offset += PAGE; S.hasMore = full; added += got;
          // A full page can be filtered down to nothing (HTTPS-only / HLS): keep going a little.
          if (!added && full && pagesTried < 4) return fetchPage();
        });
      }
      return fetchPage().then(function () {
        if (seq !== searchSeq) return;
        S.loading = false; renderList();
      }).catch(function (e) {
        if (seq !== searchSeq || (e && e.name === "AbortError")) return;
        S.loading = false;
        S.err = navigator.onLine === false ? "You appear to be offline. Connect to the internet to browse stations." :
          "Couldn't reach the Radio Browser service. Check your connection and try again.";
        renderList();
      });
    }
    var searchDebounced = debounce(function () { search(true); }, 400);

    // ---- boot / refresh
    function boot(fresh) {
      setApi("busy");
      S.err = ""; 
      Promise.all([loadCountries(fresh), loadLanguages(fresh), loadTags(fresh)].map(function (p) {
        return p.then(function (v) { return v; }, function () { return null; });
      })).then(function (r) {
        S.lists.countries = r[0] || S.lists.countries;
        S.lists.languages = r[1] || S.lists.languages;
        S.lists.tags = r[2] || S.lists.tags;
        S.listsReady = !!(r[0] && r[1] && r[2]);
        feedPickers();
        refreshStates();
        syncFilterUI();
      });
      return search(true, !!fresh);
    }

    function setApi(s) {
      S.api = s;
      if (!$.rApi) return;
      $.rApi.setAttribute("data-s", s);
      $.rApiTxt.textContent = s === "ok" ? "Connected" : s === "err" ? "Unreachable" : s === "busy" ? "Connecting\u2026" : "Ready";
      $.rApi.title = s === "ok" ? "Radio Browser service reachable" : s === "err" ? "Could not reach the Radio Browser service" : "";
    }
    API.onStatus(function (ok) { if (S.built) setApi(ok ? "ok" : "err"); });

    // ================================================================ RENDER
    var STATUS = {
      idle: "STANDBY", loading: "CONNECTING\u2026", buffering: "BUFFERING\u2026", playing: "ON AIR", paused: "PAUSED",
      reconnecting: "RECONNECTING\u2026", error: "UNAVAILABLE", stopped: "STOPPED"
    };
    function statusLine(st) {
      if (st === "error") return "Station unavailable";
      return STATUS[st] || "";
    }
    function place(st) {
      var parts = [];
      if (st.country) parts.push(flag(st.cc) + " " + dispCountry(st.country));
      if (st.state) parts.push(st.state);
      if (st.lang) parts.push(cap(st.lang));
      return parts.join(" \u00b7 ");
    }
    function specOf(st) {
      var a = [];
      if (st.codec) a.push(st.codec.toUpperCase());
      if (st.bitrate) a.push(st.bitrate + " kbps");
      if (st.hls) a.push("HLS");
      return a.join(" \u00b7 ");
    }

    // ---------------------------------------------------------------- car-stereo knobs
    function tunePool() { return S.tab === "favorites" ? favs : S.tab === "recent" ? recents : S.results; }
    function stepStation(dir) {
      var pool = tunePool();
      if (!pool.length) { toast("No stations in this list yet"); return; }
      var i = P.station ? pool.findIndex(function (x) { return x.id === P.station.id; }) : -1;
      i = i < 0 ? (dir > 0 ? 0 : pool.length - 1) : (i + dir + pool.length) % pool.length;
      play(pool[i]);
    }
    function renderTuner() {
      if (!S.built || !$.rxNeedle) return;
      var pool = tunePool(), i = P.station ? pool.findIndex(function (x) { return x.id === P.station.id; }) : -1;
      $.rxNeedle.style.left = (i < 0 || pool.length < 2 ? 0 : i / (pool.length - 1) * 100) + "%";
      $.rxNeedle.style.opacity = i < 0 ? 0.25 : 1;
      $.rxTuneTxt.textContent = pool.length ? (i < 0 ? "\u2014 / " : (i + 1) + " / ") + pool.length : "\u2014";
      var h = "";
      for (var k = 0; k < 6; k++) {
        var f = favs[k];
        h += '<button type="button" class="rx__preset' + (f && P.station && f.id === P.station.id ? " is-on" : "") + '" data-preset="' + k + '"' + (f ? ' title="' + esc(f.name) + '"' : " disabled") + ">" + (k + 1) + "</button>";
      }
      $.rxPresets.innerHTML = h;
      if ($.rxKnobVol) $.rxKnobVol.firstChild.style.transform = "rotate(" + (-135 + audio.volume * 270) + "deg)";
    }
    function wireKnobs() {
      $.rxKnobVol = document.getElementById("rxKnobVol"); $.rxKnobTune = document.getElementById("rxKnobTune");
      $.rxNeedle = document.getElementById("rxNeedle"); $.rxTuneTxt = document.getElementById("rxTuneTxt");
      $.rxPresets = document.getElementById("rxPresets");
      var tuneAngle = 0, acc = 0;
      function drag(el, onTurn) {
        var cx = 0, cy = 0, a0 = 0, on = false;
        function ang(e) { return Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI; }
        el.addEventListener("pointerdown", function (e) {
          var r = el.querySelector(".knob__dial").getBoundingClientRect();
          cx = r.left + r.width / 2; cy = r.top + r.height / 2; a0 = ang(e); on = true;
          try { el.setPointerCapture(e.pointerId); } catch (x) {}
          e.preventDefault();
        });
        el.addEventListener("pointermove", function (e) {
          if (!on) return;
          var a = ang(e), d = a - a0; if (d > 180) d -= 360; if (d < -180) d += 360;
          a0 = a; onTurn(d);
        });
        ["pointerup", "pointercancel"].forEach(function (n) { el.addEventListener(n, function () { on = false; }); });
        el.addEventListener("wheel", function (e) { e.preventDefault(); onTurn(e.deltaY < 0 ? 12 : -12); }, { passive: false });
        el.addEventListener("keydown", function (e) {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onTurn(14); }
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onTurn(-14); }
        });
      }
      drag($.rxKnobVol, function (d) { setVolume(audio.volume + d / 270); });
      drag($.rxKnobTune, function (d) {
        tuneAngle += d; acc += d;
        $.rxKnobTune.firstChild.style.transform = "rotate(" + tuneAngle + "deg)";
        while (acc >= 30) { acc -= 30; stepStation(1); }
        while (acc <= -30) { acc += 30; stepStation(-1); }
      });
      $.rxPresets.addEventListener("click", function (e) {
        var b = e.target.closest("[data-preset]"); if (!b || b.disabled) return;
        var f = favs[+b.getAttribute("data-preset")]; if (f) play(f);
      });
      renderTuner();
    }

    function renderRx() {
      if (!S.built) return;
      renderTuner();
      var st = P.station, s = P.st;
      $.rx.setAttribute("data-state", s);
      $.rxStatus.textContent = STATUS[s] || "";
      $.rxSpec.textContent = st ? specOf(st) : "";
      $.rxName.textContent = st ? st.name : "No station selected";
      $.rxSub.textContent = st ? (place(st) || "\uD83C\uDF0D Location not provided") : "Choose a station below to start listening";
      $.rxTags.textContent = st && st.tags.length ? "\uD83C\uDFB5 " + st.tags.slice(0, 5).map(cap).join(" \u00b7 ") : "";
      $.rxTags.hidden = !(st && st.tags.length);
      var showMsg = s === "error" && P.err;
      $.rxMsg.hidden = !showMsg;
      $.rxMsgTxt.textContent = showMsg ? P.err : "";

      var busy = s === "loading" || s === "reconnecting";
      var running = s === "playing" || s === "buffering" || busy;
      $.rxPlay.innerHTML = running ? ICON.pause : ICON.play;
      $.rxPlay.setAttribute("aria-label", running ? "Pause" : "Play");
      $.rxPlay.classList.toggle("is-busy", busy || s === "buffering");
      $.rxPlay.disabled = !st;
      $.rxStop.disabled = !st || s === "idle" || s === "stopped";
      $.rxFav.disabled = !st;
      var f = !!st && isFav(st.id);
      $.rxFav.classList.toggle("is-on", f);
      $.rxFav.setAttribute("aria-pressed", String(f));
      $.rxFav.setAttribute("aria-label", f ? "Remove from favorites" : "Add to favorites");
      renderBar();
    }
    function renderVolume() {
      if (!S.built) return;
      var v = audio.volume, muted = audio.muted || v === 0;
      $.rxVol.value = Math.round(v * 100);
      $.rxVolFill.style.width = (muted ? 0 : v * 100) + "%";
      if ($.rxKnobVol) $.rxKnobVol.firstChild.style.transform = "rotate(" + (-135 + v * 270) + "deg)";
      $.rxPct.textContent = (muted ? "Muted" : Math.round(v * 100) + "%");
      $.rxMute.innerHTML = muted ? ICON.volOff : ICON.volOn;
      $.rxMute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
      $.rxMute.classList.toggle("is-on", muted);
    }
    function renderBar() {
      if (!S.built) return;
      var st = P.station;
      var running = P.st === "playing" || P.st === "buffering" || P.st === "loading" || P.st === "reconnecting";
      $.rBar.setAttribute("data-state", P.st);
      $.rBarName.textContent = st ? st.name : "";
      $.rBarStatus.textContent = st ? statusLine(P.st) : "";
      $.rBarPlay.innerHTML = running ? ICON.pauseS : ICON.playS;
      $.rBarPlay.setAttribute("aria-label", running ? "Pause" : "Play");
      $.rBarStop.disabled = !st || P.st === "idle" || P.st === "stopped";
      updateBarVisibility();
    }
    // The compact bar only appears once the receiver has scrolled out of view.
    var rxVisible = true, io = null;
    function observeRx() {
      if (io || !("IntersectionObserver" in window)) return;
      io = new IntersectionObserver(function (entries) {
        rxVisible = entries[entries.length - 1].isIntersecting; updateBarVisibility();
      }, { root: screen, threshold: 0 });
      io.observe($.rx);
    }
    function updateBarVisibility() {
      if (!S.built) return;
      $.rBar.hidden = !(P.station && !rxVisible);
    }

    function renderMini() {
      var show = !S.open && P.station && P.st !== "idle" && P.st !== "stopped";
      mini.hidden = !show;
      if (!show) { mini.innerHTML = ""; return; }
      var running = P.st === "playing" || P.st === "buffering" || P.st === "loading" || P.st === "reconnecting";
      mini.setAttribute("data-state", P.st);
      mini.innerHTML =
        '<button type="button" class="radio-mini__open" data-rm="open" title="Open Radio"><span class="radio-mini__emoji" aria-hidden="true">\uD83D\uDCFB</span>' +
          '<span class="radio-mini__meta"><b>' + esc(P.station.name) + '</b><i>' + esc(statusLine(P.st)) + '</i></span></button>' +
        '<button type="button" class="iconbtn" data-rm="toggle" aria-label="' + (running ? "Pause radio" : "Play radio") + '">' + (running ? ICON.pauseS : ICON.playS) + '</button>' +
        '<button type="button" class="iconbtn" data-rm="stop" aria-label="Stop radio">' + ICON.stop + '</button>';
    }
    mini.addEventListener("click", function (e) {
      var b = e.target.closest("[data-rm]"); if (!b) return;
      var a = b.getAttribute("data-rm");
      if (a === "open") open(); else if (a === "toggle") toggle(); else if (a === "stop") stop();
    });

    function renderPanel() {
      var row = function (s) {
        return '<li class="media-item" data-rs="' + esc(s.id) + '"><span class="media-item__icon">\uD83D\uDCFB</span><span class="media-item__meta">' +
          '<div class="media-item__name">' + esc(s.name) + '</div><div class="media-item__sub">' + esc(s.country || "Online radio") + (s.codec ? " \u00b7 " + esc(s.codec) : "") + '</div></span></li>';
      };
      panel.innerHTML =
        '<div class="radio-side">' +
          '<p class="radio-side__intro">Live internet radio from around the world. Stations load only while you use Radio.</p>' +
          '<button type="button" class="btn btn--primary btn--block" data-rs-open>Open Radio</button>' +
          '<div class="sidebar__label sidebar__label--row"><span>Favorites</span><span class="count-pill">' + favs.length + '</span></div>' +
          (favs.length ? '<ul class="media-list">' + favs.map(row).join("") + '</ul>' : '<p class="empty-hint">Tap \u2764 on a station to keep it here.</p>') +
          '<div class="sidebar__label sidebar__label--row"><span>Recently played</span><span class="count-pill">' + recents.length + '</span></div>' +
          (recents.length ? '<ul class="media-list">' + recents.slice(0, 8).map(row).join("") + '</ul>' : '<p class="empty-hint">Stations you listen to show up here.</p>') +
        '</div>';
    }
    panel.addEventListener("click", function (e) {
      if (e.target.closest("[data-rs-open]")) { open(); return; }
      var r = e.target.closest("[data-rs]");
      if (r) { var st = findStation(r.getAttribute("data-rs")); if (st) { open(); play(st); } }
    });

    function renderTabs() {
      if (!S.built) return;
      $.rCntFav.textContent = favs.length; $.rCntRec.textContent = recents.length;
      screen.querySelectorAll(".rtab").forEach(function (t) {
        var on = t.getAttribute("data-tab") === S.tab;
        t.classList.toggle("is-active", on); t.setAttribute("aria-selected", String(on));
      });
    }
    function syncFilterUI() {
      if (!S.built) return;
      var disc = S.tab === "discover";
      $.rPickers.hidden = !disc; $.rFilterRow.hidden = !disc;
      $.rSearch.placeholder = disc ? "Search stations, countries, genres, languages\u2026" :
        (S.tab === "favorites" ? "Search your favorites\u2026" : "Search recently played\u2026");
      $.rSearchClear.hidden = !S.q;
      $.rHttps.classList.toggle("is-active", S.httpsOnly);
      $.rHttps.setAttribute("aria-pressed", String(S.httpsOnly));
      $.rClearFilters.hidden = !(S.country || S.state || S.lang || S.tag || S.q);
      $.rQuick.hidden = !(disc && S.lists.tags.length);
      $.rClearRecent.hidden = !(S.tab === "recent" && recents.length);
      $.pCountry.setValue(S.country); $.pLang.setValue(S.lang); $.pTag.setValue(S.tag); $.pState.setValue(S.state);
    }
    function renderQuick() {
      if (!S.built) return;
      var tags = S.lists.tags.slice(0, 10), cs = S.lists.countries.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
      if (!tags.length && !cs.length) { $.rQuick.innerHTML = ""; return; }
      $.rQuick.innerHTML =
        (tags.length ? '<div class="radio-quick__row"><span class="radio-quick__cap">Genres</span>' + tags.map(function (t) {
          return '<button type="button" class="chip' + (S.tag === t.name ? " is-active" : "") + '" data-qtag="' + esc(t.name) + '">' + esc(cap(t.name)) + '</button>';
        }).join("") + '</div>' : "") +
        (cs.length ? '<div class="radio-quick__row"><span class="radio-quick__cap">Countries</span>' + cs.map(function (c) {
          var v = c.code || c.name;
          return '<button type="button" class="chip' + (S.country === v ? " is-active" : "") + '" data-qcountry="' + esc(v) + '">' + flag(c.code) + " " + esc(dispCountry(c.name)) + '</button>';
        }).join("") + '</div>' : "");
      $.rQuick.hidden = S.tab !== "discover";
    }

    function localList() {
      var base = S.tab === "favorites" ? favs : recents;
      var q = clean(S.q).toLowerCase();
      if (!q) return base;
      return base.filter(function (s) {
        return (s.name + " " + s.country + " " + s.state + " " + s.lang + " " + s.tags.join(" ") + " " + s.codec).toLowerCase().indexOf(q) !== -1;
      });
    }
    function cardHtml(s) {
      var cur = P.station && P.station.id === s.id;
      var running = cur && (P.st === "playing" || P.st === "buffering" || P.st === "loading" || P.st === "reconnecting");
      var unplayable = s.hls && !HLS_OK;
      var f = isFav(s.id);
      var spec = specOf(s);
      return '<article class="rcard' + (cur ? " is-current" : "") + (cur ? " st-" + P.st : "") + (unplayable ? " is-unplayable" : "") + '" data-id="' + esc(s.id) + '">' +
        '<div class="rcard__badge" aria-hidden="true">' + esc((Array.from(s.name)[0] || "?").toUpperCase()) + '</div>' +
        '<div class="rcard__body">' +
          '<div class="rcard__name" title="' + esc(s.name) + '">' + esc(s.name) + '</div>' +
          '<div class="rcard__meta">' + esc(place(s) || "Location not provided") + '</div>' +
          (s.tags.length ? '<div class="rcard__tags">' + s.tags.slice(0, 3).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join("") + '</div>' : "") +
          (spec || unplayable ? '<div class="rcard__tech">' + esc(spec) + (unplayable ? (spec ? " \u00b7 " : "") + "not supported on this device" : "") + '</div>' : "") +
        '</div>' +
        '<div class="rcard__actions">' +
          '<button type="button" class="rbtn rbtn--fav' + (f ? " is-on" : "") + '" data-act="fav" aria-pressed="' + f + '" aria-label="' + (f ? "Remove from favorites" : "Add to favorites") + '">' + ICON.heart + '</button>' +
          '<button type="button" class="rbtn rbtn--play rbtn--sm' + (cur && (P.st === "loading" || P.st === "buffering" || P.st === "reconnecting") ? " is-busy" : "") + '" data-act="play" aria-label="' + (running ? "Pause" : "Play") + ' ' + esc(s.name) + '"' + (unplayable ? " disabled" : "") + '>' + (running ? ICON.pauseS : ICON.playS) + '</button>' +
        '</div></article>';
    }

    var rendered = 0;       // how many discover results are currently in the DOM
    function renderList() {
      if (!S.built) return;
      syncFilterUI(); renderTabs();
      var disc = S.tab === "discover";
      $.rListTitle.textContent = disc ? (hasFilters() ? "Results" : "Popular worldwide") : (S.tab === "favorites" ? "Your favorites" : "Recently played");
      $.rClearRecent.hidden = !(S.tab === "recent" && recents.length);
      $.rNote.hidden = true; $.rMore.hidden = true;

      if (!disc) {
        var list = localList();
        $.rListCount.textContent = list.length ? list.length + (list.length === 1 ? " station" : " stations") : "";
        $.rGrid.innerHTML = list.length ? list.map(cardHtml).join("") :
          emptyBlock(S.q ? "No matches" : S.tab === "favorites" ? "No favorites yet" : "Nothing played yet",
            S.q ? "Nothing in this list matches your search." :
            S.tab === "favorites" ? "Press the heart on any station to save it here. Favorites are stored on this device." :
            "Stations you listen to will appear here so you can tune back in quickly.");
        rendered = 0;
        return;
      }

      if (S.loading && !S.results.length) {
        $.rListCount.textContent = "";
        $.rGrid.innerHTML = '<div class="rstate"><span class="spinner" aria-hidden="true"></span><p>Tuning in to stations\u2026</p></div>';
        rendered = 0; return;
      }
      if (S.err && !S.results.length) {
        $.rListCount.textContent = "";
        $.rGrid.innerHTML = '<div class="rstate rstate--err"><p>' + esc(S.err) + '</p><button type="button" class="btn btn--primary" data-act="retry">Try again</button></div>';
        rendered = 0; return;
      }
      if (!S.results.length) {
        $.rListCount.textContent = "";
        $.rGrid.innerHTML = emptyBlock("No stations found", "Try a different search, or clear a filter. Stations that are offline are hidden.");
        rendered = 0; return;
      }
      $.rListCount.textContent = S.results.length + (S.hasMore ? "+" : "") + " stations";
      if (rendered > S.results.length || !rendered || $.rGrid.querySelector(".rstate")) {
        $.rGrid.innerHTML = S.results.map(cardHtml).join("");
      } else {
        $.rGrid.insertAdjacentHTML("beforeend", S.results.slice(rendered).map(cardHtml).join(""));
      }
      rendered = S.results.length;
      $.rMore.hidden = !S.hasMore;
      $.rMore.disabled = S.loading;
      $.rMore.textContent = S.loading ? "Loading\u2026" : "Load more stations";
      if (S.hiddenHls) { $.rNote.hidden = false; $.rNote.textContent = "Some HLS (.m3u8) stations are hidden because this device's audio engine can't play them."; }
      else if (S.httpsOnly) { $.rNote.hidden = false; $.rNote.textContent = "Showing HTTPS stations only. Turn off \u201cHTTPS only\u201d to include more stations."; }
      if (S.err) { $.rNote.hidden = false; $.rNote.textContent = S.err; }
    }
    function emptyBlock(title, text) {
      return '<div class="rstate"><div class="rstate__icon" aria-hidden="true">\uD83D\uDCFB</div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
    }
    // Cheap in-place update of play/pause/current-card state (no full re-render).
    function renderCardsState() {
      if (!S.built || !S.open) return;
      var cards = $.rGrid.querySelectorAll(".rcard");
      for (var i = 0; i < cards.length; i++) {
        var c = cards[i], id = c.getAttribute("data-id");
        var cur = !!P.station && P.station.id === id;
        c.className = c.className.replace(/\s*\b(is-current|st-\w+)\b/g, "");
        if (cur) c.className += " is-current st-" + P.st;
        var pb = c.querySelector('[data-act="play"]');
        if (pb) {
          var running = cur && (P.st === "playing" || P.st === "buffering" || P.st === "loading" || P.st === "reconnecting");
          var name = c.querySelector(".rcard__name").textContent;
          pb.innerHTML = running ? ICON.pauseS : ICON.playS;
          pb.setAttribute("aria-label", (running ? "Pause " : "Play ") + name);
          pb.classList.toggle("is-busy", cur && (P.st === "loading" || P.st === "buffering" || P.st === "reconnecting"));
        }
        var fb = c.querySelector('[data-act="fav"]');
        if (fb) {
          var f = isFav(id);
          fb.classList.toggle("is-on", f); fb.setAttribute("aria-pressed", String(f));
          fb.setAttribute("aria-label", f ? "Remove from favorites" : "Add to favorites");
        }
      }
    }

    // ================================================================ EVENTS
    function setTab(t) {
      if (S.tab === t) return;
      S.tab = t; closePickers();
      if (t === "discover" && !S.results.length && !S.loading) search(true); else renderList();
    }
    function onCountry(v) {
      S.country = v; S.state = ""; prefs.country = v; savePrefs();
      refreshStates(); renderQuick(); search(true);
    }
    function onState(v) { S.state = v; search(true); }
    function onLang(v) { S.lang = v; prefs.lang = v; savePrefs(); search(true); }
    function onTag(v) { S.tag = v; prefs.tag = v; savePrefs(); renderQuick(); search(true); }
    function clearFilters() {
      S.q = ""; S.country = S.state = S.lang = S.tag = ""; $.rSearch.value = "";
      prefs.country = prefs.lang = prefs.tag = ""; savePrefs();
      searchDebounced.cancel();
      refreshStates(); renderQuick(); search(true);
    }

    function refreshAll() {
      $.rRefresh.classList.add("is-spinning");
      var done = function () { $.rRefresh.classList.remove("is-spinning"); };
      if (S.tab === "discover") {
        S.statesFor = "";
        boot(true).then(function () { done(); if (!S.err) toast("Stations refreshed"); }, done);
        return;
      }
      // Favorites / recents: pull current metadata and stream addresses for the saved stations.
      var list = S.tab === "favorites" ? favs : recents;
      var ids = list.map(function (s) { return s.id; }).filter(isUuid).slice(0, 60);
      if (!ids.length) { done(); toast("Nothing to refresh"); return; }
      API.get("/json/stations/byuuid", { uuids: ids.join(",") }, { fresh: true }).then(function (arr) {
        var byId = {}; (arr || []).forEach(function (r) { var n = normStation(r); if (n) byId[n.id] = n; });
        var n = 0;
        [favs, recents].forEach(function (l) {
          l.forEach(function (s, i) { var f = byId[s.id]; if (f) { var keep = slim(f); l[i] = keep; n++; } });
        });
        saveJSON(LS.favs, favs); saveJSON(LS.recents, recents);
        renderList(); renderPanel(); done();
        toast(n ? "Updated " + n + " station" + (n === 1 ? "" : "s") : "No updates found");
      }).catch(function () { done(); toast("Couldn't reach the Radio Browser service"); });
    }

    function wire() {
      $.rRefresh.addEventListener("click", refreshAll);
      screen.querySelector(".radio-tabs").addEventListener("click", function (e) {
        var t = e.target.closest(".rtab"); if (t) setTab(t.getAttribute("data-tab"));
      });

      $.rSearch.addEventListener("input", function () {
        S.q = $.rSearch.value; $.rSearchClear.hidden = !S.q; $.rClearFilters.hidden = !hasFilters();
        if (S.tab === "discover") searchDebounced(); else renderList();
      });
      $.rSearch.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); searchDebounced.cancel(); if (S.tab === "discover") search(true); }
        else if (e.key === "Escape" && S.q) { e.stopPropagation(); $.rSearchClear.click(); }
      });
      $.rSearchClear.addEventListener("click", function () {
        $.rSearch.value = ""; S.q = ""; searchDebounced.cancel();
        if (S.tab === "discover") search(true); else renderList();
        $.rSearch.focus();
      });
      $.rHttps.addEventListener("click", function () {
        S.httpsOnly = !S.httpsOnly; prefs.httpsOnly = S.httpsOnly; savePrefs();
        $.rHttps.classList.toggle("is-active", S.httpsOnly); $.rHttps.setAttribute("aria-pressed", String(S.httpsOnly));
        search(true);
      });
      $.rClearFilters.addEventListener("click", clearFilters);
      $.rClearRecent.addEventListener("click", function () {
        recents = []; saveJSON(LS.recents, recents); renderList(); renderPanel(); toast("History cleared");
      });

      $.rQuick.addEventListener("click", function (e) {
        var t = e.target.closest("[data-qtag]"), c = e.target.closest("[data-qcountry]");
        if (t) { var v = t.getAttribute("data-qtag"); S.tag = S.tag === v ? "" : v; prefs.tag = S.tag; savePrefs(); renderQuick(); $.pTag.setValue(S.tag); search(true); }
        if (c) { var cv = c.getAttribute("data-qcountry"); S.country = S.country === cv ? "" : cv; S.state = ""; prefs.country = S.country; savePrefs(); $.pCountry.setValue(S.country); refreshStates(); renderQuick(); search(true); }
      });

      $.rMore.addEventListener("click", function () { if (!S.loading) search(false); });

      $.rGrid.addEventListener("click", function (e) {
        if (e.target.closest('[data-act="retry"]')) { boot(true); return; }
        var card = e.target.closest(".rcard"); if (!card) return;
        var st = findStation(card.getAttribute("data-id")); if (!st) return;
        var act = e.target.closest("[data-act]");
        if (act && act.getAttribute("data-act") === "fav") { toggleFav(st); return; }
        if (card.classList.contains("is-unplayable")) { toast("This HLS station can't be played on this device"); return; }
        if (P.station && P.station.id === st.id && P.st !== "error" && P.st !== "stopped" && P.st !== "idle") toggle();
        else play(st);
      });

      $.rxPlay.addEventListener("click", toggle);
      $.rxStop.addEventListener("click", stop);
      $.rxRetry.addEventListener("click", function () { if (P.station) play(P.station); });
      $.rxFav.addEventListener("click", function () { if (P.station) toggleFav(P.station); });
      $.rxMute.addEventListener("click", toggleMute);
      $.rxVol.addEventListener("input", function () { setVolume($.rxVol.value / 100); });

      $.rBarPlay.addEventListener("click", toggle);
      $.rBarStop.addEventListener("click", stop);
      $.rBarInfo.addEventListener("click", function () { screen.scrollTo({ top: 0, behavior: "smooth" }); });
      $.rScrim.addEventListener("click", closePickers);
    }

    // Keyboard: while the Radio screen is up, the shortcuts control the stream (not the hidden local player).
    window.addEventListener("keydown", function (e) {
      if (!S.open) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        if (!(tag === "INPUT" && document.activeElement.type === "range")) return;
      }
      if (document.getElementById("dialog") && !document.getElementById("dialog").hidden) return;
      if ((e.key === " " || e.key === "Enter") && e.target.closest && e.target.closest("button")) return;   // let focused buttons act
      var handled = true;
      switch (e.key) {
        case " ": toggle(); break;
        case "m": case "M": toggleMute(); break;
        case "ArrowUp": setVolume(audio.volume + 0.05); break;
        case "ArrowDown": setVolume(audio.volume - 0.05); break;
        case "ArrowLeft": case "ArrowRight": case "n": case "N": case "p": case "P": case "l": case "L": case "f": case "F": break;   // local-player keys: swallow
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    // ---------------------------------------------------------------- first paint of the sidebar bits (local data only)
    renderPanel();
    renderMini();

    window.GhostRadio = {
      open: open, leave: leave, stop: stop,
      isOpen: function () { return S.open; },
      isActive: function () { return !!P.station && !!ACTIVE[P.st]; }
    };
  }
})();
