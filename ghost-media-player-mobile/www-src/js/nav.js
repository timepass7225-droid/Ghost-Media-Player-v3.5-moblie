/* Ghost orb navigation (v2.1): a 28px glass orb docked in the sidebar under the logo.
 * Options stay HIDDEN until the orb is hovered (mouse) or activated (click / tap / Enter / O key), then expand
 * vertically with a staggered, magnetic motion. Items trigger the existing nav buttons, so no feature changes.
 * Fallback: Settings > Navigation > "Orb navigation" off restores the classic always-visible list. */
(function () {
  "use strict";
  var KEY = "ghost.nav.mode";
  var mode = "orb";
  try { mode = localStorage.getItem(KEY) === "simple" ? "simple" : "orb"; } catch (e) {}

  var sidebar = document.getElementById("sidebar");
  var brand = sidebar && sidebar.querySelector(".brand");
  if (!sidebar || !brand) return;

  function svg(d) { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>"; }
  function core() { return window.GhostCore; }
  function leaveScreens() {
    try { if (window.GhostScreens && GhostScreens.current()) GhostScreens.hide(GhostScreens.current()); } catch (e) {}
    try { if (window.GhostRadio && GhostRadio.isOpen && GhostRadio.isOpen()) GhostRadio.leave(); } catch (e) {}
  }
  function panelBtn(name) { return sidebar.querySelector('.navitem[data-panel="' + name + '"]'); }
  function openPanel(name) { var b = panelBtn(name); if (b) b.click(); }
  function library(filter) {
    return function () {
      leaveScreens(); openPanel("library");
      var l = document.getElementById("libraryList"); if (l) { if (filter) l.setAttribute("data-filter", filter); else l.removeAttribute("data-filter"); }
      current = filter || "home"; sync();
    };
  }
  var ITEMS = [
    { id: "home",    label: "Home",     icon: svg('<path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/>'), run: library(null) },
    { id: "radio",   label: "Radio",    panel: "radio" },
    { id: "dj",      label: "DJ Mode",  panel: "dj" },
    { id: "lyrics",  label: "Lyrics",   panel: "lyrics" },
    { id: "effects", label: "Effects",  panel: "effects" },
    { id: "themes",  label: "Themes",   panel: "themes" },
    { id: "settings",label: "Settings", panel: "settings" },
    { id: "mini",     label: "Mini Player", icon: svg('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><rect x="11.5" y="11" width="7" height="5" rx="1.2" fill="currentColor"/>'),
      run: function () { if (core() && core().toggleMini) core().toggleMini(); } },
    { id: "about",   label: "About",    icon: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>'),
      run: function () { leaveScreens(); openPanel("settings"); setTimeout(function () { var a = document.querySelector("#panel-settings .about"); if (a) a.scrollIntoView({ block: "center", behavior: "smooth" }); }, 60); } }
  ];
  var current = "home";

  var dock = document.createElement("div");
  dock.className = "orbdock";
  dock.innerHTML =
    '<button type="button" class="orb" aria-haspopup="true" aria-expanded="false" aria-label="Navigation orb" title="Navigate (O)"><span class="orb__core"></span></button>' +
    '<span class="orbdock__label">Navigate</span>' +
    '<div class="orbmenu" role="menu" aria-hidden="true"></div>';
  brand.insertAdjacentElement("afterend", dock);
  var orb = dock.querySelector(".orb"), label = dock.querySelector(".orbdock__label"), menu = dock.querySelector(".orbmenu");

  var btns = ITEMS.map(function (it, i) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "orbitem"; b.setAttribute("role", "menuitem"); b.tabIndex = -1;
    b.style.setProperty("--i", i);
    var src = it.panel && panelBtn(it.panel);
    var icon = it.icon || (src && src.querySelector("svg") ? src.querySelector("svg").outerHTML : "");
    b.innerHTML = icon + "<span>" + it.label + "</span>";
    b.addEventListener("click", function () {
      if (it.run) it.run();
      else {
        // Radio / DJ / Lyrics open their own screens; every other panel first closes any open screen.
        if (!/^(radio|dj|lyrics)$/.test(it.panel)) leaveScreens();
        openPanel(it.panel); current = it.id; sync();
      }
      close();
    });
    menu.appendChild(b);
    return b;
  });
  function sync() {
    ITEMS.forEach(function (it, i) { btns[i].classList.toggle("is-current", it.id === current); });
    var c = ITEMS.filter(function (it) { return it.id === current; })[0];
    label.textContent = c ? c.label : "Navigate";
  }

  var open = false, closeT = 0, raf = 0, px = 0, py = 0;
  function setOpen(v) {
    open = v; clearTimeout(closeT);
    dock.classList.toggle("is-open", v);
    orb.setAttribute("aria-expanded", v ? "true" : "false");
    menu.setAttribute("aria-hidden", v ? "false" : "true");
    btns.forEach(function (b) { b.tabIndex = v ? 0 : -1; });
    if (!v) btns.forEach(function (b) { b.style.removeProperty("--mx"); b.style.removeProperty("--glow"); });
  }
  function close() { setOpen(false); }
  function magnet() {
    raf = 0;
    btns.forEach(function (b) {
      var r = b.getBoundingClientRect(), cy = r.top + r.height / 2, d = Math.abs(py - cy), k = Math.max(0, 1 - d / 70);
      b.style.setProperty("--mx", (k * 7).toFixed(1) + "px");
      b.style.setProperty("--glow", k.toFixed(2));
    });
  }
  var hoverCapable = window.matchMedia && matchMedia("(hover: hover)").matches;
  orb.addEventListener("click", function () { setOpen(!open); });
  if (hoverCapable) {
    dock.addEventListener("pointerenter", function () { if (mode === "orb") setOpen(true); });
    dock.addEventListener("pointerleave", function () { clearTimeout(closeT); closeT = setTimeout(close, 260); });
    menu.addEventListener("pointermove", function (e) { if (!open) return; px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(magnet); }, { passive: true });
  }
  document.addEventListener("pointerdown", function (e) { if (open && !dock.contains(e.target)) close(); });
  document.addEventListener("keydown", function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.key === "Escape" && open) { close(); orb.focus(); return; }
    if ((e.key === "o" || e.key === "O") && !e.ctrlKey && !e.metaKey && !e.altKey && mode === "orb") { setOpen(!open); if (open) btns[0].focus(); }
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      var i = btns.indexOf(document.activeElement); i = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length; btns[i].focus();
    }
  });
  // Keep the active label correct when a section is opened by other buttons (e.g. top-bar Settings).
  sidebar.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".navitem[data-panel]");
    if (b && ITEMS.some(function (it) { return it.panel === b.dataset.panel; })) { current = b.dataset.panel; sync(); }
  });
  var sb = document.getElementById("stageSettingsBtn");
  if (sb) sb.addEventListener("click", function () { current = "settings"; sync(); });
  // Pause the idle core pulse while the window is hidden.
  document.addEventListener("visibilitychange", function () { document.body.classList.toggle("is-tab-hidden", document.hidden); });

  function apply() {
    document.body.classList.toggle("nav-orb", mode === "orb");
    document.body.classList.toggle("nav-simple", mode === "simple");
    if (mode === "simple") close();
  }
  window.GhostNav = {
    setMode: function (m) { mode = m === "simple" ? "simple" : "orb"; try { localStorage.setItem(KEY, mode); } catch (e) {} apply(); },
    getMode: function () { return mode; },
    open: function () { setOpen(true); }, close: close
  };
  sync(); apply();
})();
