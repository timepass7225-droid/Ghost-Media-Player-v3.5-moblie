/* Ghost Media Player — app shell
 * Wires DOM, playlist, playback engine, settings and keyboard shortcuts together.
 * Vanilla JS, no build step, no external network calls.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    GhostThemes.init();

    var els = {
      app: document.getElementById("app"),
      sidebar: document.getElementById("sidebar"),
      sidebarToggle: document.getElementById("sidebarToggle"),
      nowTitle: document.getElementById("nowTitle"),

      openFilesBtn: document.getElementById("openFilesBtn"),
      emptyOpenBtn: document.getElementById("emptyOpenBtn"),
      fileInput: document.getElementById("fileInput"),
      dropOverlay: document.getElementById("dropOverlay"),

      libraryList: document.getElementById("libraryList"),
      libraryEmpty: document.getElementById("libraryEmpty"),
      libCount: document.getElementById("libCount"),
      recentList: document.getElementById("recentList"),
      recentEmpty: document.getElementById("recentEmpty"),
      clearRecentBtn: document.getElementById("clearRecentBtn"),
      panelSettings: document.getElementById("panel-settings"),
      panelThemes: document.getElementById("panel-themes"),
      panelEffects: document.getElementById("panel-effects"),

      loadingState: document.getElementById("loadingState"),
      loadingText: document.getElementById("loadingText"),
      stopBtn: document.getElementById("stopBtn"),
      boostBtn: document.getElementById("boostBtn"),

      viewport: document.getElementById("viewport"),
      visualLayer: document.getElementById("visualLayer"),
      dialog: document.getElementById("dialog"),
      emptyState: document.getElementById("emptyState"),
      videoEl: document.getElementById("videoEl"),
      audioStage: document.getElementById("audioStage"),
      audioEl: document.getElementById("audioEl"),
      audioName: document.getElementById("audioName"),
      imageStage: document.getElementById("imageStage"),
      imageEl: document.getElementById("imageEl"),
      imageToolbar: document.getElementById("imageToolbar"),
      imgPrev: document.getElementById("imgPrev"),
      imgNext: document.getElementById("imgNext"),
      imgCounter: document.getElementById("imgCounter"),
      imgFullscreen: document.getElementById("imgFullscreen"),
      errorState: document.getElementById("errorState"),
      errorText: document.getElementById("errorText"),
      errorSkipBtn: document.getElementById("errorSkipBtn"),

      controls: document.getElementById("controls"),
      seekTrack: document.getElementById("seekTrack"),
      seekRange: document.getElementById("seekRange"),
      seekFill: document.getElementById("seekFill"),
      seekBuffered: document.getElementById("seekBuffered"),
      seekThumb: document.getElementById("seekThumb"),
      timeCurrent: document.getElementById("timeCurrent"),
      timeDuration: document.getElementById("timeDuration"),

      playBtn: document.getElementById("playBtn"),
      playIcon: document.getElementById("playIcon"),
      prevBtn: document.getElementById("prevBtn"),
      nextBtn: document.getElementById("nextBtn"),
      muteBtn: document.getElementById("muteBtn"),
      volIcon: document.getElementById("volIcon"),
      volRange: document.getElementById("volRange"),
      volFill: document.getElementById("volFill"),
      loopBtn: document.getElementById("loopBtn"),
      speedBtn: document.getElementById("speedBtn"),
      speedMenu: document.getElementById("speedMenu"),
      fullscreenBtn: document.getElementById("fullscreenBtn"),
      toast: document.getElementById("toast")
    };

    var player = new GhostPlayer(els.videoEl, els.audioEl);
    var lib = GhostLibrary;
    var fx = window.GhostAudioFX;
    var state = {
      currentId: null,
      currentKind: null,
      isSeeking: false,
      hideTimer: null,
      loopMode: lib.settings.loopMode || "off",
      shuffle: !!lib.settings.shuffle, played: [], history: [],
      sidebarPanel: "library",
      // Requested boost level in percent. The gain stage only follows it when
      // the current source can legally be routed through Web Audio.
      desiredBoost: Math.max(100, Math.min(400, lib.settings.audioBoost || 100)),
      // Self-healing playback: a one-off decoder / file-read hiccup must not kill the track.
      playedOk: false, recoverId: null, recoverTries: 0, lastTime: 0, resumeAt: null
    };

    // Always read the media elements through the player rather than caching the node.
    function vEl() { return player.videoEl; }
    function aEl() { return player.audioEl; }

    // Restore the saved boost level without creating an AudioContext before it
    // is needed — the gain is pushed to the graph the first time media attaches.
    if (fx && fx.isSupported() && state.desiredBoost > 100) {
      fx.boost = state.desiredBoost / 100;
    }

    player.setVolume((lib.settings.defaultVolume || 80) / 100);
    els.volRange.value = lib.settings.defaultVolume || 80;
    els.volFill.style.width = (lib.settings.defaultVolume || 80) + "%";
    player.setLoopOne(state.loopMode === "one");

    // ---------------------------------------------------------------- utils
    function toast(msg) {
      els.toast.textContent = msg;
      els.toast.hidden = false;
      requestAnimationFrame(function () { els.toast.classList.add("is-visible"); });
      clearTimeout(toast._t);
      toast._t = setTimeout(function () {
        els.toast.classList.remove("is-visible");
        setTimeout(function () { els.toast.hidden = true; }, 250);
      }, 2200);
    }

    function iconFor(kind) {
      if (kind === "video") return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h9A1.5 1.5 0 0 1 16 6.5v11A1.5 1.5 0 0 1 14.5 19h-9A1.5 1.5 0 0 1 4 17.5v-11Z" stroke="currentColor" stroke-width="1.4"/><path d="m16 10 4-2.5v9L16 14" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      if (kind === "audio") return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 17V5.6l10-1.8v11.2M9 17a2.6 2.6 0 1 1-5.2 0A2.6 2.6 0 0 1 9 17Zm10-2.4a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="4" y="4.5" width="16" height="15" rx="1.6" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><path d="m6 17 4.5-5 3 3.2L16.5 12 19 15.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    }

    // ---------------------------------------------------------------- library rendering
    function renderLibrary() {
      els.libraryList.innerHTML = "";
      els.libCount.textContent = lib.items.length;
      els.libraryEmpty.hidden = lib.items.length > 0;
      document.dispatchEvent(new CustomEvent("ghost:librarychange"));
      lib.items.forEach(function (item) {
        var li = document.createElement("li");
        li.className = "media-item" + (item.id === state.currentId ? " is-playing" : "");
        li.dataset.id = item.id;
        li.dataset.kind = item.kind;
        li.innerHTML =
          '<span class="media-item__icon">' + iconFor(item.kind) + '</span>' +
          '<span class="media-item__meta">' +
            '<div class="media-item__name">' + escapeHtml(item.name) + '</div>' +
            '<div class="media-item__sub">' + item.kind + ' · ' + item.sizeLabel + '</div>' +
          '</span>' +
          '<button class="media-item__remove" aria-label="Remove" data-remove="' + item.id + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' +
          '</button>';
        els.libraryList.appendChild(li);
      });
      applyLibSearch();
    }
    // One unified library (music, video, photos, GIFs together). Optional live search only; no category views.
    function applyLibSearch() {
      var q = (document.getElementById("libSearch") || {}).value || "";
      q = q.trim().toLowerCase();
      Array.prototype.forEach.call(els.libraryList.children, function (li) {
        var n = li.querySelector(".media-item__name");
        li.hidden = !!q && !(n && n.textContent.toLowerCase().indexOf(q) !== -1);
      });
    }
    var libSearchEl = document.getElementById("libSearch");
    if (libSearchEl) libSearchEl.addEventListener("input", applyLibSearch);

    function renderRecents() {
      els.recentList.innerHTML = "";
      els.recentEmpty.hidden = lib.recents.length > 0;
      lib.recents.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "media-item";
        li.innerHTML =
          '<span class="media-item__icon">' + iconFor(r.kind) + '</span>' +
          '<span class="media-item__meta">' +
            '<div class="media-item__name">' + escapeHtml(r.name) + '</div>' +
            '<div class="media-item__sub">' + r.kind + ' · ' + r.sizeLabel + '</div>' +
          '</span>';
        li.title = "Re-open this file to play it again";
        els.recentList.appendChild(li);
      });
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    // ---------------------------------------------------------------- opening files
    function handleFiles(fileList) {
      if (!fileList || !fileList.length) return;
      // .lrc / .txt files selected or dropped together with songs are kept for the Lyrics Engine
      // (matched to a song by file name) instead of being rejected as unsupported media.
      if (window.GhostLyrics) {
        var ing = window.GhostLyrics.ingest(fileList);
        if (ing.lyricCount) {
          fileList = ing.media;
          if (!fileList.length) {
            window.GhostLyrics.refresh();
            toast(ing.lyricCount === 1 ? "Lyrics file added \u2014 used when its song plays" : ing.lyricCount + " lyrics files added");
            return;
          }
        }
      }
      var added = lib.addFiles(fileList);
      renderLibrary();
      renderRecents();
      if (!added.length) {
        toast("No supported media found in that selection");
        return;
      }
      if (fileList.length > added.length) toast((fileList.length - added.length) + " file(s) skipped (unsupported)");
      playItem(added[0].id);
    }

    els.openFilesBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.emptyOpenBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function (e) {
      handleFiles(e.target.files);
      els.fileInput.value = "";
    });

    var dragDepth = 0;
    window.addEventListener("dragenter", function (e) {
      if (!e.dataTransfer || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth++;
      els.dropOverlay.classList.add("is-active");
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e.dataTransfer)) e.preventDefault(); });
    window.addEventListener("dragleave", function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.classList.remove("is-active");
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.remove("is-active");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        if (window.GhostDJ && window.GhostDJ.handleDrop && window.GhostDJ.handleDrop(e)) return;   // dropped on a DJ deck
        handleFiles(e.dataTransfer.files);
      }
    });
    function hasFiles(dt) {
      if (!dt || !dt.types) return false;
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === "Files") return true;
      return false;
    }

    // ---------------------------------------------------------------- playback
    function findIndex(id) { return lib.items.findIndex(function (m) { return m.id === id; }); }

    // Tells the separate Lyrics / DJ screens which item is current (null when nothing is).
    function currentItem() { var i = findIndex(state.currentId); return i === -1 ? null : lib.items[i]; }
    function announceTrack() {
      document.dispatchEvent(new CustomEvent("ghost:trackchange", { detail: { item: currentItem() } }));
    }

    function playItem(id, noHistory) {
      var idx = findIndex(id);
      if (idx === -1) return;
      // Opening local media always leaves the separate Radio screen (radio.js stops its stream).
      if (window.GhostRadio) window.GhostRadio.leave();
      var item = lib.items[idx];
      if (!noHistory && state.currentId && state.currentId !== id) { state.history.push(state.currentId); if (state.history.length > 300) state.history.shift(); }
      if (state.played.indexOf(id) < 0) state.played.push(id);
      // DJ Mode / Lyrics are separate screens: DJ always gives way to the player, Lyrics only for non-audio.
      if (window.GhostScreens) {
        var cs = window.GhostScreens.current();
        if (cs === "dj" || (cs === "lyrics" && item.kind !== "audio")) { window.GhostScreens.hide(cs); setPanel("library"); }
      }
      state.currentId = id;
      state.currentKind = item.kind;
      state.playedOk = false; state.lastTime = 0; state.resumeAt = null;
      if (state.recoverId !== id) { state.recoverId = id; state.recoverTries = 0; }
      els.nowTitle.textContent = item.name;
      clearTimeout(state.errorSkipTimer);
      hideError();
      hideLoading();

      els.emptyState.hidden = true;
      vEl().hidden = true;
      els.audioStage.hidden = true;
      els.imageStage.hidden = true;
      els.imageToolbar.hidden = true;
      els.controls.hidden = false;
      els.controls.classList.remove("is-static");
      els.audioStage.classList.remove("is-playing");

      if (item.kind === "video") {
        vEl().hidden = false;
        player.loadKind("video", item.url);
        pushBoostToEngine();
        syncFxAttachment();
        player.play();
      } else if (item.kind === "audio") {
        els.audioStage.hidden = false;
        els.audioName.textContent = item.name;
        player.loadKind("audio", item.url);
        pushBoostToEngine();
        syncFxAttachment();
        player.play();
      } else if (item.kind === "image") {
        player.stopAll();
        if (fx) fx.idle();
        els.controls.hidden = true;
        els.imageStage.hidden = false;
        els.imageToolbar.hidden = false;
        els.imageEl.src = item.url;
        updateImageCounter();
      }
      renderLibrary();
      showControlsTemporarily();
      syncVisual();
      announceTrack();
    }

    function updateImageCounter() {
      var idx = findIndex(state.currentId);
      els.imgCounter.textContent = (idx + 1) + " / " + lib.items.length;
    }

    function pickShuffle() {
      var ids = lib.items.map(function (i) { return i.id; });
      var pool = ids.filter(function (id) { return state.played.indexOf(id) < 0 && id !== state.currentId; });
      if (!pool.length) {
        if (state.loopMode !== "all" && ids.length > 1) return null;      // every item played once: stop (unless looping the playlist)
        state.played = []; pool = ids.filter(function (id) { return id !== state.currentId; });
      }
      return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    }
    function stepItem(dir) {
      if (!lib.items.length) return;
      if (state.shuffle && lib.items.length > 1) {
        if (dir < 0) {
          var back = state.history.pop();
          if (back && findIndex(back) >= 0) { playItem(back, true); return; }
        } else {
          var nid = pickShuffle();
          if (!nid) return;
          playItem(nid); return;
        }
      }
      var idx = findIndex(state.currentId);
      if (idx === -1) idx = 0;
      var nextIdx = idx + dir;
      if (nextIdx < 0) nextIdx = state.loopMode === "all" ? lib.items.length - 1 : 0;
      if (nextIdx >= lib.items.length) {
        if (state.loopMode === "all") nextIdx = 0;
        else return; // end of playlist
      }
      playItem(lib.items[nextIdx].id);
    }

    function onEnded() {
      if (state.loopMode === "one") { player.seekTo(0); player.play(); return; }
      if (lib.settings.autoplayNext) stepItem(1);
    }

    function showError(msg, opts) {
      opts = opts || {};
      els.errorState.hidden = false;
      els.errorText.textContent = msg || "This file can't be played.";
      els.errorSkipBtn.hidden = !!opts.hideSkip || lib.items.length < 2;
      els.controls.hidden = true;
      vEl().hidden = true;
      els.audioStage.hidden = true;
      hideLoading();
      syncVisual();
    }
    function hideError() { els.errorState.hidden = true; }

    function showLoading(text) {
      els.loadingText.textContent = text || "Loading…";
      els.loadingState.hidden = false;
    }
    function hideLoading() { els.loadingState.hidden = true; }

    // A local file that was playing fine (or hit a decode / read error) is re-opened from the saved position
    // up to 3 times before the "can't be played" screen is shown. Fixes random mid-song errors + auto-skips.
    function tryRecover(err) {
      var cur = currentItem(), code = err && err.code;
      if (!cur || cur.remote || !cur.file || (cur.kind !== "audio" && cur.kind !== "video")) return false;
      if (state.recoverId !== cur.id) { state.recoverId = cur.id; state.recoverTries = 0; }
      if (state.recoverTries >= 3) return false;
      // MEDIA_ERR_DECODE (3) / NETWORK-read (2) are transient by nature; "unsupported" (4) is only retried
      // when the track had already played, i.e. the file itself is fine.
      if (!(code === 3 || code === 2 || state.playedOk)) return false;
      state.recoverTries++;
      var pos = state.lastTime || 0;
      try { if (player.activeEl && player.activeEl.currentTime > 0) pos = player.activeEl.currentTime; } catch (e) { /* ignore */ }
      var oldUrl = cur.url;
      try { cur.url = URL.createObjectURL(cur.file); } catch (e) { cur.url = oldUrl; }
      if (cur.url !== oldUrl) setTimeout(function () { try { URL.revokeObjectURL(oldUrl); } catch (e) { /* ignore */ } }, 4000);
      state.resumeAt = pos > 0.5 ? pos : null;
      showLoading("Recovering\u2026");
      player.loadKind(cur.kind, cur.url);
      pushBoostToEngine();
      syncFxAttachment();
      player.play();
      return true;
    }

    player.on("error", function (err) {
      if (tryRecover(err)) return;
      var cur = currentItem(), code = err && err.code;
      if (cur && cur.remote) {
        showError(err && err.message ? err.message : code === 2 ? "The stream stopped: network error. Check the link and your connection." :
          code === 4 ? "This stream can't be played: the link isn't direct audio/video, the server refused it, or the codec isn't supported (HLS, DVD/MPEG-2 and DRM can't be decoded)." :
          "This stream can't be played right now (error " + (code || "?") + ").");
      } else {
        showError("This file can't be played \u2014 it may be corrupt or use an unsupported codec.");
      }
      var idAtError = state.currentId;
      clearTimeout(state.errorSkipTimer);
      state.errorSkipTimer = setTimeout(function () {
        // Only auto-advance if the user hasn't already navigated away manually.
        if (state.currentId === idAtError && lib.settings.autoplayNext && lib.items.length > 1) stepItem(1);
      }, 1600);
    });
    player.on("stopped", function () { if (fx) fx.idle(); syncVisual(); });
    player.on("play", function () {
      if (fx) fx.resume();
      updatePlayIcon(false);
      els.audioStage.classList.add("is-playing");
      scheduleAutoHide();
      syncVisual();
    });
    player.on("pause", function () { updatePlayIcon(true); clearAutoHide(); showControlsTemporarily(true); syncVisual(); });
    player.on("ended", onEnded);
    player.on("timeupdate", function () {
      var a = player.activeEl;
      if (a && a.currentTime > 0) state.lastTime = a.currentTime;
      // A "stalled"/"waiting" event can leave the Buffering spinner on although audio is flowing again.
      if (a && !els.loadingState.hidden && !a.paused && a.readyState >= 3) hideLoading();
      updateSeekUI();
    });
    player.on("progress", updateSeekUI);
    player.on("volumechange", updateVolumeUI);
    player.on("waiting", function () {
      if (player.isPaused()) return;
      showLoading("Buffering…");
    });
    player.on("playing", function () { hideLoading(); state.playedOk = true; });
    player.on("canplay", onCanPlay);

    els.imgPrev.addEventListener("click", function () { stepItem(-1); });
    els.imgNext.addEventListener("click", function () { stepItem(1); });
    els.imgFullscreen.addEventListener("click", toggleFullscreen);
    els.errorSkipBtn.addEventListener("click", function () { stepItem(1); });

    els.libraryList.addEventListener("click", function (e) {
      var removeId = e.target.closest("[data-remove]");
      if (removeId) {
        e.stopPropagation();
        var id = removeId.getAttribute("data-remove");
        var wasCurrent = id === state.currentId;
        lib.removeItem(id);
        renderLibrary();
        if (wasCurrent) {
          player.stopAll();
          resetToEmpty();
        }
        return;
      }
      var row = e.target.closest(".media-item");
      if (row) playItem(row.dataset.id);
    });

    function resetToEmpty() {
      state.currentId = null;
      els.nowTitle.textContent = "Ghost Media Player";
      els.emptyState.hidden = lib.items.length > 0;
      vEl().hidden = true;
      els.audioStage.hidden = true;
      els.imageStage.hidden = true;
      els.imageToolbar.hidden = true;
      els.controls.hidden = true;
      hideError();
      hideLoading();
      syncVisual();
      announceTrack();
      if (lib.items.length) playItem(lib.items[0].id);
    }

    // ---------------------------------------------------------------- audio engine helpers
    function fxActive() { return !!fx && (fx.enabled || state.desiredBoost > 100 || !!(window.GhostDSP && GhostDSP.wanted())); }

    // Every source is a local file, so it can always be routed through Web Audio.
    function fxSourceCapable() {
      if (!fx || !fx.isSupported()) return false;
      var it = currentItem();           // web streams without CORS headers would be silenced by Web Audio
      return !(it && it.remote && /^https?:/i.test(it.url));      // (proxied ghost-stream:// links do allow it)
    }

    function syncFxAttachment() {
      if (!fxActive() || !fxSourceCapable() || !player.activeEl) return;
      if (!fx.attach(player.activeEl)) return;
      fx.setBoost(fx.boost);
      if (fx.enabled) fx.setEnabled(true);
    }

    function onCanPlay() {
      hideLoading();
      if (state.resumeAt != null && player.activeEl && isFinite(player.activeEl.duration)) {
        var at = state.resumeAt; state.resumeAt = null;
        try { player.seekTo(at); } catch (e) { /* ignore */ }
        player.play();
      }
    }

    function stopPlayback() {
      player.stopAll();
      // The element stays wired to the graph (a media element that has been
      // routed once can only reach the speakers through it); the context is
      // simply parked so nothing keeps processing.
      if (fx) fx.idle();
      hideLoading();
      state.currentKind = null;
      state.currentId = null;
      els.controls.hidden = true;
      vEl().hidden = true;
      els.audioStage.hidden = true;
      els.imageStage.hidden = true;
      els.imageToolbar.hidden = true;
      els.emptyState.hidden = false;
      els.nowTitle.textContent = "Ghost Media Player";
      hideError();
      renderLibrary();
      syncVisual();
      announceTrack();
    }

    els.stopBtn.addEventListener("click", stopPlayback);

    // ---------------------------------------------------------------- background visuals
    // Shown only while AUDIO is the main media on screen. Video / image / GIF opened
    // as normal media always win, and the layer is released entirely for them.
    var visualDisplay = GhostVisuals.createDisplay(els.visualLayer);
    GhostVisuals.onError = toast;

    function syncVisual() {
      var audioOnScreen = state.currentKind === "audio" && !els.audioStage.hidden;
      // Idle = the empty main stage (nothing loaded, no error): the chosen visual shows there
      // too, so picking one in Settings gives instant feedback in the main area.
      var idleOnScreen = !state.currentKind && !els.emptyState.hidden;
      var want = GhostVisuals.settings.enabled && !!GhostVisuals.selected();
      els.audioStage.classList.toggle("has-visual", audioOnScreen && want);
      els.emptyState.classList.toggle("has-visual", idleOnScreen && want);
      visualDisplay.sync({
        audio: audioOnScreen, idle: idleOnScreen,
        playing: audioOnScreen ? !player.isPaused() : idleOnScreen
      });
    }

    // ---- small modal helper (window.prompt/confirm don't exist in Electron)
    function openDialog(build) {
      var host = els.dialog;
      var prevFocus = document.activeElement;
      var cleanup = null;
      function close() {
        if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
        host.hidden = true;
        host.innerHTML = "";
        host.onclick = null;
        document.removeEventListener("keydown", onKey, true);
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* ignore */ } }
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      }
      host.innerHTML = '<div class="modal__backdrop" data-dialog-close></div>' +
        '<div class="modal__card" role="dialog" aria-modal="true"></div>';
      var card = host.querySelector(".modal__card");
      host.onclick = function (e) { if (e.target.closest("[data-dialog-close]")) close(); };
      document.addEventListener("keydown", onKey, true);
      host.hidden = false;
      cleanup = build(card, close) || null;
      return close;
    }

    function promptRename(item, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        var done = false;
        function finish(v) { if (!done) { done = true; resolve(v); } }
        openDialog(function (card, close) {
          card.innerHTML =
            '<h2 class="modal__title">' + (opts.isNew ? "Name this Background Visual" : "Rename Background Visual") + '</h2>' +
            '<p class="modal__sub">Type any name you like. It is only a label \u2014 the file itself is not renamed.</p>' +
            '<input id="dlgNameInput" class="textinput" type="text" maxlength="120" spellcheck="false" autocomplete="off" aria-label="Visual name" />' +
            '<div class="modal__actions modal__actions--split">' +
              '<button class="btn btn--ghost" id="dlgCancel">' + (opts.isNew ? "Keep file name" : "Cancel") + '</button>' +
              '<button class="btn btn--primary" id="dlgSave">Save</button>' +
            '</div>';
          var input = card.querySelector("#dlgNameInput");
          input.value = item.name;
          setTimeout(function () { input.focus(); input.select(); }, 30);
          function save() {
            var v = input.value.trim();
            if (!v) { input.focus(); return; }
            finish(v); close();
          }
          card.querySelector("#dlgSave").addEventListener("click", save);
          card.querySelector("#dlgCancel").addEventListener("click", function () { finish(null); close(); });
          input.addEventListener("keydown", function (e) { if (e.key === "Enter") save(); });
          return function () { finish(null); };
        });
      });
    }

    function confirmDialog(title, message, okLabel) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(v) { if (!done) { done = true; resolve(v); } }
        openDialog(function (card, close) {
          card.innerHTML =
            '<h2 class="modal__title">' + escapeHtml(title) + '</h2>' +
            '<p class="modal__sub">' + escapeHtml(message) + '</p>' +
            '<div class="modal__actions modal__actions--split">' +
              '<button class="btn btn--ghost" id="dlgNo">Cancel</button>' +
              '<button class="btn btn--primary" id="dlgYes">' + escapeHtml(okLabel || "OK") + '</button>' +
            '</div>';
          card.querySelector("#dlgYes").addEventListener("click", function () { finish(true); close(); });
          card.querySelector("#dlgNo").addEventListener("click", function () { finish(false); close(); });
          setTimeout(function () { card.querySelector("#dlgNo").focus(); }, 30);
          return function () { finish(false); };
        });
      });
    }

    // Preview uses the real imported file, inside the app. Video is muted; the element
    // is released as soon as the dialog closes.
    function previewVisual(item) {
      GhostVisuals.acquire(item).then(function (res) {
        var el = null;
        openDialog(function (card, close) {
          card.classList.add("modal__card--preview");
          card.innerHTML =
            '<h2 class="modal__title">' + escapeHtml(item.name) + '</h2>' +
            '<div class="preview-frame" id="previewFrame"></div>' +
            '<p class="modal__sub" id="previewNote">' + item.type.toUpperCase() +
              (item.type === "video" ? " \u00b7 silent preview" : "") + '</p>' +
            '<div class="modal__actions"><button class="btn btn--primary" id="previewClose">Close</button></div>';
          el = GhostVisuals.buildElement(item, res.url);
          el.addEventListener("error", function () {
            var n = card.querySelector("#previewNote");
            if (n) n.textContent = "This file can't be displayed \u2014 the file or codec isn't supported.";
            GhostVisuals.releaseElement(el);
          }, { once: true });
          card.querySelector("#previewFrame").appendChild(el);
          if (item.type === "video") { var p = el.play(); if (p && p.catch) p.catch(function () {}); }
          card.querySelector("#previewClose").addEventListener("click", close);
          return function () { GhostVisuals.releaseElement(el); res.release(); };
        });
      }, function () { toast("Couldn't open that visual"); });
    }

    // ---------------------------------------------------------------- controls UI
    function updatePlayIcon(paused) {
      els.playIcon.innerHTML = paused
        ? '<path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/>'
        : '<path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/>';
      els.playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
    }

    function durLabel(p) {
      var el = player.activeEl;
      return el && el.duration === Infinity ? "LIVE" : ghostFormatTime(p.duration);
    }
    function updateSeekUI() {
      if (state.isSeeking) return;
      var p = player.getProgress();
      els.seekFill.style.width = (p.fraction * 100) + "%";
      els.seekThumb.style.left = (p.fraction * 100) + "%";
      els.seekBuffered.style.width = (p.buffered * 100) + "%";
      els.seekRange.value = Math.round(p.fraction * 1000);
      els.timeCurrent.textContent = ghostFormatTime(p.current);
      els.timeDuration.textContent = durLabel(p);
    }

    function updateVolumeUI() {
      var muted = player.isMuted() || player.getVolume() === 0;
      var vol = player.getVolume();
      var mirror = document.getElementById("volMirror");
      if (mirror) mirror.textContent = Math.round(vol * 100) + "%";
      els.volRange.value = Math.round(vol * 100);
      els.volFill.style.width = (muted ? 0 : vol * 100) + "%";
      els.volIcon.innerHTML = muted
        ? '<path d="M4 10v4h3.5L12 17.5v-11L7.5 10H4Z" fill="currentColor"/><path d="m15 10 4 4m0-4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
        : '<path d="M4 10v4h3.5L12 17.5v-11L7.5 10H4Z" fill="currentColor"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
    }

    els.playBtn.addEventListener("click", function () { player.togglePlay(); });
    els.prevBtn.addEventListener("click", function () { stepItem(-1); });
    els.nextBtn.addEventListener("click", function () { stepItem(1); });

    function seekFromClientX(clientX) {
      var rect = els.seekTrack.getBoundingClientRect();
      var frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      player.seekFraction(frac);
      els.seekFill.style.width = (frac * 100) + "%";
      els.seekThumb.style.left = (frac * 100) + "%";
      return frac;
    }
    els.seekRange.addEventListener("input", function () {
      state.isSeeking = true;
      var frac = els.seekRange.value / 1000;
      els.seekFill.style.width = (frac * 100) + "%";
      els.seekThumb.style.left = (frac * 100) + "%";
    });
    els.seekRange.addEventListener("change", function () {
      player.seekFraction(els.seekRange.value / 1000);
      state.isSeeking = false;
    });

    els.volRange.addEventListener("input", function () {
      var v = els.volRange.value / 100;
      player.setVolume(v);
      player.setMuted(false);
      els.volFill.style.width = (v * 100) + "%";
      lib.settings.defaultVolume = els.volRange.value;
      lib.saveSettings();
    });
    els.muteBtn.addEventListener("click", function () { player.setMuted(!player.isMuted()); });

    var shuffleBtn = document.getElementById("shuffleBtn");
    function paintShuffle() {
      if (!shuffleBtn) return;
      shuffleBtn.classList.toggle("is-active", state.shuffle);
      shuffleBtn.style.color = state.shuffle ? "var(--accent)" : "";
    }
    function setShuffle(on, quiet) {
      state.shuffle = !!on; state.played = state.currentId ? [state.currentId] : [];
      lib.settings.shuffle = state.shuffle; lib.saveSettings();
      paintShuffle();
      if (!quiet) toast(state.shuffle ? "Shuffle on \u2014 random songs, no repeats until all are played" : "Shuffle off \u2014 playing in list order");
    }
    if (shuffleBtn) { shuffleBtn.addEventListener("click", function () { setShuffle(!state.shuffle); var sw = document.getElementById("shuffleSwitch"); if (sw) sw.checked = state.shuffle; }); paintShuffle(); }

    els.loopBtn.addEventListener("click", function () {
      var order = ["off", "all", "one"];
      state.loopMode = order[(order.indexOf(state.loopMode) + 1) % order.length];
      player.setLoopOne(state.loopMode === "one");
      lib.settings.loopMode = state.loopMode;
      lib.saveSettings();
      els.loopBtn.classList.toggle("is-active", state.loopMode !== "off");
      els.loopBtn.style.color = state.loopMode === "off" ? "" : "var(--accent)";
      toast(state.loopMode === "off" ? "Loop off" : state.loopMode === "all" ? "Loop playlist" : "Loop one");
    });

    els.speedBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var rect = els.speedBtn.getBoundingClientRect();
      els.speedMenu.style.left = rect.left + "px";
      els.speedMenu.style.top = (rect.top - 210) + "px";
      els.speedMenu.hidden = !els.speedMenu.hidden;
    });
    els.speedMenu.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-speed]");
      if (!btn) return;
      var rate = parseFloat(btn.getAttribute("data-speed"));
      player.setRate(rate);
      els.speedBtn.textContent = rate.toFixed(rate % 1 === 0 ? 1 : 2) + "x";
      Array.prototype.forEach.call(els.speedMenu.children, function (c) { c.classList.remove("is-active"); });
      btn.classList.add("is-active");
      els.speedMenu.hidden = true;
    });
    document.addEventListener("click", function () { els.speedMenu.hidden = true; });

    function toggleFullscreen() {
      var el = els.viewport;
      if (!document.fullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      }
    }
    els.fullscreenBtn.addEventListener("click", toggleFullscreen);

    // ---------------------------------------------------------------- auto-hide controls (video only)
    function scheduleAutoHide() {
      clearAutoHide();
      if (state.currentKind !== "video") return;
      state.hideTimer = setTimeout(function () {
        if (!player.isPaused()) els.controls.classList.add("is-hidden");
      }, 2800);
    }
    function clearAutoHide() { clearTimeout(state.hideTimer); }
    function showControlsTemporarily(persist) {
      els.controls.classList.remove("is-hidden");
      if (!persist) scheduleAutoHide();
    }
    ["mousemove", "touchstart", "click"].forEach(function (evt) {
      els.viewport.addEventListener(evt, function () { showControlsTemporarily(); });
    });

    // ---------------------------------------------------------------- sidebar / panels
    function setPanel(name) {
      state.sidebarPanel = name;
      document.querySelectorAll(".navitem").forEach(function (b) {
        b.classList.toggle("is-active", b.dataset.panel === name);
      });
      document.querySelectorAll(".sidebar__panel").forEach(function (p) {
        p.classList.toggle("is-active", p.id === "panel-" + name);
      });
    }
    document.querySelectorAll(".navitem").forEach(function (b) {
      b.addEventListener("click", function () {
        setPanel(b.dataset.panel);
        if (window.innerWidth <= 860) openSidebar(true);
      });
    });
    els.clearRecentBtn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      lib.clearRecents();
      renderRecents();
      toast("Recent list cleared");
    });

    function openSidebar(open) {
      els.sidebar.classList.toggle("is-open", open);
    }
    els.sidebarToggle.addEventListener("click", function () {
      openSidebar(!els.sidebar.classList.contains("is-open"));
    });

    els.viewport.addEventListener("click", function (e) {
      if (window.innerWidth <= 860 && els.sidebar.classList.contains("is-open") && !els.sidebar.contains(e.target)) {
        openSidebar(false);
      }
    });

    // ---- Sleep timer: fades the volume out over the last 20 s, then pauses and restores the volume
    var sleep = { end: 0, timer: 0, vol: null };
    function sleepLabel() {
      if (!sleep.end) return "Off.";
      var m = Math.max(1, Math.ceil((sleep.end - Date.now()) / 60000));
      return "Pausing in about " + m + " min.";
    }
    function setSleep(min) {
      clearInterval(sleep.timer); sleep.timer = 0;
      if (sleep.vol !== null) { player.setVolume(sleep.vol); sleep.vol = null; }
      if (!min) { sleep.end = 0; toast("Sleep timer off"); renderSettings(); return; }
      sleep.end = Date.now() + min * 60000;
      sleep.timer = setInterval(function () {
        var left = sleep.end - Date.now();
        if (left <= 20000 && left > 0) {
          if (sleep.vol === null) sleep.vol = player.getVolume();
          player.setVolume(sleep.vol * (left / 20000));
        } else if (left <= 0) {
          clearInterval(sleep.timer); sleep.timer = 0; sleep.end = 0;
          player.pause();
          if (sleep.vol !== null) { player.setVolume(sleep.vol); sleep.vol = null; }
          toast("Sleep timer: paused");
        }
      }, 500);
      toast("Sleep timer: " + min + " min");
      renderSettings();
    }

    // ---------------------------------------------------------------- settings panel
    function renderSettings() {
      els.panelSettings.innerHTML =
        '<div class="settings">' +
          '<div class="settings-group"><h3>Theme</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">' + GhostThemes.PRESETS[GhostThemes.current.preset].name + '</div><div class="settings-row__hint">Change look, colors and font in Themes</div></div>' +
              '<button class="btn btn--ghost" id="openThemesBtn">Open Themes</button></div>' +
          '</div>' +

          '<div class="settings-group"><h3>Playback</h3>' +
            '<div class="settings-row"><div class="settings-row__label">Autoplay next item</div>' + switchHtml("autoplayNext", lib.settings.autoplayNext) + '</div>' +
            '<div class="settings-row"><div><div class="settings-row__label">Shuffle (random order)</div><div class="settings-row__hint">Plays songs randomly, none twice until the whole list was played</div></div>' + switchHtml("shuffleSwitch", state.shuffle) + '</div>' +
            '<div class="settings-row"><div class="settings-row__label">Loop mode</div>' +
              '<select class="select" id="loopModeSelect">' +
                '<option value="off"' + sel(state.loopMode, "off") + '>Off</option>' +
                '<option value="all"' + sel(state.loopMode, "all") + '>Playlist</option>' +
                '<option value="one"' + sel(state.loopMode, "one") + '>Single item</option>' +
              '</select></div>' +
            '<div class="settings-row"><div class="settings-row__label">Default volume</div>' +
              '<input type="range" min="0" max="100" id="defaultVolRange" value="' + (lib.settings.defaultVolume || 80) + '"></div>' +
          '</div>' +

          '<div class="settings-group"><h3>Sleep timer</h3>' +
            '<div class="settings-row__hint" style="margin:-4px 0 8px">' + sleepLabel() + ' The sound fades out softly, then playback pauses.</div>' +
            '<div class="sleep-row">' + [15, 30, 45, 60, 90].map(function (m) { return '<button type="button" class="chip" data-sleep="' + m + '">' + m + ' min</button>'; }).join("") +
              '<button type="button" class="chip" data-sleep="0">Off</button></div>' +
          '</div>' +

          '<div class="settings-group"><h3>Keyboard shortcuts</h3><div class="kbd-grid">' +
            '<kbd>Space</kbd><span>Play / pause</span><kbd>&larr; &rarr;</kbd><span>Seek 5 seconds</span><kbd>&uarr; &darr;</kbd><span>Volume</span>' +
            '<kbd>M</kbd><span>Mute</span><kbd>N / P</kbd><span>Next / previous</span><kbd>L</kbd><span>Loop</span><kbd>F</kbd><span>Fullscreen</span>' +
            '<kbd>I</kbd><span>Mini player</span><kbd>Alt+U</kbd><span>Cycle UI design</span></div></div>' +

          '<div class="settings-group"><h3>Look &amp; feel</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">3D look</div><div class="settings-row__hint">Buttons and panels get depth. Nothing moves or tilts, so clicking stays easy.</div></div>' +
              switchHtml("look3dSwitch", !!(window.GhostLook3D && GhostLook3D.isOn())) + '</div>' +
            '<div class="settings-row"><div><div class="settings-row__label">3D strength</div><div class="settings-row__hint">' + (window.GhostLook3D ? GhostLook3D.LEVELS[GhostLook3D.level()].tag : "") + '</div></div>' +
              '<select class="select" id="look3dLevel">' + (window.GhostLook3D ? Object.keys(GhostLook3D.LEVELS).map(function (k) { return '<option value="' + k + '"' + sel(GhostLook3D.level(), k) + '>' + GhostLook3D.LEVELS[k].name + '</option>'; }).join("") : "") + '</select></div>' +
            '<div class="settings-row"><div><div class="settings-row__label">3D style</div><div class="settings-row__hint">' + (window.GhostLook3D ? GhostLook3D.STYLES[GhostLook3D.style()].tag : "") + '</div></div>' +
              '<select class="select" id="look3dStyle">' + (window.GhostLook3D ? Object.keys(GhostLook3D.STYLES).map(function (k) { return '<option value="' + k + '"' + sel(GhostLook3D.style(), k) + '>' + GhostLook3D.STYLES[k].name + '</option>'; }).join("") : "") + '</select></div>' +
            '<div class="settings-row"><div><div class="settings-row__label">Advanced UI Design</div><div class="settings-row__hint">Whole-app layouts, not colors: ' + (window.GhostUI ? GhostUI.DESIGNS[GhostUI.current()].name : "Normal") + '</div></div>' +
              '<select class="select" id="uiDesignSelect">' + (window.GhostUI ? Object.keys(GhostUI.DESIGNS).map(function (k) { return '<option value="' + k + '"' + sel(GhostUI.current(), k) + '>' + GhostUI.DESIGNS[k].name + '</option>'; }).join("") : "") + '</select></div>' +
          '</div>' +

          bgVisualsHtml() +

          '<div class="settings-group"><h3>Navigation</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">Orb navigation</div><div class="settings-row__hint">Radial menu (press O). Off = classic list.</div></div>' +
              '<input type="checkbox" id="orbNavToggle"' + (window.GhostNav && GhostNav.getMode() === 'orb' ? ' checked' : '') + ' /></div>' +
          '</div>' +

          '<div class="settings-group"><h3>Library</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">Clear playlist</div><div class="settings-row__hint">' + lib.items.length + ' item(s) loaded this session</div></div>' +
              '<button class="btn btn--ghost" id="clearLibraryBtn">Clear</button></div>' +
            '<div class="settings-row"><div><div class="settings-row__label">Clear recent history</div><div class="settings-row__hint">' + lib.recents.length + ' remembered</div></div>' +
              '<button class="btn btn--ghost" id="clearRecentBtn2">Clear</button></div>' +
          '</div>' +

          '<div class="settings-group"><h3>About</h3>' +
            '<div class="about">' +
              '<div class="about__name">' + (window.GHOST_VERSION ? window.GHOST_VERSION.name : 'Ghost Media Player') + '</div>' +
              '<div class="about__line">Version ' + (window.GHOST_VERSION ? window.GHOST_VERSION.number : '2.0') + '</div>' +
              '<div class="about__line">Made by J Studio</div>' +
              '<div class="about__line">Developer by Jasmeet</div>' +
              '<div class="about__line">Made by World</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.getElementById("openThemesBtn").addEventListener("click", function () { setPanel("themes"); });
      var l3 = document.getElementById("look3dSwitch");
      if (l3) l3.addEventListener("change", function (e) { if (window.GhostLook3D) GhostLook3D.set(e.target.checked); toast(e.target.checked ? "3D look on" : "3D look off"); renderThemes(); });
      var l3l = document.getElementById("look3dLevel");
      if (l3l) l3l.addEventListener("change", function (e) { if (window.GhostLook3D) { GhostLook3D.setLevel(e.target.value); if (!GhostLook3D.isOn()) GhostLook3D.set(true); toast("3D strength: " + GhostLook3D.LEVELS[e.target.value].name); renderSettings(); renderThemes(); } });
      var l3s = document.getElementById("look3dStyle");
      if (l3s) l3s.addEventListener("change", function (e) { if (window.GhostLook3D) { GhostLook3D.setStyle(e.target.value); if (!GhostLook3D.isOn()) GhostLook3D.set(true); toast("3D style: " + GhostLook3D.STYLES[e.target.value].name); renderSettings(); renderThemes(); } });
      var uiSel = document.getElementById("uiDesignSelect");
      if (uiSel) uiSel.addEventListener("change", function (e) { if (window.GhostUI) { GhostUI.set(e.target.value); toast("UI design: " + GhostUI.DESIGNS[e.target.value].name); renderSettings(); renderThemes(); } });
      Array.prototype.forEach.call(document.querySelectorAll("[data-sleep]"), function (bt) {
        bt.addEventListener("click", function () { setSleep(parseInt(bt.getAttribute("data-sleep"), 10)); });
      });
      var shSw = document.getElementById("shuffleSwitch");
      if (shSw) shSw.addEventListener("change", function (e) { setShuffle(e.target.checked); });
      var orbT = document.getElementById("orbNavToggle");
      if (orbT) orbT.addEventListener("change", function (e) { if (window.GhostNav) GhostNav.setMode(e.target.checked ? "orb" : "simple"); });

      document.getElementById("autoplayNext").addEventListener("change", function (e) {
        lib.settings.autoplayNext = e.target.checked; lib.saveSettings();
      });
      document.getElementById("loopModeSelect").addEventListener("change", function (e) {
        state.loopMode = e.target.value;
        player.setLoopOne(state.loopMode === "one");
        lib.settings.loopMode = state.loopMode; lib.saveSettings();
      });
      document.getElementById("defaultVolRange").addEventListener("input", function (e) {
        var v = e.target.value / 100;
        player.setVolume(v);
        lib.settings.defaultVolume = e.target.value; lib.saveSettings();
      });
      document.getElementById("clearLibraryBtn").addEventListener("click", function () {
        lib.clearLibrary();
        player.stopAll();
        renderLibrary();
        resetToEmpty();
        renderSettings();
        toast("Playlist cleared");
      });
      document.getElementById("clearRecentBtn2").addEventListener("click", function () {
        lib.clearRecents(); renderRecents(); renderSettings(); toast("Recent history cleared");
      });
      wireBgVisuals();
    }


    // ---- Themes panel (own sidebar tab)
    // Self-contained miniature of the theme (pure inline SVG + CSS background set through the DOM,
    // so it renders identically in the browser and in the packaged desktop app).
    function themePreviewSvg(key, t) {
      var r = Math.min(9, t.radius), side = t.panel, tx = t.text, ac = t.accent;
      var art = "";
      if (t.glyph) {
        var rowsTxt = ["01@@#%&8W01", "0@@@@@@@@@0", "@@  @@  @@@", "@@@@@@@@@@@", "@@@0@@0@@@@", "#@@ @@@ @@#"];
        art = rowsTxt.map(function (ln, i) { return '<text x="38" y="' + (13 + i * 7) + '" font-size="6.4" fill="' + tx + '" opacity="' + (0.35 + (i % 3) * 0.2) + '" font-family="Consolas,monospace" xml:space="preserve">' + escapeHtml(ln) + '</text>'; }).join("");
      } else {
        art = '<text x="40" y="26" font-size="17" font-weight="700" fill="' + tx + '" style="font-family:' + t.font.replace(/"/g, "'") + '">Aa</text>' +
          '<rect x="40" y="31" width="40" height="3" rx="1.5" fill="' + tx + '" opacity=".35"/>' +
          '<rect x="40" y="37" width="26" height="3" rx="1.5" fill="' + tx + '" opacity=".2"/>';
      }
      var playShape = r >= 6 ? '<circle cx="96" cy="46" r="8" fill="' + ac + '"/>' : '<rect x="88" y="38" width="16" height="16" rx="' + r + '" fill="' + ac + '"/>';
      return '<svg viewBox="0 0 120 74" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">' +
        '<rect x="0" y="0" width="30" height="74" fill="' + side + '" opacity=".92"/>' +
        '<rect x="7" y="9" width="16" height="3" rx="1.5" fill="' + ac + '"/>' +
        '<rect x="7" y="18" width="16" height="2.4" rx="1.2" fill="' + tx + '" opacity=".45"/>' +
        '<rect x="7" y="24" width="12" height="2.4" rx="1.2" fill="' + tx + '" opacity=".3"/>' +
        '<rect x="7" y="30" width="14" height="2.4" rx="1.2" fill="' + tx + '" opacity=".3"/>' +
        art + playShape +
        '<path d="M93.4 42.2v7.6l6.2-3.8z" fill="' + t.bg + '"/>' +
        '<rect x="38" y="63" width="76" height="3" rx="1.5" fill="' + tx + '" opacity=".25"/>' +
        '<rect x="38" y="63" width="34" height="3" rx="1.5" fill="' + ac + '"/>' +
        '</svg>';
    }

    function renderThemes() {
      // Re-rendering rebuilds the list, which used to throw the person back to the top after every click.
      // Remember where the list was scrolled to and put it back (also if the panel scrolls instead of .settings).
      var oldBox = els.panelThemes.querySelector(".settings");
      var keepTop = oldBox ? oldBox.scrollTop : 0, keepPanel = els.panelThemes.scrollTop;
      var cur = GhostThemes.current;
      var customOn = !!(cur.customAccent || cur.customBg);
      var cards = Object.keys(GhostThemes.PRESETS).map(function (key) {
        var t = GhostThemes.PRESETS[key];
        var active = cur.preset === key && !customOn;
        return '<button type="button" class="theme-card' + (active ? ' is-active' : '') + '" data-theme-key="' + key + '" aria-pressed="' + active + '">' +
          '<span class="theme-card__preview" data-preview="' + key + '">' + themePreviewSvg(key, t) + '</span>' +
          '<span class="theme-card__name">' + escapeHtml(t.name) + '</span>' +
          '<span class="theme-card__tag">' + escapeHtml(t.tag) + '</span>' +
        '</button>';
      }).join("");
      var ctlAuto = !cur.ctl || cur.ctl === "auto", ctlNow = GhostThemes.controlStyle();
      var ctlCards = '<button type="button" class="ctl-card' + (ctlAuto ? ' is-active' : '') + '" data-ctl-key="auto"><b>Match theme</b><i>Currently ' + escapeHtml(GhostThemes.CONTROL_STYLES[ctlNow].name) + '</i></button>' +
        Object.keys(GhostThemes.CONTROL_STYLES).map(function (k) {
          var c = GhostThemes.CONTROL_STYLES[k];
          return '<button type="button" class="ctl-card' + (!ctlAuto && cur.ctl === k ? ' is-active' : '') + '" data-ctl-key="' + k + '"><b>' + escapeHtml(c.name) + '</b><i>' + escapeHtml(c.tag) + '</i></button>';
        }).join("");
      var base = GhostThemes.PRESETS[cur.preset];
      var uiCards = window.GhostUI ? GhostUI.cardsHtml(escapeHtml) : "";
      var l3Html = "";
      if (window.GhostLook3D) {
        var L3 = GhostLook3D, l3on = L3.isOn();
        l3Html = '<div class="settings-group"><h3>3D look</h3>' +
          '<div class="settings-row__hint" style="margin:-4px 0 8px">Depth for buttons and panels. Nothing moves or tilts. Pick a strength, then a look.</div>' +
          '<div class="settings-row"><div class="settings-row__label">3D on</div>' + switchHtml("look3dSwitch2", l3on) + '</div>' +
          '<div class="chips" id="l3Levels">' + Object.keys(L3.LEVELS).map(function (k) {
            return '<button type="button" class="chip' + (l3on && L3.level() === k ? ' is-active' : '') + '" data-l3-level="' + k + '" title="' + escapeHtml(L3.LEVELS[k].tag) + '">' + escapeHtml(L3.LEVELS[k].name) + '</button>';
          }).join("") + '</div>' +
          '<div class="l3-cards">' + Object.keys(L3.STYLES).map(function (k) {
            return '<button type="button" class="l3-card' + (l3on && L3.style() === k ? ' is-active' : '') + '" data-l3-style="' + k + '" aria-pressed="' + (l3on && L3.style() === k) + '">' +
              '<span class="l3-sample" data-s="' + k + '"><i></i><i class="p"></i><i></i></span><b>' + escapeHtml(L3.STYLES[k].name) + '</b><i>' + escapeHtml(L3.STYLES[k].tag) + '</i></button>';
          }).join("") + '</div></div>';
      }
      els.panelThemes.innerHTML =
        '<div class="settings">' +
          '<div class="settings-group"><h3>Themes</h3><div class="theme-cards">' + cards + '</div></div>' +
          '<div class="settings-group"><h3>URL/System Design Change</h3><div class="settings-row__hint" style="margin:-4px 0 8px">Switches the whole player framework: top bar, control bar layout, buttons and sliders. Not just colors.</div><div class="ctl-cards">' + ctlCards + '</div></div>' +
          uiCards +
          l3Html +
          '<div class="settings-group"><h3>Custom colors</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">Accent color</div><div class="settings-row__hint">Buttons, sliders, highlights</div></div>' +
              '<input type="color" id="accentPicker" value="' + toColorInput(cur.customAccent || base.accent) + '"></div>' +
            '<div class="settings-row"><div><div class="settings-row__label">Background color</div><div class="settings-row__hint">Sidebar and main playback area</div></div>' +
              '<input type="color" id="bgPicker" value="' + toColorInput(cur.customBg || base.bg) + '"></div>' +
            '<div class="settings-row"><button class="link-btn" id="clearCustomBtn"' + (customOn ? '' : ' disabled') + '>Clear custom colors</button>' +
              '<button class="link-btn" id="resetThemeBtn">Reset to Ghost</button></div>' +
          '</div>' +
        '</div>';

      Array.prototype.forEach.call(els.panelThemes.querySelectorAll("[data-preview]"), function (el) {
        var tt = GhostThemes.PRESETS[el.getAttribute("data-preview")];
        if (!tt) return;
        el.style.background = tt.stage;
        el.style.backgroundColor = tt.bg;
      });
      var newBox = els.panelThemes.querySelector(".settings");
      if (newBox) newBox.scrollTop = keepTop;
      els.panelThemes.scrollTop = keepPanel;
      // IMPORTANT: clicking a card never rebuilds the list. Rebuilding replaced the very button under the mouse,
      // which made clicks flicker or get lost. Cards are updated in place (syncThemesUi) instead.
      function each(sel, fn) { Array.prototype.forEach.call(els.panelThemes.querySelectorAll(sel), fn); }
      each("[data-ctl-key]", function (el) {
        el.addEventListener("click", function () { GhostThemes.setControlStyle(el.getAttribute("data-ctl-key")); syncThemesUi(); });
      });
      each("[data-ui-key]", function (el) {
        el.addEventListener("click", function () { GhostUI.set(el.getAttribute("data-ui-key")); syncThemesUi(); toast("UI design: " + GhostUI.DESIGNS[GhostUI.current()].name); });
      });
      each("[data-theme-key]", function (el) {
        el.addEventListener("click", function () {
          GhostThemes.setPreset(el.getAttribute("data-theme-key"));
          syncThemesUi();
          // Settings is hidden while Themes is open; refresh it lazily so nothing jumps here.
          setTimeout(renderSettings, 0);
        });
      });
      var l3sw = document.getElementById("look3dSwitch2");
      if (l3sw) l3sw.addEventListener("change", function (e) { GhostLook3D.set(e.target.checked); syncThemesUi(); setTimeout(renderSettings, 0); toast(e.target.checked ? "3D look on" : "3D look off"); });
      each("[data-l3-level]", function (el) {
        el.addEventListener("click", function () { GhostLook3D.setLevel(el.getAttribute("data-l3-level")); if (!GhostLook3D.isOn()) GhostLook3D.set(true); syncThemesUi(); setTimeout(renderSettings, 0); toast("3D strength: " + GhostLook3D.LEVELS[GhostLook3D.level()].name); });
      });
      each("[data-l3-style]", function (el) {
        el.addEventListener("click", function () { GhostLook3D.setStyle(el.getAttribute("data-l3-style")); if (!GhostLook3D.isOn()) GhostLook3D.set(true); syncThemesUi(); setTimeout(renderSettings, 0); toast("3D style: " + GhostLook3D.STYLES[GhostLook3D.style()].name); });
      });
      // 'input' fires continuously while dragging; only the live CSS is updated (no re-render),
      // the cards refresh on 'change' when the picker closes.
      var ap = document.getElementById("accentPicker"), bp = document.getElementById("bgPicker");
      ap.addEventListener("input", function (e) { GhostThemes.setAccent(e.target.value); });
      bp.addEventListener("input", function (e) { GhostThemes.setBackground(e.target.value); });
      ap.addEventListener("change", syncThemesUi);
      bp.addEventListener("change", syncThemesUi);
      document.getElementById("clearCustomBtn").addEventListener("click", function () { GhostThemes.clearCustom(); syncThemesUi(); });
      document.getElementById("resetThemeBtn").addEventListener("click", function () { GhostThemes.reset(); syncThemesUi(); renderSettings(); });
    }

    // Updates the Themes panel in place: active marks, labels, pickers. Never replaces an element.
    function syncThemesUi() {
      var cur = GhostThemes.current, customOn = !!(cur.customAccent || cur.customBg), P = els.panelThemes;
      function each(sel, fn) { Array.prototype.forEach.call(P.querySelectorAll(sel), fn); }
      function mark(el, on) { el.classList.toggle("is-active", !!on); if (el.hasAttribute("aria-pressed")) el.setAttribute("aria-pressed", on ? "true" : "false"); }
      each("[data-theme-key]", function (el) { mark(el, cur.preset === el.getAttribute("data-theme-key") && !customOn); });
      var ctlAuto = !cur.ctl || cur.ctl === "auto";
      each("[data-ctl-key]", function (el) {
        var k = el.getAttribute("data-ctl-key");
        mark(el, k === "auto" ? ctlAuto : (!ctlAuto && cur.ctl === k));
        if (k === "auto") { var hint = el.querySelector("i"); if (hint) hint.textContent = "Currently " + GhostThemes.CONTROL_STYLES[GhostThemes.controlStyle()].name; }
      });
      if (window.GhostUI) each("[data-ui-key]", function (el) { mark(el, GhostUI.current() === el.getAttribute("data-ui-key")); });
      if (window.GhostLook3D) {
        var on = GhostLook3D.isOn(), sw = document.getElementById("look3dSwitch2");
        if (sw) sw.checked = on;
        each("[data-l3-level]", function (el) { mark(el, on && GhostLook3D.level() === el.getAttribute("data-l3-level")); });
        each("[data-l3-style]", function (el) { mark(el, on && GhostLook3D.style() === el.getAttribute("data-l3-style")); });
      }
      var base = GhostThemes.PRESETS[cur.preset];
      var ap = document.getElementById("accentPicker"), bp = document.getElementById("bgPicker"), cl = document.getElementById("clearCustomBtn");
      if (ap && document.activeElement !== ap) ap.value = toColorInput(cur.customAccent || base.accent);
      if (bp && document.activeElement !== bp) bp.value = toColorInput(cur.customBg || base.bg);
      if (cl) cl.disabled = !customOn;
    }

    // ---- Background Visual manager (lives inside Settings)
    function bgVisualsHtml() {
      var V = GhostVisuals, st = V.settings;
      var typeLabel = { image: "Image", gif: "GIF", video: "Video" };
      var options = '<option value=""' + (st.selectedId ? "" : " selected") + '>None</option>' +
        V.items.map(function (it) {
          return '<option value="' + it.id + '"' + (st.selectedId === it.id ? " selected" : "") + '>' + escapeHtml(it.name) + '</option>';
        }).join("");

      var rows = '<li class="bvitem' + (st.selectedId ? "" : " is-selected") + '" data-bv-select="">' +
          '<span class="bvitem__dot"></span>' +
          '<span class="bvitem__meta"><span class="bvitem__name">None</span>' +
          '<span class="bvitem__sub">No background visual \u2014 music only</span></span></li>' +
        V.items.map(function (it) {
          var on = st.selectedId === it.id;
          return '<li class="bvitem' + (on ? " is-selected" : "") + '" data-bv-select="' + it.id + '">' +
            '<span class="bvitem__dot"></span>' +
            '<span class="bvitem__meta"><span class="bvitem__name">' + escapeHtml(it.name) + '</span>' +
              '<span class="bvitem__sub">' + typeLabel[it.type] + ' \u00b7 ' + lib.formatBytes(it.size) + '</span></span>' +
            '<span class="bvitem__actions">' +
              '<button class="link-btn" data-bv-preview="' + it.id + '">Preview</button>' +
              '<button class="link-btn" data-bv-rename="' + it.id + '">Rename</button>' +
              '<button class="link-btn link-btn--danger" data-bv-remove="' + it.id + '">Remove</button>' +
            '</span></li>';
        }).join("");

      return '<div class="settings-group"><h3>Background Visuals</h3>' +
        '<div class="settings-row"><div><div class="settings-row__label">Background Visuals</div>' +
          '<div class="settings-row__hint">Shown behind music only</div></div>' +
          switchHtml("bvEnabled", st.enabled) + '</div>' +
        '<div class="settings-row"><div class="settings-row__label">Current visual</div>' +
          '<select class="select bvselect" id="bvSelect">' + options + '</select></div>' +
        '<div class="settings-row bvopacity"><div class="settings-row__label">Opacity <span class="settings-row__hint" id="bvOpacityVal">' + st.opacity + '%</span></div>' +
          '<input type="range" min="0" max="100" step="1" id="bvOpacity" value="' + st.opacity + '" aria-label="Visual opacity"></div>' +
        '<div class="sidebar__label">Visual library</div>' +
        '<ul class="bvlist" id="bvList">' + rows + '</ul>' +
        (V.items.length ? '' : '<p class="empty-hint bvempty">Your library is empty. Add your own image, GIF or video \u2014 nothing is bundled.</p>') +
        '<div class="settings-row bvbuttons">' +
          '<button class="btn btn--primary" id="bvAdd">+ Add Background Visual</button>' +
          '<button class="btn btn--ghost" id="bvReset">Reset</button></div>' +
        '</div>';
    }

    function bgApply() { renderSettings(); syncVisual(); }

    function addBackgroundVisuals() {
      GhostVisuals.add().then(function (res) {
        if (res.canceled) return;
        if (res.skipped && res.skipped.length) {
          toast(res.skipped.length + " file(s) skipped \u2014 not a supported image, GIF or video");
        }
        var created = res.created || [];
        if (!created.length) return;
        renderSettings();
        // Let the user name each imported visual; names are pure metadata.
        return created.reduce(function (chain, item) {
          return chain.then(function () {
            return promptRename(item, { isNew: true }).then(function (name) {
              if (name && name !== item.name) return GhostVisuals.rename(item.id, name);
            });
          });
        }, Promise.resolve()).then(function () {
          renderSettings();
          toast(created.length === 1 ? "Background Visual added" : created.length + " Background Visuals added");
        });
      }).catch(function () { toast("Couldn't import that file"); });
    }

    function wireBgVisuals() {
      var V = GhostVisuals;
      var add = document.getElementById("bvAdd");
      if (!add) return;
      add.addEventListener("click", addBackgroundVisuals);

      document.getElementById("bvEnabled").addEventListener("change", function (e) {
        V.setEnabled(e.target.checked).then(syncVisual);
      });
      document.getElementById("bvSelect").addEventListener("change", function (e) {
        V.select(e.target.value || null).then(bgApply);
      });

      var op = document.getElementById("bvOpacity");
      op.addEventListener("input", function () {
        var v = parseInt(op.value, 10);
        V.settings.opacity = v;                       // live, no disk write per tick
        els.visualLayer.style.opacity = String(v / 100);
        document.getElementById("bvOpacityVal").textContent = v + "%";
      });
      op.addEventListener("change", function () { V.setOpacity(parseInt(op.value, 10)); });

      document.getElementById("bvList").addEventListener("click", function (e) {
        var prev = e.target.closest("[data-bv-preview]");
        var ren = e.target.closest("[data-bv-rename]");
        var rem = e.target.closest("[data-bv-remove]");
        if (prev) { var p = V.get(prev.getAttribute("data-bv-preview")); if (p) previewVisual(p); return; }
        if (ren) {
          var it = V.get(ren.getAttribute("data-bv-rename"));
          if (it) promptRename(it).then(function (name) {
            if (name && name !== it.name) return V.rename(it.id, name).then(function () { toast("Renamed"); });
          }).then(bgApply);
          return;
        }
        if (rem) {
          var victim = V.get(rem.getAttribute("data-bv-remove"));
          if (!victim) return;
          confirmDialog("Remove \u201c" + victim.name + "\u201d?",
            "This deletes the copy Ghost stored. Your original file is not touched.", "Remove")
            .then(function (ok) { if (ok) return V.remove(victim.id).then(function () { toast("Background Visual removed"); bgApply(); }); });
          return;
        }
        var row = e.target.closest("[data-bv-select]");
        if (row) V.select(row.getAttribute("data-bv-select") || null).then(bgApply);
      });

      document.getElementById("bvReset").addEventListener("click", function () {
        confirmDialog("Reset Background Visuals?",
          "This turns Background Visuals off and selects None. The visuals you imported stay in your library.", "Reset")
          .then(function (ok) { if (ok) return V.reset().then(function () { toast("Background Visuals reset"); bgApply(); }); });
      });
    }
    function sel(cur, val) { return cur === val ? " selected" : ""; }
    function switchHtml(id, checked) {
      return '<label class="switch"><input type="checkbox" id="' + id + '"' + (checked ? " checked" : "") + '>' +
        '<span class="switch__track"></span><span class="switch__thumb"></span></label>';
    }
    function toColorInput(hex) {
      if (!hex) return "#ffffff";
      if (hex.length === 4) return hex; // unlikely
      return hex.slice(0, 7);
    }
    renderSettings();
    renderThemes();

    // ---------------------------------------------------------------- audio effects panel
    var EFFECT_CONTROLS = [
      { key: "bass", label: "Bass", min: -12, max: 12, step: 0.5, unit: " dB", hint: "Low shelf at 200 Hz" },
      { key: "treble", label: "Treble", min: -12, max: 12, step: 0.5, unit: " dB", hint: "High shelf at 3.2 kHz" },
      { key: "pitch", label: "Voice depth / pitch", min: -12, max: 12, step: 1, unit: " st", hint: "Real pitch shift — tempo stays the same" },
      { key: "echo", label: "Echo", min: 0, max: 100, step: 1, unit: "%", hint: "280 ms delay with feedback" },
      { key: "reverb", label: "Reverb", min: 0, max: 100, step: 1, unit: "%", hint: "Convolution room, generated locally" },
      { key: "distortion", label: "Distortion", min: 0, max: 100, step: 1, unit: "%", hint: "Wave-shaper drive" },
      { key: "lowpass", label: "Low-pass filter", min: 200, max: 20000, step: 100, unit: " Hz", hint: "20 kHz = off" },
      { key: "highpass", label: "High-pass filter", min: 20, max: 2000, step: 10, unit: " Hz", hint: "20 Hz = off" },
      { key: "balance", label: "Stereo balance", min: -1, max: 1, step: 0.05, unit: "", hint: "−1 left … +1 right" }
    ];

    function boostPercent() { return state.desiredBoost; }
    function boostEffective() { return Math.round((fx ? fx.boost : 1) * 100); }

    function updateBoostBadge() {
      var pct = boostPercent();
      var live = boostEffective();
      var limited = pct > 100 && live < pct;
      els.boostBtn.textContent = pct + "%";
      els.boostBtn.classList.toggle("is-active", live > 100);
      els.boostBtn.classList.toggle("is-limited", limited);
      els.boostBtn.title = limited
        ? "Boost set to " + pct + "% but unavailable for the current source — click for details"
        : pct > 100
          ? "Audio boost active (" + pct + "%) — click to open the Effects panel"
          : "Audio boost (100% = normal) — click to open the Effects panel";
    }

    function fxBlockedReason() {
      if (!fx || !fx.isSupported()) {
        return "The Web Audio API is not available in this browser engine, so volume boost and audio effects cannot run.";
      }
      return null;
    }

    function renderEffects() {
      var blocked = fxBlockedReason();
      var supported = !!fx && fx.isSupported();
      var enabled = supported && fx.enabled;
      var params = supported ? fx.params : fx ? fx.DEFAULTS : {};
      var pct = boostPercent();

      var presetHtml = supported ? Object.keys(fx.PRESETS).map(function (key) {
        return '<button class="chip' + (fx.preset === key ? " is-active" : "") + '" data-preset="' + key + '"' +
          (enabled ? "" : " disabled") + '>' + fx.PRESETS[key].label + '</button>';
      }).join("") : "";

      var slidersHtml = supported ? EFFECT_CONTROLS.map(function (c) {
        var na = fx.unavailable[c.key];
        var value = params[c.key];
        return '<div class="fxrow' + (na ? " is-na" : "") + '">' +
          '<div class="fxrow__head"><span class="fxrow__label">' + c.label + '</span>' +
            '<span class="fxrow__value" data-value-for="' + c.key + '">' + formatFxValue(c, value) + '</span></div>' +
          '<input type="range" class="fxslider" data-fx="' + c.key + '" min="' + c.min + '" max="' + c.max +
            '" step="' + c.step + '" value="' + value + '"' + (enabled && !na ? "" : " disabled") + '>' +
          '<div class="fxrow__hint">' + (na ? escapeHtml(na) : c.hint) + '</div>' +
        '</div>';
      }).join("") : "";

      els.panelEffects.innerHTML =
        '<div class="settings">' +
          '<div class="settings-group"><h3>Volume boost</h3>' +
            '<div class="fxrow">' +
              '<div class="fxrow__head"><span class="fxrow__label">Audio boost</span>' +
                '<span class="fxrow__value' + (pct > 100 ? " is-hot" : "") + '" id="boostValue">' + pct + '%</span></div>' +
              '<input type="range" class="fxslider fxslider--boost" id="boostRange" min="100" max="400" step="5" value="' + pct + '"' +
                (supported ? "" : " disabled") + '>' +
              '<div class="fxrow__hint">100% is the normal, unprocessed level. Above 100% the signal is amplified ' +
                'through the Web Audio gain stage and passed through a limiter to reduce clipping.</div>' +
              (pct > 100 && boostEffective() < pct
                ? '<div class="notice notice--warn">Boost is set to ' + pct + '% but cannot be applied to the media ' +
                  'playing right now. It will take effect on the next source Ghost can process.</div>' : '') +
            '</div>' +
            '<div class="settings-row"><div class="settings-row__label">Player volume</div>' +
              '<div class="settings-row__hint" id="volMirror">' + Math.round(player.getVolume() * 100) + '%</div></div>' +
          '</div>' +

          '<div class="settings-group"><h3>DJ / Audio effects</h3>' +
            '<div class="settings-row"><div><div class="settings-row__label">Enable effects</div>' +
              '<div class="settings-row__hint">Off by default — playback stays untouched</div></div>' +
              switchHtml("fxEnabled", enabled) + '</div>' +
            (blocked ? '<div class="notice notice--warn">' + escapeHtml(blocked) + '</div>' : '') +
            '<div class="chips">' + presetHtml + '</div>' +
            slidersHtml +
            '<div class="settings-row"><div><div class="settings-row__label">Night mode</div>' +
              '<div class="settings-row__hint">Heavy dynamic-range compression: quiet parts lifted, loud parts tamed</div></div>' +
              switchHtml("fxNight", supported && !!params.night) + '</div>' +
            '<div class="settings-row"><button class="btn btn--ghost" id="fxResetBtn"' + (enabled ? "" : " disabled") + '>Reset effects</button>' +
              '<button class="btn btn--ghost" id="fxBoostResetBtn">Reset boost</button></div>' +
          '</div>' +

          fxProHtml(supported) +
          (supported ? '' : '<div class="notice notice--warn">Audio processing is unavailable in this engine.</div>') +
        '</div>';

      wireEffects();
      wireFxPro();
      updateBoostBadge();
    }

    // ---- Pro sound sections (shared GhostDSP rack: same engine as DJ Mode)
    function fxProHtml(supported) {
      var D = window.GhostDSP;
      if (!supported || !D) return "";
      var st = D.state;
      var voices = Object.keys(D.VOICES).map(function (k) {
        return '<button class="chip' + (st.voice === k ? " is-active" : "") + '" data-dsp-voice="' + k + '">' + D.VOICES[k].label + '</button>';
      }).join("");
      function row(key, label, min, max, val, hint) {
        return '<div class="fxrow"><div class="fxrow__head"><span class="fxrow__label">' + label + '</span><span class="fxrow__value" data-dsp-val="' + key + '">' + val + (key === "pitch" ? " st" : "%") + '</span></div>' +
          '<input type="range" class="fxslider" data-dsp="' + key + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '">' +
          (hint ? '<div class="fxrow__hint">' + hint + '</div>' : '') + '</div>';
      }
      var maxOn = st.bass >= 100 && st.sub >= 100;
      var toneCards = Object.keys(D.TONES).map(function (k) {
        var tn = D.TONES[k];
        return '<button type="button" class="tone-card' + (st.tone === k ? " is-active" : "") + '" data-dsp-tone="' + k + '" aria-pressed="' + (st.tone === k) + '"><b>' + tn.label + '</b><i>' + tn.where + '</i></button>';
      }).join("");
      return '' +
        '<div class="settings-group fxpro"><h3>Vocal remover (karaoke)</h3>' +
          row("vocal", "Amount", 0, 100, st.vocal, "Removes the voice sitting in the middle of a stereo song. Works on the song that is playing now, no setup. It is centre cancellation, not AI: reverb and doubled vocals remain a little.") +
          '<div class="chips"><button class="chip' + (st.vocalMode !== "only" ? " is-active" : "") + '" data-dsp-vmode="remove">Remove voice</button><button class="chip' + (st.vocalMode === "only" ? " is-active" : "") + '" data-dsp-vmode="only">Voice only</button></div>' +
        '</div>' +
        '<div class="settings-group fxpro"><h3>Voice changer</h3>' +
          '<div class="chips">' + voices + '</div>' +
          row("pitch", "Extra pitch (semitones)", -12, 12, st.pitch, "Real pitch shifting on whatever is playing — voice, song or video.") +
        '</div>' +
        '<div class="settings-group fxpro"><h3>Sound tone (swap the instruments)</h3>' +
          '<div class="settings-row__hint" style="margin:-4px 0 8px">Keep the singer, change the band. Every kick, snare and hi-hat in the song fires a real instrument hit instead (tabla, dholak, darbuka and more), the original drums are turned down, and a harmonium or pad drone plays underneath.</div>' +
          '<div class="tone-grid">' + toneCards + '</div>' +
          (st.tone && st.tone !== "off" ?
            '<div class="tone-meter" id="toneMeter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
            row("toneBeat", "New instrument level", 0, 100, st.toneBeat, "How loud the swapped instrument hits are.") +
            row("toneStrip", "Quiet the original drums", 0, 100, st.toneStrip, "Turns down the original kick, snare crack and hi-hats (and a little deep bass). The voice stays. Drums cannot be removed completely: this is filtering, not AI.") +
            row("toneDrone", "Harmonium / pad drone", 0, 100, st.toneDrone, "A held chord underneath, like a harmonium. Set to 0 for drums only.") +
            '<div class="settings-row"><div><div class="settings-row__label">Drone key</div><div class="settings-row__hint">Pick the note that sounds best with the song</div></div><select class="select" id="toneKeySel">' +
              D.TONE_NOTES.map(function (nm, i) { return '<option value="' + i + '"' + (st.toneKey === i ? " selected" : "") + '>' + nm + '</option>'; }).join("") + '</select></div>' : '') +
          '<p class="tone-note">Works best on songs with a clear beat. It follows the beat it hears, live, so tempo changes are followed too.</p>' +
        '</div>' +
        '<div class="settings-group fxpro"><h3>Bass monster &amp; earthquake</h3>' +
          row("bass", "Bass punch", 0, 100, st.bass, "Deep shelf plus harmonics, so even laptop speakers hit.") +
          row("sub", "Earthquake sub", 0, 100, st.sub, "Heavy 30–80 Hz layer. This is the part that shakes a table — how much depends on your speakers.") +
          '<button class="fxpro__big' + (maxOn ? " is-on" : "") + '" id="dspMaxBeat">MAX BEAT</button>' +
          '<p class="fxpro__warn">Max Beat is extremely loud. Lower your system volume first; it can damage small speakers and hearing.</p>' +
        '</div>' +
        '<div class="settings-group fxpro"><h3>HD sound</h3>' +
          row("hd", "HD clarity", 0, 100, st.hd, "Adds air and detail. It cannot invent quality a low-bitrate file never had.") +
          '<div class="settings-row"><div><div class="settings-row__label">96 kHz engine</div><div class="settings-row__hint">Runs the audio engine at 96 kHz if your sound card allows it. Restart the app to apply.</div></div>' + switchHtml("dspHires", D.hiresEnabled()) + '</div>' +
          '<div class="settings-row"><button class="btn btn--ghost" id="dspReset">Reset pro sound</button></div>' +
        '</div>';
    }
    function wireFxPro() {
      var D = window.GhostDSP; if (!D) return;
      document.querySelectorAll("[data-dsp]").forEach(function (inp) {
        inp.addEventListener("input", function () {
          var k = inp.getAttribute("data-dsp"), v = parseFloat(inp.value);
          D.set(k, v);
          var out = document.querySelector('[data-dsp-val="' + k + '"]');
          if (out) out.textContent = v + (k === "pitch" ? " st" : "%");
          syncFxAttachment();
        });
      });
      document.querySelectorAll("[data-dsp-voice]").forEach(function (b) {
        b.addEventListener("click", function () { D.set("voice", b.getAttribute("data-dsp-voice")); syncFxAttachment(); renderEffects(); });
      });
      document.querySelectorAll("[data-dsp-vmode]").forEach(function (b) {
        b.addEventListener("click", function () { D.set("vocalMode", b.getAttribute("data-dsp-vmode")); renderEffects(); });
      });
      // Sound tone: update the cards in place (no re-render under the mouse), re-render only when the sliders must appear or vanish
      document.querySelectorAll("[data-dsp-tone]").forEach(function (b) {
        b.addEventListener("click", function () {
          var k = b.getAttribute("data-dsp-tone"), was = D.state.tone;
          D.set("tone", k); syncFxAttachment();
          document.querySelectorAll("[data-dsp-tone]").forEach(function (x) { var on = x === b; x.classList.toggle("is-active", on); x.setAttribute("aria-pressed", on ? "true" : "false"); });
          if ((was === "off") !== (k === "off")) setTimeout(renderEffects, 0);
          toast(k === "off" ? "Sound tone: original" : "Sound tone: " + D.TONES[k].label);
        });
      });
      var tk = document.getElementById("toneKeySel");
      if (tk) tk.addEventListener("change", function () { D.set("toneKey", parseInt(tk.value, 10)); });
      var tm = document.getElementById("toneMeter");
      D.toneListeners.length = 0;
      if (tm) {
        var cells = tm.children;
        D.toneListeners.push(function (band, vel) {
          var base = band === "low" ? 0 : band === "mid" ? 4 : 8, i = base + Math.floor(Math.random() * 4), c = cells[i];
          if (!c) return;
          c.style.height = Math.round(5 + vel * 17) + "px"; c.classList.add("is-hit");
          setTimeout(function () { c.style.height = ""; c.classList.remove("is-hit"); }, 110);
        });
      }
      var mb = document.getElementById("dspMaxBeat");
      if (mb) mb.addEventListener("click", function () { var on = !(D.state.bass >= 100 && D.state.sub >= 100); D.maxBeat(on); syncFxAttachment(); renderEffects(); toast(on ? "MAX BEAT on" : "Max Beat off"); });
      var hi = document.getElementById("dspHires");
      if (hi) hi.addEventListener("change", function (e) { D.setHires(e.target.checked); toast(e.target.checked ? "96 kHz will be used the next time the app starts" : "Standard engine will be used the next time the app starts"); });
      var rs = document.getElementById("dspReset");
      if (rs) rs.addEventListener("click", function () { D.reset(); renderEffects(); toast("Pro sound reset"); });
    }

    function formatFxValue(c, v) {
      if (c.key === "balance") return (v > 0 ? "+" : "") + Number(v).toFixed(2);
      if (c.key === "lowpass" || c.key === "highpass") return Math.round(v) + c.unit;
      if (c.key === "pitch") return (v > 0 ? "+" : "") + Math.round(v) + c.unit;
      return (v > 0 && (c.key === "bass" || c.key === "treble") ? "+" : "") + Number(v) + c.unit;
    }

    function wireEffects() {
      var enableSwitch = document.getElementById("fxEnabled");
      if (enableSwitch) {
        enableSwitch.addEventListener("change", function (e) {
          if (!fx || !fx.isSupported()) { e.target.checked = false; toast("Audio processing is not available here"); return; }
          fx.setEnabled(e.target.checked);
          if (e.target.checked) syncFxAttachment();
          renderEffects();
        });
      }

      var boostRange = document.getElementById("boostRange");
      if (boostRange) {
        boostRange.addEventListener("input", function (e) {
          applyBoost(parseInt(e.target.value, 10));
          var out = document.getElementById("boostValue");
          if (out) {
            out.textContent = boostPercent() + "%";
            out.classList.toggle("is-hot", boostPercent() > 100);
          }
          e.target.value = boostPercent();
          updateBoostBadge();
        });
      }

      document.querySelectorAll("[data-fx]").forEach(function (input) {
        input.addEventListener("input", function () {
          var key = input.getAttribute("data-fx");
          var spec = EFFECT_CONTROLS.filter(function (c) { return c.key === key; })[0];
          var value = parseFloat(input.value);
          fx.set(key, value);
          var out = document.querySelector('[data-value-for="' + key + '"]');
          if (out) out.textContent = formatFxValue(spec, value);
          document.querySelectorAll("[data-preset]").forEach(function (c) { c.classList.remove("is-active"); });
        });
      });

      document.querySelectorAll("[data-preset]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          fx.applyPreset(btn.getAttribute("data-preset"));
          renderEffects();
        });
      });

      var night = document.getElementById("fxNight");
      if (night) {
        night.addEventListener("change", function (e) {
          if (!fx.enabled) { e.target.checked = false; toast("Enable effects first"); return; }
          fx.set("night", e.target.checked);
        });
      }

      var resetBtn = document.getElementById("fxResetBtn");
      if (resetBtn) resetBtn.addEventListener("click", function () { fx.reset(); renderEffects(); toast("Effects reset"); });

      var boostReset = document.getElementById("fxBoostResetBtn");
      if (boostReset) boostReset.addEventListener("click", function () { applyBoost(100); renderEffects(); });
    }

    function applyBoost(pct) {
      pct = Math.max(100, Math.min(400, pct || 100));
      if (!fx || !fx.isSupported()) { toast("Volume boost needs the Web Audio API"); return; }
      state.desiredBoost = pct;
      lib.settings.audioBoost = pct;
      lib.saveSettings();
      pushBoostToEngine();
    }

    // Keeps the gain stage in step with the requested level: the boost is only
    // engaged for sources Web Audio may actually read.
    function pushBoostToEngine() {
      if (!fx || !fx.isSupported()) return;
      var pct = state.desiredBoost;
      if (pct > 100 && fxSourceCapable()) {
        fx.setBoost(pct / 100);
        syncFxAttachment();
      } else {
        fx.setBoost(1);
      }
      updateBoostBadge();
    }

    els.boostBtn.addEventListener("click", function () {
      setPanel("effects");
      openSidebar(true);
    });

    // ---------------------------------------------------------------- keyboard shortcuts
    document.addEventListener("keydown", function (e) {
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (state.currentKind === "video" || state.currentKind === "audio") player.togglePlay();
          break;
        case "ArrowRight": player.seekBy(5); break;
        case "ArrowLeft": player.seekBy(-5); break;
        case "ArrowUp": e.preventDefault(); player.setVolume(player.getVolume() + 0.05); break;
        case "ArrowDown": e.preventDefault(); player.setVolume(player.getVolume() - 0.05); break;
        case "m": case "M": player.setMuted(!player.isMuted()); break;
        case "f": case "F": toggleFullscreen(); break;
        case "n": case "N": stepItem(1); break;
        case "p": case "P": stepItem(-1); break;
        case "i": case "I": toggleMini(); break;
        case "l": case "L": els.loopBtn.click(); break;
        case "Escape":
          if (document.fullscreenElement) document.exitFullscreen();
          else if (els.sidebar.classList.contains("is-open")) openSidebar(false);
          break;
      }
    });

    // ---------------------------------------------------------------- top bar helpers
    (function () {
      var fill = document.querySelector("#barProgress i");
      player.on("timeupdate", function () { if (fill) fill.style.width = (player.getProgress().fraction * 100).toFixed(1) + "%"; });
      player.on("stopped", function () { if (fill) fill.style.width = "0"; });
      document.getElementById("barOpenBtn").addEventListener("click", function () { document.getElementById("openFilesBtn").click(); });
    })();

    // ---------------------------------------------------------------- Mini Player
    // Video -> native Picture-in-Picture (a real floating window above other apps).
    // Audio -> Document Picture-in-Picture where the browser/Electron supports it; otherwise a draggable
    // floating panel inside the app that stays on top while you browse any section.
    var MINI_VARS = ["--accent", "--accent-contrast", "--accent-soft", "--glow", "--text", "--text-dim", "--text-faint", "--bg", "--bg-elevated", "--panel", "--panel-glass", "--border", "--border-soft", "--hover", "--radius-sm", "--radius-md", "--radius-lg", "--font"];
    var MINI_CSS =
      ".mini{box-sizing:border-box;display:flex;gap:12px;align-items:center;width:340px;max-width:calc(100vw - 24px);padding:10px 12px 16px;color:var(--text);font:13px var(--font);background:color-mix(in srgb,var(--bg-elevated) 82%,transparent);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 16px 40px rgba(0,0,0,.5);position:relative;overflow:hidden}" +
      ".mini--float{position:fixed;right:16px;bottom:16px;z-index:70;animation:miniIn .3s cubic-bezier(.2,.8,.2,1)}" +
      ".mini--out{animation:miniOut .2s ease forwards}" +
      "@keyframes miniIn{from{opacity:0;transform:translateY(16px) scale(.96)}}@keyframes miniOut{to{opacity:0;transform:translateY(12px) scale(.96)}}" +
      ".mini--pip{width:100%;height:100%;max-width:none;border:0;border-radius:0}" +
      ".mini__art{flex:none;width:56px;height:56px;border-radius:var(--radius-md);background:var(--accent-soft) center/cover no-repeat;display:grid;place-items:center;color:var(--accent);cursor:grab;touch-action:none}" +
      ".mini__body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}" +
      ".mini__meta{min-width:0;cursor:grab;touch-action:none}.mini__meta b,.mini__meta i{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mini__meta b{font-weight:600}.mini__meta i{font-style:normal;font-size:11.5px;color:var(--text-dim)}" +
      ".mini__row{display:flex;align-items:center;gap:2px}" +
      ".mini button{width:30px;height:30px;flex:none;border:0;border-radius:50%;background:transparent;color:var(--text);display:grid;place-items:center;cursor:pointer;padding:0;transition:background .15s,transform .12s}.mini button:hover{background:var(--hover)}.mini button:active{transform:scale(.9)}" +
      ".mini button[data-m=play]{background:var(--accent);color:var(--accent-contrast)}.mini button[data-m=play]:hover{background:var(--accent);opacity:.9}" +
      ".mini__vol{width:58px;margin:0 4px;accent-color:var(--accent)}.mini__sp{flex:1}" +
      ".mini__seek{position:absolute;left:0;right:0;bottom:-2px;width:100%;height:14px;margin:0;accent-color:var(--accent);cursor:pointer}";
    var MI = {
      prev: '<path d="M18 6 9 12l9 6V6Z" fill="currentColor"/><rect x="5.5" y="6" width="1.8" height="12" rx=".9" fill="currentColor"/>',
      next: '<path d="M6 6l9 6-9 6V6Z" fill="currentColor"/><rect x="16.7" y="6" width="1.8" height="12" rx=".9" fill="currentColor"/>',
      play: '<path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/>',
      pause: '<path d="M7.5 5.5h3v13h-3v-13Zm6 0h3v13h-3v-13Z" fill="currentColor"/>',
      expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      close: '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
    };
    var GHOST_GLYPH = '<svg viewBox="0 0 32 32" width="26" height="26"><path d="M16 3c-6.6 0-11 5.1-11 11v13.2c0 .9 1 1.4 1.7.8l2.6-2.3 2.7 2.3c.5.4 1.2.4 1.7 0l2.3-2 2.3 2c.5.4 1.2.4 1.7 0l2.7-2.3 2.6 2.3c.7.6 1.7.1 1.7-.8V14C27 8.1 22.6 3 16 3z" fill="currentColor"/></svg>';
    var mini = { el: null, win: null, seeking: false, metaId: null };
    var miniStyleInjected = false;

    function miniBtn(k, label) { return '<button type="button" data-m="' + k + '" aria-label="' + label + '" title="' + label + '"><svg width="17" height="17" viewBox="0 0 24 24" fill="none">' + MI[k === "play" ? "play" : k] + "</svg></button>"; }
    function miniQ(sel) { return mini.el && mini.el.querySelector(sel); }
    function miniLeaveScreens() {
      try { if (window.GhostScreens && GhostScreens.current()) GhostScreens.hide(GhostScreens.current()); } catch (e) {}
      try { if (window.GhostRadio && GhostRadio.isOpen && GhostRadio.isOpen()) GhostRadio.leave(); } catch (e) {}
    }

    function miniMeta() {
      var it = currentItem(), t = miniQ(".mini__meta b"), s = miniQ(".mini__meta i");
      if (!t) return;
      mini.metaId = it ? it.id : null;
      if (!it) { t.textContent = "Nothing playing"; s.textContent = "Open media to begin"; miniQ(".mini__art").style.backgroundImage = ""; miniQ(".mini__art").innerHTML = GHOST_GLYPH; return; }
      t.textContent = it.name.replace(/\.[^.]+$/, ""); s.textContent = it.kind;
      var art = miniQ(".mini__art");
      if (it.kind === "image") { art.style.backgroundImage = 'url("' + it.url + '")'; art.innerHTML = ""; }
      else { art.style.backgroundImage = ""; art.innerHTML = GHOST_GLYPH; }
      if (it.kind === "audio" && window.GhostTags) {
        var id = it.id;
        GhostTags.read(it.file).then(function (tg) {
          if (!mini.el || mini.metaId !== id) return;
          if (tg.title) t.textContent = tg.title;
          if (tg.artist) s.textContent = tg.artist;
        });
      }
    }
    function miniSync() {
      if (!mini.el) return;
      var play = miniQ('[data-m="play"] svg');
      if (play) play.innerHTML = player.isPaused() ? MI.play : MI.pause;
      var vol = miniQ(".mini__vol"); if (vol) vol.value = player.isMuted() ? 0 : Math.round(player.getVolume() * 100);
      var sk = miniQ(".mini__seek"); if (sk && !mini.seeking) sk.value = Math.round(player.getProgress().fraction * 1000) || 0;
      var it = currentItem(); if ((it ? it.id : null) !== mini.metaId) miniMeta();
    }
    ["play", "pause", "timeupdate", "volumechange", "canplay", "stopped"].forEach(function (ev) { player.on(ev, miniSync); });
    document.addEventListener("ghost:trackchange", function () { if (mini.el) { miniMeta(); miniSync(); } });

    function buildMini() {
      var d = document.createElement("div");
      d.className = "mini"; d.id = "miniPlayer"; d.setAttribute("role", "region"); d.setAttribute("aria-label", "Mini Player");
      d.innerHTML = '<div class="mini__art" data-drag></div><div class="mini__body"><div class="mini__meta" data-drag><b></b><i></i></div>' +
        '<div class="mini__row">' + miniBtn("prev", "Previous") + miniBtn("play", "Play / Pause") + miniBtn("next", "Next") +
        '<input class="mini__vol" type="range" min="0" max="100" aria-label="Volume"><span class="mini__sp"></span>' +
        miniBtn("expand", "Open full player") + miniBtn("close", "Close Mini Player") + '</div></div>' +
        '<input class="mini__seek" type="range" min="0" max="1000" value="0" aria-label="Seek">';
      d.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-m]"); if (!b) return;
        var k = b.getAttribute("data-m");
        if (k === "prev") stepItem(-1); else if (k === "next") stepItem(1);
        else if (k === "play") player.togglePlay();
        else if (k === "close") closeMini();
        else if (k === "expand") { var w = mini.win; closeMini(); miniLeaveScreens(); try { window.focus(); } catch (er) {} if (w) { try { w.close(); } catch (er2) {} } }
      });
      d.querySelector(".mini__vol").addEventListener("input", function (e) { player.setMuted(false); player.setVolume(e.target.value / 100); });
      var sk = d.querySelector(".mini__seek");
      sk.addEventListener("input", function (e) { mini.seeking = true; if (player.canSeek()) player.seekFraction(e.target.value / 1000); });
      sk.addEventListener("change", function () { mini.seeking = false; });
      return d;
    }
    function miniDrag(el) {
      var sx, sy, ox, oy, on = false;
      el.addEventListener("pointerdown", function (e) {
        if (!e.target.closest("[data-drag]") || mini.win) return;
        var r = el.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; on = true;
        el.style.left = ox + "px"; el.style.top = oy + "px"; el.style.right = "auto"; el.style.bottom = "auto";
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener("pointermove", function (e) {
        if (!on) return;
        var x = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - el.offsetWidth);
        var y = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - el.offsetHeight);
        el.style.left = x + "px"; el.style.top = y + "px";
      });
      el.addEventListener("pointerup", function () {
        if (!on) return; on = false;
        // Snap to the nearest corner so it never sits in the middle of the content.
        var r = el.getBoundingClientRect(), m = 16, left = r.left + r.width / 2 < window.innerWidth / 2, top = r.top + r.height / 2 < window.innerHeight / 2;
        el.style.transition = "left .25s cubic-bezier(.2,.8,.2,1), top .25s cubic-bezier(.2,.8,.2,1)";
        el.style.left = (left ? m : window.innerWidth - r.width - m) + "px"; el.style.top = (top ? m : window.innerHeight - r.height - m) + "px";
        setTimeout(function () { el.style.transition = ""; }, 280);
      });
    }
    function miniSetBtn(on) { var b = document.getElementById("miniBtn"); if (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("is-active", !!on); } }

    function mountFloat() {
      if (!miniStyleInjected) { var st = document.createElement("style"); st.id = "miniStyle"; st.textContent = MINI_CSS; document.head.appendChild(st); miniStyleInjected = true; }
      mini.el.classList.add("mini--float"); document.body.appendChild(mini.el); miniDrag(mini.el); miniMeta(); miniSync(); miniSetBtn(true);
    }
    function mountWindow(w) {
      var cs = getComputedStyle(document.documentElement);
      MINI_VARS.forEach(function (v) { w.document.documentElement.style.setProperty(v, cs.getPropertyValue(v)); });
      var st = w.document.createElement("style"); st.textContent = MINI_CSS + "html,body{margin:0;height:100%;background:var(--bg)}"; w.document.head.appendChild(st);
      mini.win = w; mini.el.classList.add("mini--pip"); w.document.body.appendChild(mini.el);
      w.addEventListener("pagehide", function () { mini.win = null; mini.el = null; miniSetBtn(false); });
      miniMeta(); miniSync(); miniSetBtn(true);
    }
    function openAudioMini() {
      mini.el = buildMini();
      if (window.documentPictureInPicture && documentPictureInPicture.requestWindow) {
        documentPictureInPicture.requestWindow({ width: 360, height: 116 }).then(mountWindow, function () { mountFloat(); });
      } else mountFloat();
    }
    function closeMini() {
      var el = mini.el, w = mini.win; mini.el = null; mini.win = null; miniSetBtn(false);
      if (w) { try { w.close(); } catch (e) {} return; }
      if (!el) return;
      var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (calm) el.remove(); else { el.classList.add("mini--out"); setTimeout(function () { el.remove(); }, 200); }
    }
    function toggleMini() {
      var v = document.getElementById("videoEl");
      if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function () {}); return; }
      if (mini.el) { closeMini(); return; }
      var it = currentItem();
      if (it && it.kind === "video" && document.pictureInPictureEnabled && !v.disablePictureInPicture) {
        v.requestPictureInPicture().then(function () { miniSetBtn(true); }, function () { openAudioMini(); });
        return;
      }
      openAudioMini();
    }
    var miniVideoEl = document.getElementById("videoEl");
    miniVideoEl.addEventListener("leavepictureinpicture", function () { miniSetBtn(false); });
    document.getElementById("miniBtn").addEventListener("click", toggleMini);

    // Small, read-mostly bridge for the separate DJ Mode / Lyrics screens (they never reach into app internals).
    window.GhostCore = {
      player: player,
      toast: toast,
      step: stepItem,
      getItems: function () { return lib.items.slice(); },
      addRemote: function (list, playFirst) {
        var added = lib.addRemote(list);
        renderLibrary(); renderRecents();
        if (added.length && playFirst !== false) playItem(added[0].id);
        return added;
      },
      getCurrent: currentItem,
      setPanel: setPanel,
      toggleMini: toggleMini
    };

    // ---------------------------------------------------------------- initial paint
    renderLibrary();
    renderRecents();
    renderEffects();
    updatePlayIcon(true);
    updateVolumeUI();
    updateBoostBadge();

    // Restore the saved Background Visual library + selection (starts empty on a fresh install).
    GhostVisuals.init().then(function () {
      renderSettings();
      syncVisual();
    });
  }
})();
