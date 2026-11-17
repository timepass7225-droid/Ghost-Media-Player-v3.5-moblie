/* Ghost Media Player — full-screen section coordinator
 *
 * Radio, DJ Mode and Lyrics each take over the main stage (they hide the
 * normal player viewport). Radio manages itself; this tiny helper makes sure
 * DJ Mode and Lyrics never end up on screen at the same time as each other
 * or as Radio, and that the player viewport comes back when none is open.
 * It does not touch playback.
 */
(function (global) {
  "use strict";
  if (global.GhostScreens) return;

  var screens = {};     // name -> { el, title, onShow, onHide }
  var current = null;

  function dom() {
    return {
      stage: document.getElementById("stage"),
      viewport: document.getElementById("viewport"),
      sidebar: document.getElementById("sidebar"),
      title: document.getElementById("nowTitle")
    };
  }
  function radioOpen() { return !!(global.GhostRadio && global.GhostRadio.isOpen && global.GhostRadio.isOpen()); }

  var S = {
    register: function (name, def) { screens[name] = def; },
    current: function () { return current; },
    isOpen: function (name) { return current === name; },

    show: function (name) {
      var def = screens[name], d = dom();
      if (!def || !def.el || !d.viewport) return;
      if (current && current !== name) S.hide(current, true);
      if (radioOpen()) global.GhostRadio.leave();      // radio keeps playing; only its screen closes
      if (current === name) return;
      current = name;
      d.viewport.hidden = true;
      def.el.hidden = false;
      d.stage.classList.add("is-" + name);
      if (d.sidebar) d.sidebar.classList.remove("is-open");   // on phones the drawer would cover the screen
      if (d.title && def.title) { def.prevTitle = d.title.textContent; d.title.textContent = def.title; }
      if (def.onShow) def.onShow();
    },

    /* keepViewportHidden: true when another screen is about to take over. */
    hide: function (name, keepViewportHidden) {
      var def = screens[name], d = dom();
      if (!def || current !== name) return;
      current = null;
      def.el.hidden = true;
      d.stage.classList.remove("is-" + name);
      if (!keepViewportHidden && !radioOpen()) d.viewport.hidden = false;
      // restore the title only if nothing else (e.g. a new track) has replaced it meanwhile
      if (d.title && def.title && d.title.textContent === def.title) d.title.textContent = def.prevTitle || "Ghost Media Player";
      if (def.onHide) def.onHide();
    }
  };

  global.GhostScreens = S;
})(window);
