/* Ghost Media Player MOBILE edition — phone behaviour layer (loads after every other script).
 * Adds: bottom tab bar + "More" sheet, Android back button, lock-screen / notification controls (Media Session),
 * screen-awake while a video plays. It only clicks the app's own existing buttons, so no desktop feature is changed. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body, sidebar = $("sidebar"), stage = $("stage");
  if (!sidebar || !stage) return;
  body.classList.add("is-mobile");

  function ic(d) { return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>"; }
  var ICON = {
    home: ic('<path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/>'),
    radio: ic('<rect x="3.5" y="8.5" width="17" height="11" rx="2.5"/><path d="M7 8.5 17.5 4"/><circle cx="16" cy="14" r="2.3"/>'),
    dj: ic('<circle cx="8" cy="12" r="5.6"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="17.5" cy="9" r="3.4"/>'),
    lyrics: ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>'),
    more: ic('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>')
  };

  /* ---------- run an action the desktop orb menu already knows (Home, Radio, DJ Mode, Lyrics, Effects, Themes, Settings, About) ---------- */
  function orbItem(label) {
    var all = document.querySelectorAll(".orbitem");
    for (var i = 0; i < all.length; i++) if (all[i].textContent.replace(/\s+/g, " ").trim() === label) return all[i];
    return null;
  }
  var SCREEN_TABS = { Radio: 1, "DJ Mode": 1, Lyrics: 1 };
  function go(label) {
    closeMore();
    var b = orbItem(label);
    if (!b) return;
    b.click();
    // Library / Effects / Themes / Settings live in the sidebar, which on a phone is a full-width sheet.
    if (!SCREEN_TABS[label]) sidebar.classList.add("is-open"); else sidebar.classList.remove("is-open");
    sync();
  }

  /* ---------- tab bar ---------- */
  var TABS = [
    { id: "Home", label: "Library", icon: ICON.home },
    { id: "Radio", label: "Radio", icon: ICON.radio },
    { id: "DJ Mode", label: "DJ", icon: ICON.dj },
    { id: "Lyrics", label: "Lyrics", icon: ICON.lyrics },
    { id: "more", label: "More", icon: ICON.more }
  ];
  var bar = document.createElement("nav");
  bar.className = "mtabs"; bar.setAttribute("aria-label", "Main");
  bar.innerHTML = TABS.map(function (t) {
    return '<button type="button" class="mtab" data-tab="' + t.id + '" aria-label="' + t.label + '">' + t.icon + "<span>" + t.label + "</span></button>";
  }).join("");
  document.body.appendChild(bar);

  var sheet = document.createElement("div");
  sheet.className = "msheet"; sheet.hidden = true;
  sheet.innerHTML = '<div class="msheet__scrim"></div><div class="msheet__panel" role="menu">' +
    ["Effects", "Themes", "Settings", "About"].map(function (n) { return '<button type="button" class="msheet__item" role="menuitem" data-go="' + n + '">' + n + "</button>"; }).join("") + "</div>";
  document.body.appendChild(sheet);

  function openMore() { sheet.hidden = false; sync(); }
  function closeMore() { if (!sheet.hidden) { sheet.hidden = true; sync(); } }

  bar.addEventListener("click", function (e) {
    var t = e.target.closest(".mtab"); if (!t) return;
    var id = t.getAttribute("data-tab");
    if (id === "more") { sheet.hidden ? openMore() : closeMore(); return; }
    // tapping the Library tab while it is already open closes the sheet again (back to the player)
    if (id === "Home" && sidebar.classList.contains("is-open") && currentTab() === "Home") { sidebar.classList.remove("is-open"); sync(); return; }
    go(id);
  });
  sheet.addEventListener("click", function (e) {
    if (e.target.classList.contains("msheet__scrim")) return closeMore();
    var b = e.target.closest(".msheet__item"); if (b) go(b.getAttribute("data-go"));
  });

  function currentTab() {
    if (!sheet.hidden) return "more";
    var s = window.GhostScreens && GhostScreens.current();
    if (s === "dj") return "DJ Mode";
    if (s === "lyrics") return "Lyrics";
    if (window.GhostRadio && GhostRadio.isOpen && GhostRadio.isOpen()) return "Radio";
    if (sidebar.classList.contains("is-open")) {
      var cur = document.querySelector(".orbitem.is-current");
      var name = cur ? cur.textContent.trim() : "Home";
      return /^(Effects|Themes|Settings|About)$/.test(name) ? "more" : "Home";
    }
    return "";
  }
  function sync() {
    var c = currentTab();
    var all = bar.querySelectorAll(".mtab");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("is-on", all[i].getAttribute("data-tab") === c);
    body.classList.toggle("m-sheet-open", sidebar.classList.contains("is-open"));
  }
  new MutationObserver(sync).observe(sidebar, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ["class"] });
  var radioScreen = $("radioScreen");
  if (radioScreen) new MutationObserver(sync).observe(radioScreen, { attributes: true, attributeFilter: ["hidden"] });
  sync();

  /* ---------- hardware / gesture BACK (Capacitor App plugin; Escape in a browser) ---------- */
  function goBack() {
    if (!sheet.hidden) { closeMore(); return true; }
    if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) {} return true; }
    if (sidebar.classList.contains("is-open")) { sidebar.classList.remove("is-open"); sync(); return true; }
    var open = currentTab();
    if (open === "DJ Mode" || open === "Lyrics" || open === "Radio") { go("Home"); sidebar.classList.remove("is-open"); sync(); return true; }
    return false;                                                   // nothing to close: let Android minimise / leave
  }
  window.GhostMobile = { back: goBack, go: go };
  var cap = window.Capacitor, appPlugin = cap && cap.Plugins && cap.Plugins.App;
  if (appPlugin && appPlugin.addListener) {
    appPlugin.addListener("backButton", function () {
      if (!goBack() && appPlugin.minimizeApp) appPlugin.minimizeApp();   // keep the music going instead of killing the app
    });
  }

  /* ---------- lock-screen / notification controls ---------- */
  var audio = $("audioEl"), video = $("videoEl"), title = $("nowTitle"), playBtn = $("playBtn");
  var ms = navigator.mediaSession;
  function activeEl() { return video && !video.hidden && video.src ? video : audio; }
  function pushMeta() {
    if (!ms || !window.MediaMetadata) return;
    var t = (title && title.textContent || "").trim();
    if (!t || /^(Ghost Media Player|DJ Mode|Lyrics|Radio)$/i.test(t)) return;
    try { ms.metadata = new MediaMetadata({ title: t, artist: "Ghost Media Player", album: "" }); } catch (e) {}
  }
  if (ms) {
    var act = function (name, fn) { try { ms.setActionHandler(name, fn); } catch (e) {} };
    var press = function (id) { return function () { var b = $(id); if (b) b.click(); }; };
    act("play", function () { var el = activeEl(); if (el && el.paused && playBtn) playBtn.click(); });
    act("pause", function () { var el = activeEl(); if (el && !el.paused && playBtn) playBtn.click(); });
    act("previoustrack", press("prevBtn"));
    act("nexttrack", press("nextBtn"));
    act("seekto", function (d) { var el = activeEl(); if (el && d && typeof d.seekTime === "number") el.currentTime = d.seekTime; });
    act("seekbackward", function () { var el = activeEl(); if (el) el.currentTime = Math.max(0, el.currentTime - 10); });
    act("seekforward", function () { var el = activeEl(); if (el) el.currentTime = el.currentTime + 10; });
    if (title) new MutationObserver(pushMeta).observe(title, { childList: true, characterData: true, subtree: true });
    [audio, video].forEach(function (el) {
      if (!el) return;
      el.addEventListener("play", function () { ms.playbackState = "playing"; pushMeta(); });
      el.addEventListener("pause", function () { ms.playbackState = "paused"; });
      el.addEventListener("ended", function () { ms.playbackState = "none"; });
    });
  }

  /* ---------- keep the screen on only while a video is actually playing ---------- */
  var lock = null;
  function wake(on) {
    if (!navigator.wakeLock) return;
    if (on && !lock) navigator.wakeLock.request("screen").then(function (l) { lock = l; l.addEventListener("release", function () { lock = null; }); }).catch(function () {});
    else if (!on && lock) { lock.release().catch(function () {}); lock = null; }
  }
  if (video) {
    video.addEventListener("play", function () { wake(true); });
    ["pause", "ended", "emptied"].forEach(function (n) { video.addEventListener(n, function () { wake(false); }); });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && video && !video.paused) wake(true); });

  /* ---------- touch polish ---------- */
  // double-tap zoom and long-press text selection make a player feel like a web page; both are off outside text fields
  document.addEventListener("contextmenu", function (e) { if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault(); });
})();
