/* Ghost Media Player — 3D look v3
 *
 * What changed compared with v2 (all on purpose):
 *  - NOTHING moves any more. The control bar, panels and cards no longer tilt toward the mouse, and buttons no longer
 *    jump up on hover or sink on press. The old movement slid the clickable area out from under the pointer, which made
 *    theme cards and buttons flicker and miss clicks. Depth is now drawn with shadows and gradients only.
 *  - Four strengths:  Smooth (barely there) / Normal (buttons only) / Medium (buttons + bars + cards) / Deep (everything).
 *  - Six clearly different looks: Bevel, Glossy Jelly, Soft Clay, Arcade Block, Brushed Metal, Crystal Glass.
 *  - A small light spot follows the pointer across a hovered button. It only changes a gradient, never the size or
 *    position of anything.
 *
 * Pure CSS (css/look3d.css) driven by body[data-3d], body[data-3dl] and body[data-3ds]. No WebGL, no network.
 */
(function (global) {
  "use strict";
  var KEY = "ghost.look3d.v1", KEY_LVL = "ghost.look3d.level", KEY_STYLE = "ghost.look3d.style";

  var LEVELS = {
    smooth: { name: "Smooth", tag: "Barely-there depth" },
    normal: { name: "Normal", tag: "Only the buttons look 3D" },
    medium: { name: "Medium", tag: "Buttons, control bar and cards" },
    deep:   { name: "Deep", tag: "Thick keys and heavy shadows everywhere" }
  };
  var STYLES = {
    bevel:   { name: "Classic Bevel", tag: "Chunky keys with a lit top edge" },
    glossy:  { name: "Glossy Jelly", tag: "Shiny candy buttons with a glow" },
    clay:    { name: "Soft Clay", tag: "Pressed-out soft shapes, no hard edges" },
    arcade:  { name: "Arcade Block", tag: "Solid black outline and a hard block shadow" },
    metal:   { name: "Brushed Metal", tag: "Hi-fi steel plates with a bright rim" },
    crystal: { name: "Crystal Glass", tag: "See-through glass with sharp glints" }
  };
  var LEVEL_KEYS = Object.keys(LEVELS), STYLE_KEYS = Object.keys(STYLES);

  var on = false, level = "normal", style = "bevel";
  try {
    on = localStorage.getItem(KEY) === "1";
    var l = localStorage.getItem(KEY_LVL);
    if (l === "soft") l = "smooth";                      // name used by v2
    if (LEVELS[l]) level = l;
    var s = localStorage.getItem(KEY_STYLE);
    if (STYLES[s]) style = s;
  } catch (e) { /* storage unavailable */ }

  var LIGHT = ".iconbtn, .btn, .pillbtn, .dj-btn, .chip, .navitem";
  var glow = null;

  function apply() {
    var b = document.body;
    if (!b) return;
    b.setAttribute("data-3d", on ? "on" : "off");
    b.setAttribute("data-3dl", level);
    b.setAttribute("data-3ds", style);
  }
  function clearLight(el) { if (el) { el.style.removeProperty("--lx"); el.style.removeProperty("--ly"); } }

  // light spot: only a gradient centre changes, so the button's box never moves
  document.addEventListener("mousemove", function (e) {
    if (!on) return;
    var tgt = e.target && e.target.closest ? e.target : null;
    var g = tgt ? tgt.closest(LIGHT) : null;
    if (g !== glow) { clearLight(glow); glow = g; }
    if (!g) return;
    var r = g.getBoundingClientRect();
    if (!r.width || !r.height) return;
    g.style.setProperty("--lx", Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)).toFixed(0) + "%");
    g.style.setProperty("--ly", Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)).toFixed(0) + "%");
  }, { passive: true });
  document.addEventListener("mouseleave", function () { clearLight(glow); glow = null; });

  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  global.GhostLook3D = {
    LEVELS: LEVELS, STYLES: STYLES,
    isOn: function () { return on; },
    level: function () { return level; },
    style: function () { return style; },
    set: function (v) {
      on = !!v; save(KEY, on ? "1" : "0"); apply();
      if (!on) { clearLight(glow); glow = null; }
    },
    setLevel: function (v) { if (!LEVELS[v]) return; level = v; save(KEY_LVL, level); apply(); },
    setStyle: function (v) { if (!STYLES[v]) return; style = v; save(KEY_STYLE, style); apply(); },
    init: apply
  };
  if (document.body) apply(); else document.addEventListener("DOMContentLoaded", apply);
})(window);
