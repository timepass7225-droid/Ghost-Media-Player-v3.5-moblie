/* Ghost Media Player — ADVANCED UI DESIGN
 * Whole-app layouts (not colour themes): where the library sits, where the control bar lives, how the buttons are
 * arranged, plus a now-playing readout with a level meter. Picked in Settings (Advanced UI Design) or Themes.
 * The real controls are only moved with CSS (css/advanced.css, body[data-ui]); every button keeps working.
 * Alt+U cycles through the designs.
 */
(function (global) {
  "use strict";
  var KEY = "ghost.ui.v1";

  var DESIGNS = {
    normal:    { name: "Normal", tag: "The classic Ghost layout" },
    deck:      { name: "Mirror Deck", tag: "Library on the right, big play puck on a docked deck" },
    rail:      { name: "Cockpit Rails", tag: "Keys on left & right rails, volume on top, seek along the bottom" },
    island:    { name: "Floating Island", tag: "Rounded floating cards and a centred glass capsule" },
    cinema:    { name: "Cinema Drawer", tag: "Full-bleed stage, library slides out, slim one-row bar" },
    broadcast: { name: "Broadcast Console", tag: "Console at the top with tally LED and level meter" },
    pocket:    { name: "Pocket Dock", tag: "Four floating glass pills at the bottom, nothing else" },
    ribbon:    { name: "Top Ribbon", tag: "One slim ribbon along the top, library on the left" },
    theater:   { name: "Theater Right", tag: "Library slides in from the right, centred player capsule" },
    corner:    { name: "Corner Capsule", tag: "A small player floating in the bottom-left corner" }
  };
  var ORDER = Object.keys(DESIGNS);
  var cur = "normal";
  try { var v = localStorage.getItem(KEY); if (DESIGNS[v]) cur = v; } catch (e) { /* ignore */ }

  // small layout schematics for the picker (accent = the control bar / play key)
  function schematic(k) {
    var A = 'fill="var(--accent)"', S = 'fill="currentColor" opacity=".16"', L = 'fill="currentColor" opacity=".32"';
    var body = "";
    if (k === "normal")    body = '<rect x="4" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="42" y="52" width="66" height="12" rx="6" ' + L + '/><circle cx="75" cy="58" r="5" ' + A + '/>';
    if (k === "deck")      body = '<rect x="4" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="90" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="4" y="46" width="82" height="22" rx="8" ' + L + '/><circle cx="45" cy="57" r="9" ' + A + '/><rect x="10" y="54" width="14" height="4" rx="2" ' + S + '/><rect x="66" y="54" width="14" height="4" rx="2" ' + S + '/>';
    if (k === "rail")      body = '<rect x="4" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="38" y="20" width="9" height="30" rx="4" ' + L + '/><circle cx="42.5" cy="35" r="3.2" ' + A + '/><rect x="103" y="20" width="9" height="30" rx="4" ' + L + '/><rect x="62" y="8" width="26" height="7" rx="3.5" ' + L + '/><rect x="52" y="58" width="48" height="6" rx="3" ' + L + '/>';
    if (k === "island")    body = '<rect x="3" y="3" width="28" height="66" rx="8" ' + S + '/><rect x="35" y="3" width="82" height="66" rx="8" ' + S + '/><rect x="46" y="48" width="60" height="16" rx="8" ' + L + '/><circle cx="76" cy="56" r="5.5" ' + A + '/>';
    if (k === "cinema")    body = '<rect x="4" y="4" width="112" height="64" rx="3" ' + S + '/><rect x="4" y="4" width="30" height="64" rx="3" ' + L + ' opacity=".12"/><rect x="8" y="8" width="10" height="6" rx="2" ' + L + '/><rect x="4" y="58" width="112" height="10" ' + L + '/><circle cx="14" cy="63" r="3.5" ' + A + '/><rect x="24" y="62" width="64" height="2.5" rx="1.2" ' + A + ' opacity=".7"/>';
    if (k === "broadcast") body = '<rect x="4" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="90" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="4" y="4" width="82" height="22" rx="8" ' + L + '/><circle cx="11" cy="9" r="2" ' + A + '/><rect x="60" y="7" width="20" height="4" rx="1" ' + A + ' opacity=".7"/><circle cx="45" cy="19" r="4.5" ' + A + '/>';
    if (k === "pocket")    body = '<rect x="4" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="42" y="44" width="66" height="4" rx="2" ' + L + '/><rect x="38" y="53" width="22" height="11" rx="5.5" ' + L + '/><rect x="64" y="52" width="22" height="13" rx="6.5" ' + L + '/><circle cx="75" cy="58.5" r="4" ' + A + '/><rect x="90" y="53" width="22" height="11" rx="5.5" ' + L + '/>';
    if (k === "ribbon")    body = '<rect x="4" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="12" ' + L + '/><circle cx="46" cy="10" r="3.6" ' + A + '/><rect x="56" y="9" width="36" height="2.5" rx="1.2" ' + A + ' opacity=".7"/><rect x="98" y="8" width="12" height="4" rx="2" ' + S + '/>';
    if (k === "theater")   body = '<rect x="4" y="4" width="112" height="64" rx="3" ' + S + '/><rect x="86" y="4" width="30" height="64" rx="3" ' + L + ' opacity=".14"/><rect x="104" y="8" width="8" height="6" rx="2" ' + L + '/><rect x="30" y="48" width="60" height="16" rx="8" ' + L + '/><circle cx="60" cy="56" r="5.5" ' + A + '/>';
    if (k === "corner")    body = '<rect x="4" y="4" width="26" height="64" rx="3" ' + S + '/><rect x="34" y="4" width="82" height="64" rx="3" ' + S + '/><rect x="38" y="42" width="44" height="22" rx="7" ' + L + '/><circle cx="52" cy="53" r="5" ' + A + '/><rect x="60" y="48" width="18" height="2.5" rx="1.2" ' + S + '/><rect x="60" y="57" width="14" height="2.5" rx="1.2" ' + S + '/>';
    return '<svg viewBox="0 0 120 72" aria-hidden="true">' + body + '</svg>';
  }

  function apply() {
    // no slide/fade animation while the whole layout is being swapped
    document.body.classList.add("ui-switch");
    requestAnimationFrame(function () { requestAnimationFrame(function () { document.body.classList.remove("ui-switch"); }); });
    document.body.setAttribute("data-ui", cur);
    var sb = document.getElementById("sidebar");
    if (!isDrawer() && sb) sb.classList.remove("is-open");     // the drawer only exists in Cinema / Theater (and on phones)
  }

  // ---- now-playing readout inside the control bar (shown by Deck / Island / Broadcast)
  function buildReadout() {
    var controls = document.getElementById("controls"), title = document.getElementById("nowTitle");
    if (!controls || controls.querySelector(".ui-np")) return;
    var np = document.createElement("div");
    np.className = "ui-np";
    np.innerHTML = '<span class="ui-np__led"></span><span class="ui-np__t"></span><span class="ui-vu"><i></i><i></i><i></i><i></i><i></i></span>';
    controls.insertBefore(np, controls.firstChild);
    var t = np.querySelector(".ui-np__t");
    function sync() { t.textContent = title ? title.textContent : ""; }
    sync();
    if (title && global.MutationObserver) new MutationObserver(sync).observe(title, { childList: true, characterData: true, subtree: true });
  }

  // body[data-playing="1"] while any media element plays (drives the LED, meter and ring animation)
  function watchPlaying() {
    function setP(v) { document.body.setAttribute("data-playing", v ? "1" : "0"); }
    document.addEventListener("playing", function () { setP(true); }, true);
    document.addEventListener("play", function () { setP(true); }, true);
    document.addEventListener("pause", function () { setP(false); }, true);
    document.addEventListener("ended", function () { setP(false); }, true);
  }

  function isDrawer() { return cur === "cinema" || cur === "theater"; }

  // Cinema / Theater drawer: close on outside click / Escape
  function drawerClose() {
    document.addEventListener("click", function (e) {
      if (!isDrawer()) return;
      var sb = document.getElementById("sidebar"), tg = document.getElementById("sidebarToggle");
      if (!sb || !sb.classList.contains("is-open")) return;
      if (sb.contains(e.target) || (tg && tg.contains(e.target))) return;
      sb.classList.remove("is-open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isDrawer()) { var sb = document.getElementById("sidebar"); if (sb) sb.classList.remove("is-open"); }
      if ((e.key === "u" || e.key === "U") && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        api.set(ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]);
        var t = document.getElementById("toast");
        if (t) { t.textContent = "UI design: " + DESIGNS[cur].name; t.hidden = false; clearTimeout(api._tt); api._tt = setTimeout(function () { t.hidden = true; }, 1600); }
      }
    });
  }

  var api = {
    DESIGNS: DESIGNS,
    current: function () { return cur; },
    set: function (k) {
      if (!DESIGNS[k]) return;
      cur = k;
      try { localStorage.setItem(KEY, k); } catch (e) { /* ignore */ }
      apply();
    },
    // picker used in the Themes panel
    cardsHtml: function (esc) {
      return '<div class="settings-group"><h3>Advanced UI Design</h3>' +
        '<div class="settings-row__hint" style="margin:-4px 0 8px">Changes the layout of the whole app (library side, control bar, key arrangement). Not a colour theme. Alt+U cycles.</div>' +
        '<div class="ui-cards">' + ORDER.map(function (k) {
          return '<button type="button" class="ui-card' + (k === cur ? ' is-active' : '') + '" data-ui-key="' + k + '" aria-pressed="' + (k === cur) + '">' +
            schematic(k) + '<b>' + esc(DESIGNS[k].name) + '</b><i>' + esc(DESIGNS[k].tag) + '</i></button>';
        }).join("") + '</div></div>';
    },
    init: function () { apply(); buildReadout(); }
  };
  global.GhostUI = api;

  function boot() { apply(); buildReadout(); watchPlaying(); drawerClose(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(window);
