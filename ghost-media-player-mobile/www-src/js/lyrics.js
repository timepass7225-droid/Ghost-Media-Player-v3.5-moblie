/* Ghost Media Player — Lyrics Engine
 *
 * Shows lyrics for the song that is playing in the normal player. Lyrics are
 * only ever shown if real lyrics data exists locally — nothing is invented and
 * no online service is used (the project has no lyrics API).
 *
 * Where lyrics come from, in this order:
 *   1. a lyrics file the user loaded manually for this song earlier (remembered)
 *   2. a .lrc / .txt that was selected or dropped together with the song and
 *      has the same file name  (song.mp3 + song.lrc)
 *   3. Electron desktop only: song.lrc / song.txt in the same folder as the song
 *   4. lyrics embedded in the audio file's own tags (MP3 USLT, FLAC LYRICS)
 *   5. nothing -> "No lyrics found" and a Load Lyrics button
 *
 * Timestamped lyrics (LRC) are synchronised to the real playback position;
 * plain text is shown as plain text and clearly labelled "not synchronized".
 * Cost model: the active line is only recomputed (binary search) while the
 * Lyrics screen is open AND something is playing; a paused / hidden screen does
 * no per-frame work at all.
 */
(function () {
  "use strict";
  if (window.GhostLyrics) return;

  var LS_KEY = "ghost.lyrics.v1";
  var MAX_FILE = 1024 * 1024;          // lyric files above 1 MB are rejected
  var MAX_SAVED = 40;                  // remembered manual lyrics (LRU)
  var MAX_SAVED_TEXT = 200 * 1024;
  var FOLLOW_PAUSE_MS = 3500;          // auto-scroll pause after the user scrolls

  /* =================================================================== parsing */
  var STAMP = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;

  function stampToSec(m) {
    var sec = m[2].replace(":", ".");
    return parseInt(m[1], 10) * 60 + parseFloat(sec);
  }

  function parseLRC(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    var raw = text.split(/\r\n|\r|\n/);
    var meta = {}, lines = [], plain = [], stamped = 0;

    raw.forEach(function (r) {
      var line = r.trim();
      if (!line) { plain.push(""); return; }
      var md = /^\[([A-Za-z#]+):(.*)\]$/.exec(line);          // [ti:..] [ar:..] [offset:..]
      if (md) { meta[md[1].toLowerCase()] = md[2].trim(); return; }
      var times = [], rest = line, m;
      while ((m = STAMP.exec(rest))) { times.push(stampToSec(m)); rest = rest.slice(m[0].length); }
      rest = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();   // enhanced word tags
      if (!times.length) { plain.push(line); return; }
      times.forEach(function (t) { lines.push({ t: t, text: rest }); });
      plain.push(rest);
      stamped += 1;
    });

    var timed = stamped >= 2;
    var off = parseInt(meta.offset, 10);
    var offSec = isFinite(off) ? off / 1000 : 0;               // +offset => lyrics appear earlier
    if (timed) {
      lines.forEach(function (l, i) { l.i = i; l.t = Math.max(0, l.t - offSec); });
      lines.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
      lines.forEach(function (l) { delete l.i; });
    }
    // trim leading/trailing blank rows of the plain version
    while (plain.length && !plain[0]) plain.shift();
    while (plain.length && !plain[plain.length - 1]) plain.pop();
    var plainOut = plain.map(function (p) { return p; });
    var hasText = timed ? lines.some(function (l) { return l.text; }) : plainOut.some(function (p) { return p; });
    return { timed: timed, lines: timed ? lines : [], plain: timed ? [] : plainOut, meta: meta, hasText: hasText };
  }

  /* index of the last line whose time <= t, or -1 before the first line */
  function findLine(lines, t) {
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function decodeBytes(buf) {
    var u8 = new Uint8Array(buf);
    try {
      if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
      if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
      try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
      catch (e) { return new TextDecoder("windows-1252").decode(u8); }   // old Latin-1 LRC files
    } catch (e) { return ""; }
  }
  function looksBinary(s) {
    var n = Math.min(s.length, 4096), bad = 0;
    for (var i = 0; i < n; i++) {
      var c = s.charCodeAt(i);
      if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad++;
    }
    return n > 0 && bad / n > 0.02;
  }
  function readFileBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  /* Resolves to { text } or { error } — never throws. */
  function readLyricFile(file) {
    if (!file) return Promise.resolve({ error: "No file selected." });
    if (file.size > MAX_FILE) return Promise.resolve({ error: "That file is too large to be a lyrics file." });
    return readFileBuffer(file).then(function (buf) {
      var text = decodeBytes(buf);
      if (!text.trim() || looksBinary(text)) return { error: "That doesn't look like a text lyrics file." };
      return { text: text };
    }, function () { return { error: "That file couldn't be read." }; });
  }

  /* ============================================================ file registry */
  function stem(name) {
    var n = String(name || "");
    var i = n.lastIndexOf(".");
    if (i > 0) n = n.slice(0, i);
    try { n = n.normalize("NFC"); } catch (e) { /* old engines */ }
    return n.trim().toLowerCase();
  }
  function extOf(name) { return ((String(name || "").split(".").pop()) || "").toLowerCase(); }
  function isLyricName(name) { var e = extOf(name); return e === "lrc" || e === "txt"; }

  var registry = {};       // stem -> { lrc: File, txt: File }

  /* Called by the player when files are opened/dropped. Lyric files are
   * remembered by name (not read yet) and everything else is handed back. */
  function ingest(fileList) {
    var media = [], lyricCount = 0, i, f;
    for (i = 0; i < fileList.length; i++) {
      f = fileList[i];
      if (f && isLyricName(f.name)) {
        var k = stem(f.name), e = extOf(f.name);
        (registry[k] = registry[k] || {})[e] = f;
        lyricCount++;
      } else media.push(f);
    }
    return { media: media, lyricCount: lyricCount };
  }
  function findRegistered(item) {
    var r = registry[stem(item.name)];
    return r ? (r.lrc || r.txt || null) : null;
  }

  /* ================================================================ persistence */
  function loadStore() {
    try { var s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && s.items && s.order) return s; } catch (e) { /* ignore */ }
    return { order: [], items: {} };
  }
  var store = loadStore();
  function saveStore() { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* storage full / unavailable */ } }
  function touch(key) {
    store.order = store.order.filter(function (k) { return k !== key; });
    store.order.push(key);
    while (store.order.length > MAX_SAVED) delete store.items[store.order.shift()];
  }
  function putStore(key, patch) {
    var cur = store.items[key] || {};
    Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; });
    if (!cur.text && !cur.o) { delete store.items[key]; store.order = store.order.filter(function (k) { return k !== key; }); }
    else { store.items[key] = cur; touch(key); }
    saveStore();
  }
  function keyOf(item) { return item.name + "|" + item.size; }

  /* ===================================================================== state */
  var S = {
    open: false, built: false,
    item: null, token: 0,
    status: "idle",          // idle | searching | ready | none | unsupported
    lyrics: null,            // { timed, lines, plain, meta, source: {kind, name} }
    tags: {},
    userOffset: 0,           // seconds the lyrics are shifted later (+) / earlier (-)
    active: -2,
    followUntil: 0,
    raf: 0
  };
  var dismissed = {};        // key -> true while the user removed lyrics for that song (this session)
  var $ = {};                // cached screen elements

  function core() { return window.GhostCore || null; }
  function player() { var c = core(); return c ? c.player : null; }
  function toast(msg) { var c = core(); if (c && c.toast) c.toast(msg); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(t) { return window.ghostFormatTime ? window.ghostFormatTime(t) : String(Math.floor(t)); }
  function reduceMotion() { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }

  /* ================================================================== resolving */
  function applyParsed(parsed, source, text) {
    if (!parsed.hasText) return false;
    S.lyrics = { timed: parsed.timed, lines: parsed.lines, plain: parsed.plain, meta: parsed.meta, source: source, text: text };
    S.status = "ready";
    return true;
  }

  function resolve(item) {
    var token = ++S.token;
    S.item = item; S.lyrics = null; S.tags = {}; S.active = -2; S.userOffset = 0;
    if (!item) { S.status = "idle"; render(); return; }
    if (item.kind !== "audio" && item.kind !== "video") { S.status = "unsupported"; render(); return; }
    S.status = "searching"; render();

    var key = keyOf(item);
    var saved = store.items[key];
    if (saved && typeof saved.o === "number") S.userOffset = saved.o;

    var tagP = item.kind === "audio" && window.GhostTags ? window.GhostTags.read(item.file) : Promise.resolve({});
    var tagsDone = tagP.then(function (t) { if (token === S.token) { S.tags = t || {}; renderHead(); } return t || {}; });

    function stale() { return token !== S.token; }
    function fromText(text, src) {
      var parsed = parseLRC(text);
      return applyParsed(parsed, src, text);
    }

    var chain = Promise.resolve(false);

    // 1. remembered manual lyrics
    if (saved && saved.text) chain = chain.then(function () { return fromText(saved.text, { kind: "manual", name: saved.n || "lyrics file" }); });

    if (!dismissed[key]) {
      // 2. selected / dropped together with the song
      chain = chain.then(function (done) {
        if (done || stale()) return done;
        var f = findRegistered(item);
        if (!f) return false;
        return readLyricFile(f).then(function (r) {
          if (stale() || !r.text) return false;
          return fromText(r.text, { kind: "selected", name: f.name });
        });
      });
      // 3. same folder (Electron desktop)
      chain = chain.then(function (done) {
        if (done || stale()) return done;
        if (!(window.ghostLyrics && window.ghostLyrics.find) || !item.file) return false;
        return window.ghostLyrics.find(item.file).then(function (r) {
          if (stale() || !r || !r.data) return false;
          var text = decodeBytes(r.data.buffer ? r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength) : r.data);
          if (!text.trim() || looksBinary(text)) return false;
          return fromText(text, { kind: "sibling", name: r.name });
        }, function () { return false; });
      });
      // 4. embedded in the audio file
      chain = chain.then(function (done) {
        if (done || stale()) return done;
        return tagsDone.then(function (t) {
          if (stale() || !t || !t.lyrics) return false;
          return fromText(t.lyrics, { kind: "embedded", name: "" });
        });
      });
    }

    chain.then(function (done) {
      if (stale()) return;
      if (!done) { S.status = "none"; S.lyrics = null; }
      S.active = -2;
      render();
    }, function () { if (!stale()) { S.status = "none"; render(); } });
  }

  /* Manual: user picked a file for the current song */
  function loadManual(file) {
    var item = S.item;
    if (!item || (item.kind !== "audio" && item.kind !== "video")) { toast("Open a song first"); return; }
    readLyricFile(file).then(function (r) {
      if (item !== S.item) return;                       // the song changed while reading
      if (r.error) { toast(r.error); return; }
      var parsed = parseLRC(r.text);
      if (!parsed.hasText) { toast("No lyrics text found in that file"); return; }
      var key = keyOf(item);
      delete dismissed[key];
      S.token++;                                        // cancel any in-flight auto search
      applyParsed(parsed, { kind: "manual", name: file.name }, r.text);
      var patch = { n: file.name, t: Date.now() };
      if (r.text.length <= MAX_SAVED_TEXT) patch.text = r.text;
      putStore(key, patch);
      S.active = -2;
      render();
      toast(parsed.timed ? "Synchronized lyrics loaded" : "Lyrics loaded (plain text, not synchronized)");
    });
  }

  function clearLyrics() {
    var item = S.item;
    if (!item || !S.lyrics) return;
    var key = keyOf(item);
    dismissed[key] = true;
    putStore(key, { text: null, n: null, t: null, o: null });
    S.token++;
    S.lyrics = null; S.status = "none"; S.userOffset = 0; S.active = -2;
    render();
    toast("Lyrics removed");
  }

  function nudge(deltaSec) {
    if (!S.item || !S.lyrics || !S.lyrics.timed) return;
    S.userOffset = deltaSec === 0 ? 0 : Math.round((S.userOffset + deltaSec) * 10) / 10;
    var key = keyOf(S.item);
    putStore(key, { o: S.userOffset === 0 ? null : S.userOffset });
    renderSync();
    S.active = -2;
    updateActive(true);
  }

  /* ===================================================================== screen */
  var ICON = {
    play: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg>',
    pause: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/></svg>',
    prev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6 9 12l9 6V6Z" fill="currentColor"/><rect x="5.5" y="6" width="1.8" height="12" rx="0.9" fill="currentColor"/></svg>',
    next: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l9 6-9 6V6Z" fill="currentColor"/><rect x="16.7" y="6" width="1.8" height="12" rx="0.9" fill="currentColor"/></svg>',
    file: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.5 12.5h5M9.5 15.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    x: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    mic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    micBig: '<svg width="44" height="44" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v13m0 0-5-5m5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  function build() {
    if (S.built) return;
    S.built = true;
    $.screen.innerHTML =
      '<div class="ly-wrap">' +
        '<header class="ly-head">' +
          '<div class="ly-head__meta">' +
            '<div class="ly-kicker"><span class="ly-kicker__ico" aria-hidden="true">'+ICON.mic+'</span> LYRICS</div>' +
            '<h2 class="ly-title" id="lyTitle">Nothing playing</h2>' +
            '<div class="ly-artist" id="lyArtist" hidden></div>' +
            '<div class="ly-source" id="lySource" hidden></div>' +
          '</div>' +
          '<div class="ly-head__actions">' +
            '<button type="button" class="btn btn--ghost" id="lyLoad">' + ICON.file + ' Load Lyrics</button>' +
            '<button type="button" class="btn btn--ghost" id="lyClear">' + ICON.x + ' Remove</button>' +
          '</div>' +
        '</header>' +
        '<div class="ly-sync" id="lySync" hidden>' +
          '<span class="ly-sync__label">Sync</span>' +
          '<button type="button" class="pillbtn" id="lyEarlier" title="Show lyrics earlier">\u2212 0.5s</button>' +
          '<span class="ly-sync__val" id="lySyncVal">0.0s</span>' +
          '<button type="button" class="pillbtn" id="lyLater" title="Show lyrics later">+ 0.5s</button>' +
          '<button type="button" class="link-btn" id="lySyncReset">Reset</button>' +
        '</div>' +
        '<div class="ly-body" id="lyBody" tabindex="-1">' +
          '<div class="ly-lines" id="lyLines"></div>' +
          '<div class="ly-empty" id="lyEmpty"></div>' +
          '<button type="button" class="ly-follow" id="lyFollow" hidden>' + ICON.down + ' Back to current line</button>' +
        '</div>' +
        '<footer class="ly-bar">' +
          '<div class="ly-bar__btns">' +
            '<button type="button" class="iconbtn" id="lyPrev" aria-label="Previous">' + ICON.prev + '</button>' +
            '<button type="button" class="iconbtn iconbtn--play" id="lyPlay" aria-label="Play">' + ICON.play + '</button>' +
            '<button type="button" class="iconbtn" id="lyNext" aria-label="Next">' + ICON.next + '</button>' +
          '</div>' +
          '<div class="ly-bar__seek">' +
            '<span class="controls__time" id="lyCur">0:00</span>' +
            '<div class="seek" id="lySeek"><div class="seek__fill" id="lyFill"></div><div class="seek__thumb" id="lyThumb"></div>' +
              '<input class="seek__range" id="lySeekRange" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek" /></div>' +
            '<span class="controls__time" id="lyDur">0:00</span>' +
          '</div>' +
        '</footer>' +
        '<input type="file" id="lyFile" hidden />' +
      '</div>';

    ["lyTitle", "lyArtist", "lySource", "lyLoad", "lyClear", "lySync", "lySyncVal", "lyEarlier", "lyLater", "lySyncReset",
     "lyBody", "lyLines", "lyEmpty", "lyFollow", "lyPrev", "lyPlay", "lyNext", "lyCur", "lyDur", "lyFill", "lyThumb",
     "lySeekRange", "lyFile"].forEach(function (id) { $[id] = document.getElementById(id); });

    $.lyLoad.addEventListener("click", function () { $.lyFile.click(); });
    $.lyFile.addEventListener("change", function () {
      var f = $.lyFile.files && $.lyFile.files[0];
      $.lyFile.value = "";
      if (f) loadManual(f);
    });
    $.lyClear.addEventListener("click", clearLyrics);
    $.lyEarlier.addEventListener("click", function () { nudge(-0.5); });
    $.lyLater.addEventListener("click", function () { nudge(0.5); });
    $.lySyncReset.addEventListener("click", function () { nudge(0); });

    $.lyPlay.addEventListener("click", function () { var p = player(); if (p && S.item) p.togglePlay(); });
    $.lyPrev.addEventListener("click", function () { var c = core(); if (c) c.step(-1); });
    $.lyNext.addEventListener("click", function () { var c = core(); if (c) c.step(1); });
    $.lySeekRange.addEventListener("input", function () {
      var p = player();
      if (p && p.canSeek()) { p.seekFraction($.lySeekRange.value / 1000); updateActive(true); tickBar(); }
    });

    // clicking a timed line jumps to it
    $.lyLines.addEventListener("click", function (e) {
      var el = e.target.closest(".ly-line");
      if (!el || !S.lyrics || !S.lyrics.timed) return;
      var line = S.lyrics.lines[+el.dataset.i], p = player();
      if (line && p && p.canSeek()) {
        S.followUntil = 0;
        p.seekTo(line.t + S.userOffset);
        S.active = -2;
        updateActive(true);
      }
    });

    // manual scrolling pauses auto-follow for a moment
    function userScrolled() {
      if (!S.lyrics || !S.lyrics.timed) return;
      S.followUntil = Date.now() + FOLLOW_PAUSE_MS;
      $.lyFollow.hidden = false;
    }
    ["wheel", "touchmove"].forEach(function (evt) { $.lyBody.addEventListener(evt, userScrolled, { passive: true }); });
    $.lyBody.addEventListener("keydown", function (e) { if (/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown)$/.test(e.key)) userScrolled(); });
    $.lyFollow.addEventListener("click", function () {
      S.followUntil = 0; $.lyFollow.hidden = true;
      scrollToActive(true);
    });

    // playback events (listened to on the real media elements; nothing polls while paused)
    var p = player();
    if (p) {
      [p.audioEl, p.videoEl].forEach(function (el) {
        ["play", "playing"].forEach(function (e) { el.addEventListener(e, onPlayState); });
        ["pause", "ended", "emptied"].forEach(function (e) { el.addEventListener(e, onPlayState); });
        ["timeupdate", "seeked", "durationchange", "loadedmetadata"].forEach(function (e) { el.addEventListener(e, onTimeEvent); });
      });
    }
  }

  function isPlaying() { var p = player(); return !!(p && S.item && !p.isPaused()); }
  function curTime() { var p = player(); return p && p.activeEl ? (p.activeEl.currentTime || 0) : 0; }

  function onPlayState() {
    if (!S.open) return;
    renderPlayIcon();
    if (isPlaying()) startLoop(); else { stopLoop(); updateActive(false); tickBar(); }
  }
  function onTimeEvent() {
    if (!S.open || S.raf) return;      // while the frame loop runs it already keeps everything current
    updateActive(false); tickBar();
  }

  function startLoop() {
    if (S.raf || !S.open) return;
    (function frame() {
      S.raf = 0;
      if (!S.open || !isPlaying()) return;
      updateActive(false); tickBar();
      S.raf = requestAnimationFrame(frame);
    })();
  }
  function stopLoop() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }

  /* ---------------------------------------------------------------- rendering */
  function titleInfo() {
    var item = S.item, t = S.tags || {}, meta = (S.lyrics && S.lyrics.meta) || {};
    var title = t.title || meta.ti || (item ? item.name.replace(/\.[^.]+$/, "") : "");
    var artist = t.artist || meta.ar || "";
    return { title: title, artist: artist };
  }
  function sourceLabel() {
    var L = S.lyrics;
    if (!L) return "";
    var how = { selected: "Loaded with the song", sibling: "Found next to the song", manual: "Loaded manually", embedded: "Embedded in the audio file" }[L.source.kind] || "";
    var file = L.source.name ? " \u00b7 " + L.source.name : "";
    return how + file;
  }

  function renderHead() {
    if (!S.built) return;
    var ti = titleInfo();
    if (!S.item) {
      $.lyTitle.textContent = "Nothing playing";
      $.lyArtist.hidden = true;
    } else {
      $.lyTitle.textContent = ti.title;
      $.lyArtist.hidden = !ti.artist;
      $.lyArtist.textContent = ti.artist;
    }
    var L = S.lyrics;
    $.lySource.hidden = !L;
    if (L) {
      $.lySource.innerHTML =
        '<span class="ly-badge ' + (L.timed ? "ly-badge--sync" : "ly-badge--plain") + '">' + (L.timed ? "Synchronized" : "Plain text \u00b7 not synchronized") + '</span> ' +
        '<span class="ly-source__txt">' + esc(sourceLabel()) + '</span>';
    }
    var canLoad = !!(S.item && (S.item.kind === "audio" || S.item.kind === "video"));
    $.lyLoad.disabled = !canLoad;
    $.lyLoad.title = canLoad ? "Pick a .lrc or text lyrics file for this song" : "Open a song first";
    $.lyClear.hidden = !L;
    renderSync();
    renderMini();
  }

  function renderSync() {
    if (!S.built) return;
    var show = !!(S.lyrics && S.lyrics.timed);
    $.lySync.hidden = !show;
    if (show) {
      $.lySyncVal.textContent = (S.userOffset > 0 ? "+" : "") + S.userOffset.toFixed(1) + "s";
      $.lySyncReset.disabled = S.userOffset === 0;
    }
  }

  function emptyBlock(title, text, withLoad) {
    return '<div class="ly-empty__icon" aria-hidden="true">'+ICON.micBig+'</div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      (withLoad ? '<button type="button" class="btn btn--primary" id="lyLoad2">' + ICON.file + ' Load Lyrics</button>' : '');
  }

  function render() {
    if (!S.built) { renderMini(); return; }
    renderHead();
    stopSyncState();
    var L = S.lyrics, radioOn = window.GhostRadio && window.GhostRadio.isActive && window.GhostRadio.isActive();
    $.lyLines.innerHTML = "";
    $.lyLines.className = "ly-lines";
    $.lyFollow.hidden = true;
    $.lyEmpty.hidden = true;

    if (S.status === "ready" && L) {
      if (L.timed) {
        var frag = document.createDocumentFragment();
        L.lines.forEach(function (ln, i) {
          var d = document.createElement("div");
          d.className = "ly-line" + (ln.text ? "" : " ly-line--gap");
          d.dataset.i = i;
          d.textContent = ln.text || "\u266a";
          frag.appendChild(d);
        });
        $.lyLines.appendChild(frag);
        $.lyLines.classList.add("is-timed");
      } else {
        var frag2 = document.createDocumentFragment();
        L.plain.forEach(function (txt) {
          var d = document.createElement("div");
          d.className = "ly-plain" + (txt ? "" : " ly-plain--blank");
          d.textContent = txt;
          frag2.appendChild(d);
        });
        $.lyLines.appendChild(frag2);
        $.lyLines.classList.add("is-plain");
      }
      $.lyBody.scrollTop = 0;
    } else {
      $.lyEmpty.hidden = false;
      if (S.status === "searching") {
        $.lyEmpty.innerHTML = emptyBlock("Looking for lyrics\u2026", "Checking files selected with the song, its folder and its tags.", false);
      } else if (S.status === "none") {
        $.lyEmpty.innerHTML = emptyBlock("No lyrics found",
          "Nothing matched this song: no .lrc / .txt with the same name, and no lyrics embedded in the file. Lyrics are never guessed or downloaded. " +
          "Tip: select song.mp3 and song.lrc together when opening files, or use Load Lyrics.", true);
      } else if (S.status === "unsupported") {
        $.lyEmpty.innerHTML = emptyBlock("No lyrics for images", "Lyrics are available for songs and videos.", false);
      } else if (radioOn) {
        $.lyEmpty.innerHTML = emptyBlock("Radio is playing", "Lyrics work with local songs. Radio streams don\u2019t carry lyrics data. Open a song to see its lyrics.", false);
      } else {
        $.lyEmpty.innerHTML = emptyBlock("Nothing playing", "Open a song \u2014 if a matching .lrc file is available its lyrics appear here in sync.", false);
      }
      var b2 = document.getElementById("lyLoad2");
      if (b2) b2.addEventListener("click", function () { $.lyFile.click(); });
    }
    renderPlayIcon();
    S.active = -2;
    updateActive(true);
    tickBar();
    if (S.open && isPlaying()) startLoop();
  }
  function stopSyncState() { S.followUntil = 0; }

  function renderPlayIcon() {
    if (!S.built) return;
    var paused = !isPlaying();
    $.lyPlay.innerHTML = paused ? ICON.play : ICON.pause;
    $.lyPlay.setAttribute("aria-label", paused ? "Play" : "Pause");
    $.lyPlay.disabled = !S.item;
    var c = core(), n = c && c.getItems ? c.getItems().length : 0;
    $.lyPrev.disabled = n < 2 || !S.item;
    $.lyNext.disabled = n < 2 || !S.item;
  }

  function tickBar() {
    if (!S.built) return;
    var p = player(), pr = p ? p.getProgress() : null;
    var frac = pr ? pr.fraction : 0;
    $.lyCur.textContent = fmt(pr ? pr.current : 0);
    $.lyDur.textContent = fmt(pr ? pr.duration : 0);
    $.lyFill.style.width = (frac * 100) + "%";
    $.lyThumb.style.left = (frac * 100) + "%";
    $.lySeekRange.value = Math.round(frac * 1000);
    $.lySeekRange.disabled = !(p && p.canSeek());
  }

  /* ------------------------------------------------------------ active line */
  function updateActive(forceScroll) {
    if (!S.built || !S.lyrics || !S.lyrics.timed) return;
    var idx = findLine(S.lyrics.lines, curTime() - S.userOffset);
    if (idx === S.active) return;
    var kids = $.lyLines.children, prev = S.active;
    // update only the classes that change when stepping one line; rebuild all on a jump
    if (prev >= 0 && idx === prev + 1) {
      if (kids[prev]) { kids[prev].classList.remove("is-active"); kids[prev].classList.add("is-past"); }
    } else {
      for (var i = 0; i < kids.length; i++) {
        kids[i].classList.toggle("is-past", i < idx);
        kids[i].classList.remove("is-active");
      }
    }
    if (idx >= 0 && kids[idx]) { kids[idx].classList.remove("is-past"); kids[idx].classList.add("is-active"); }
    S.active = idx;
    if (idx >= 0) scrollToActive(forceScroll);
  }

  function scrollToActive(force) {
    if (!force && Date.now() < S.followUntil) return;
    if (!force && S.followUntil && Date.now() >= S.followUntil) { S.followUntil = 0; $.lyFollow.hidden = true; }
    var el = $.lyLines.children[S.active];
    if (!el) return;
    var target = el.offsetTop - ($.lyBody.clientHeight / 2) + (el.offsetHeight / 2);
    $.lyBody.scrollTo({ top: Math.max(0, target), behavior: reduceMotion() || force === "instant" ? "auto" : "smooth" });
  }

  /* --------------------------------------------------------- sidebar panel */
  function renderMini() {
    var panel = document.getElementById("panel-lyrics");
    if (!panel) return;
    var ti = S.item ? titleInfo() : null;
    var status;
    if (!S.item) status = "No song loaded.";
    else if (S.status === "searching") status = "Looking for lyrics\u2026";
    else if (S.status === "ready" && S.lyrics) status = (S.lyrics.timed ? "Synchronized lyrics" : "Plain-text lyrics") + " \u00b7 " + sourceLabel();
    else if (S.status === "unsupported") status = "Lyrics are for songs and videos.";
    else status = "No lyrics found for this song.";
    panel.innerHTML =
      '<div class="radio-side">' +
        '<p class="radio-side__intro">Synchronized lyrics for the song you are playing. Put <b>song.lrc</b> next to <b>song.mp3</b>, ' +
        'or select both together when you open files. Nothing is downloaded or guessed.</p>' +
        '<div class="ly-side__now"><b>' + esc(ti ? ti.title : "\u2014") + '</b><span>' + esc(status) + '</span></div>' +
        '<button type="button" class="btn btn--ghost btn--block" id="lySideLoad"' + (S.item && S.item.kind !== "image" ? "" : " disabled") + '>' + ICON.file + ' Load Lyrics\u2026</button>' +
      '</div>';
    document.getElementById("lySideLoad").addEventListener("click", function () {
      if (!S.built) { build(); }
      $.lyFile.click();
    });
  }

  /* --------------------------------------------------------- open / leave */
  function open() {
    if (!window.GhostScreens) return;
    window.GhostScreens.show("lyrics");
  }
  function leave() { if (window.GhostScreens) window.GhostScreens.hide("lyrics"); }

  function onShow() {
    build();
    S.open = true;
    render();
    $.lyBody.focus({ preventScroll: true });
    if (isPlaying()) startLoop();
  }
  function onHide() { S.open = false; stopLoop(); }

  /* ------------------------------------------------------------------ init */
  function init() {
    $.screen = document.getElementById("lyricsScreen");
    if (!$.screen || !window.GhostScreens) return;
    window.GhostScreens.register("lyrics", { el: $.screen, title: "Lyrics", onShow: onShow, onHide: onHide });

    document.querySelectorAll(".navitem").forEach(function (b) {
      b.addEventListener("click", function () {
        var p = b.dataset.panel;
        if (p === "lyrics") open();
        else if (p === "library" || p === "recent" || p === "radio" || p === "dj") leave();
      });
    });

    // The normal player tells us which song is current (also null when nothing is).
    document.addEventListener("ghost:trackchange", function (e) {
      var item = e.detail ? e.detail.item : null;
      if (item === S.item && item) return;
      resolve(item);
      // Video / images need the normal player viewport, so leave the Lyrics screen for those.
      if (S.open && item && item.kind !== "audio") leave();
    });

    renderMini();
    var c = core();
    if (c && c.getCurrent && c.getCurrent()) resolve(c.getCurrent());
  }

  window.GhostLyrics = {
    open: open, leave: leave, ingest: ingest,
    // re-run the lookup for the current song (used after lyric files were added while it plays)
    refresh: function () { var c = core(); var it = c && c.getCurrent ? c.getCurrent() : S.item; if (it) resolve(it); },
    isOpen: function () { return S.open; },
    // exposed for the automated tests / diagnostics; the UI never needs them
    parseLRC: parseLRC, findLine: findLine, decodeBytes: decodeBytes,
    getState: function () { return { status: S.status, lyrics: S.lyrics, active: S.active, userOffset: S.userOffset, tags: S.tags }; }
  };

  document.addEventListener("DOMContentLoaded", init);
})();
