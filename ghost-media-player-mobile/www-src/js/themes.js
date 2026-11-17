/* Ghost Media Player — theme system
 * 37 complete themes (colors + stage backdrop + font + shape) plus optional custom
 * accent / background colors, persisted to localStorage. No external requests.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "ghost.theme.v1";
  var SANS = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif";
  var ROUND = "\"Trebuchet MS\", \"Segoe UI\", Roboto, Arial, sans-serif";
  var SERIF = "Georgia, \"Iowan Old Style\", \"Times New Roman\", serif";
  var MONO = "\"SF Mono\", \"Cascadia Mono\", Consolas, \"Courier New\", monospace";

  // stage = backdrop of the main playback area (behind title / ghost icon).
  var PRESETS = {
    ghost: {
      name: "Ghost", tag: "Classic black & white",
      bg: "#0a0a0c", bgElevated: "#111114", panel: "#0f0f12",
      text: "#f3f3f5", accent: "#ffffff",
      stage: "radial-gradient(ellipse at 50% 30%, #1c1c22 0%, #050506 70%)",
      radius: 14, font: SANS
    },
    obsidian: {
      name: "Obsidian", tag: "Pure black, sharp corners",
      bg: "#000000", bgElevated: "#0a0a0a", panel: "#080808",
      text: "#ececec", accent: "#e6e6e6",
      stage: "#000000", radius: 4, font: SANS
    },
    neon: {
      name: "Neon City", tag: "Cyberpunk pink & cyan",
      bg: "#0b0714", bgElevated: "#130c22", panel: "#100a1d",
      text: "#f4eeff", accent: "#ff3cac",
      stage: "radial-gradient(ellipse at 20% 15%, rgba(255,60,172,.35), transparent 55%), radial-gradient(ellipse at 85% 85%, rgba(0,229,255,.30), transparent 55%), #07040f",
      radius: 10, font: ROUND
    },
    midnight: {
      name: "Midnight", tag: "Deep navy, soft blue",
      bg: "#070b17", bgElevated: "#0d1426", panel: "#0a1020",
      text: "#e8eeff", accent: "#6ea8ff",
      stage: "radial-gradient(ellipse at 50% 20%, #15234a 0%, #050814 72%)", radius: 14, font: SANS
    },
    cyber: {
      name: "Cyber", tag: "Electric green on black",
      bg: "#030806", bgElevated: "#08130f", panel: "#06100c",
      text: "#e6fff4", accent: "#19ff9c",
      stage: "radial-gradient(ellipse at 80% 10%, rgba(25,255,156,.22), transparent 55%), radial-gradient(ellipse at 10% 90%, rgba(0,170,255,.18), transparent 55%), #020605", radius: 6, font: MONO
    },
    aurora: {
      name: "Aurora", tag: "Northern lights",
      bg: "#07121a", bgElevated: "#0d1c27", panel: "#0a1721",
      text: "#eafff8", accent: "#5df2c2",
      stage: "radial-gradient(ellipse at 20% 10%, rgba(93,242,194,.30), transparent 55%), radial-gradient(ellipse at 85% 30%, rgba(150,110,255,.28), transparent 55%), #050e15", radius: 16, font: SANS
    },
    ice: {
      name: "Ice", tag: "Frosted cold blue",
      bg: "#0b1219", bgElevated: "#121c26", panel: "#0f1822",
      text: "#eef7ff", accent: "#9fdcff",
      stage: "linear-gradient(170deg, #1a2d3d 0%, #0a121a 80%)", radius: 14, font: SANS
    },
    crimson: {
      name: "Crimson", tag: "Black and blood red",
      bg: "#0c0507", bgElevated: "#16090c", panel: "#110709",
      text: "#fff0f1", accent: "#ff3b4e",
      stage: "radial-gradient(ellipse at 50% 20%, rgba(255,59,78,.26), transparent 60%), #080304", radius: 10, font: SANS
    },
    mono: {
      name: "Monochrome", tag: "Pure grey scale",
      bg: "#101010", bgElevated: "#181818", panel: "#141414",
      text: "#f0f0f0", accent: "#bdbdbd",
      stage: "linear-gradient(180deg, #222 0%, #0b0b0b 100%)", radius: 8, font: SANS
    },
    deepspace: {
      name: "Deep Space", tag: "Violet nebula",
      bg: "#06040f", bgElevated: "#0e0a1f", panel: "#0a0717",
      text: "#f0ebff", accent: "#a98bff",
      stage: "radial-gradient(ellipse at 70% 15%, rgba(169,139,255,.28), transparent 55%), radial-gradient(ellipse at 15% 85%, rgba(70,90,255,.22), transparent 55%), #04020b", radius: 16, font: SANS
    },
    retro: {
      name: "Retro", tag: "Amber CRT warmth",
      bg: "#14100a", bgElevated: "#1d170e", panel: "#18130b",
      text: "#ffe9c4", accent: "#ffb43a",
      stage: "radial-gradient(ellipse at 50% 30%, #3a2a10 0%, #0f0b05 75%)", radius: 4, font: MONO
    },
    glass: {
      name: "Glass", tag: "Translucent graphite",
      bg: "#101216", bgElevated: "#1a1d23", panel: "#15181d",
      text: "#f4f6fa", accent: "#d6e4ff",
      stage: "radial-gradient(ellipse at 30% 20%, rgba(214,228,255,.20), transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(120,140,190,.20), transparent 55%), #0b0d11", radius: 18, font: SANS
    },
    sunset: {
      name: "Sunset", tag: "Purple to orange glow",
      bg: "#140a17", bgElevated: "#1e1022", panel: "#190d1d",
      text: "#fff1ea", accent: "#ff9a5c",
      stage: "linear-gradient(160deg, #3b1249 0%, #a2325f 48%, #ff8f5a 100%)",
      radius: 18, font: ROUND
    },
    ocean: {
      name: "Ocean", tag: "Deep blue & teal",
      bg: "#06111c", bgElevated: "#0a1a2a", panel: "#081522",
      text: "#e8f4ff", accent: "#3ddbd9",
      stage: "linear-gradient(180deg, #06263f 0%, #04121f 100%), #04121f",
      radius: 16, font: SANS
    },
    forest: {
      name: "Forest", tag: "Calm dark green",
      bg: "#0a0f0c", bgElevated: "#101712", panel: "#0d1310",
      text: "#eef4f0", accent: "#6ddc9a",
      stage: "radial-gradient(ellipse at 50% 100%, #123524 0%, #070b09 70%)",
      radius: 14, font: SANS
    },
    ember: {
      name: "Ember", tag: "Warm coal & orange",
      bg: "#0d0b0a", bgElevated: "#151110", panel: "#120f0e",
      text: "#f4efec", accent: "#ff8a5c",
      stage: "radial-gradient(ellipse at 50% 110%, #52210f 0%, #0a0706 65%)",
      radius: 12, font: SANS
    },
    sakura: {
      name: "Sakura", tag: "Soft plum & pink",
      bg: "#150d14", bgElevated: "#1e131d", panel: "#191019",
      text: "#ffeef6", accent: "#ff8fc0",
      stage: "radial-gradient(ellipse at 50% 20%, #4a1f41 0%, #140a13 75%)",
      radius: 22, font: ROUND
    },
    terminal: {
      name: "Terminal", tag: "Green monospace",
      bg: "#020a04", bgElevated: "#04120a", panel: "#030d06",
      text: "#b8ffcb", accent: "#39ff6a",
      stage: "repeating-linear-gradient(0deg, rgba(57,255,106,.05) 0 1px, transparent 1px 3px), #010603",
      radius: 2, font: MONO
    },
    frontline: {
      name: "Frontline Ops", tag: "Tactical combat HUD, steel & amber",
      bg: "#0c0e0d", bgElevated: "#151816", panel: "#101311",
      text: "#e9ece4", accent: "#ff9f1a",
      stage: "linear-gradient(135deg, rgba(255,159,26,.10) 0 2px, transparent 2px 22px), repeating-linear-gradient(90deg, rgba(255,255,255,.03) 0 1px, transparent 1px 46px), radial-gradient(ellipse at 50% 30%, #2a2f2a 0%, #080a09 75%)",
      radius: 2, font: "\"Bahnschrift\", \"Arial Narrow\", \"Roboto Condensed\", Impact, sans-serif"
    },
    ironfist: {
      name: "Iron Fist", tag: "Heavy armour: olive, rust & red",
      bg: "#0d0f09", bgElevated: "#171a0f", panel: "#11140b",
      text: "#eef0dc", accent: "#e8412c",
      stage: "radial-gradient(ellipse at 20% 100%, rgba(232,65,44,.28), transparent 55%), repeating-linear-gradient(45deg, rgba(120,140,60,.07) 0 12px, transparent 12px 24px), #0a0c07",
      radius: 3, font: "\"Bahnschrift\", \"Arial Narrow\", \"Roboto Condensed\", Impact, sans-serif"
    },
    glyphwire: {
      name: "Glyphwire", tag: "Black & white text-art, glitching glyphs",
      bg: "#000000", bgElevated: "#0a0a0a", panel: "#050505",
      text: "#f2f2f2", accent: "#ffffff",
      stage: "#000000", radius: 0, font: MONO, glyph: true
    },
    vaporgrid: {
      name: "Vaporgrid", tag: "Retro-future sun over a neon grid",
      bg: "#12062a", bgElevated: "#1b0b3b", panel: "#150831",
      text: "#ffe9ff", accent: "#ff4fd8",
      stage: "linear-gradient(180deg, transparent 58%, rgba(255,79,216,.35) 100%), repeating-linear-gradient(0deg, rgba(0,229,255,.35) 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, rgba(0,229,255,.22) 0 1px, transparent 1px 38px), radial-gradient(circle at 50% 46%, #ffb347 0 14%, #ff4fd8 15% 22%, transparent 23%), linear-gradient(180deg, #1c0745 0%, #12062a 60%)",
      radius: 10, font: ROUND
    },
    blueprint: {
      name: "Blueprint", tag: "Drafting table: white lines on blue",
      bg: "#0b2a52", bgElevated: "#0f3563", panel: "#0c2d58",
      text: "#eaf4ff", accent: "#ffffff",
      stage: "repeating-linear-gradient(0deg, rgba(255,255,255,.14) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(255,255,255,.14) 0 1px, transparent 1px 24px), #0b2a52",
      radius: 0, font: MONO
    },
    midas: {
      name: "Midas", tag: "Black marble & gold",
      bg: "#0a0805", bgElevated: "#14100a", panel: "#0f0c07",
      text: "#fff4d6", accent: "#f2c14e",
      stage: "radial-gradient(ellipse at 50% 0%, rgba(242,193,78,.30), transparent 60%), linear-gradient(160deg, #1a1409 0%, #070503 70%)",
      radius: 8, font: SERIF
    },
    toxic: {
      name: "Toxic Lab", tag: "Hazard yellow on carbon",
      bg: "#0a0a08", bgElevated: "#141410", panel: "#0e0e0b",
      text: "#f7f5d0", accent: "#e9ff1f",
      stage: "repeating-linear-gradient(-45deg, rgba(233,255,31,.10) 0 14px, transparent 14px 28px), radial-gradient(ellipse at 50% 100%, rgba(233,255,31,.22), transparent 60%), #070706",
      radius: 3, font: "\"Bahnschrift\", \"Arial Narrow\", \"Roboto Condensed\", Impact, sans-serif"
    },
    luna: {
      name: "Luna Bay", tag: "Retro blue desktop",
      bg: "#ece9d8", bgElevated: "#f6f4ea", panel: "#e4e0cc",
      text: "#111111", accent: "#245edb", light: true,
      stage: "linear-gradient(180deg, #5a7edc 0%, #3a6ea5 40%, #1f4b8f 100%)", radius: 6, font: "Tahoma, Verdana, \"Segoe UI\", sans-serif"
    },
    studio: {
      name: "Studio", tag: "Docked player, amber keys",
      bg: "#17181b", bgElevated: "#202226", panel: "#1b1c20",
      text: "#eceef2", accent: "#ff8a1f",
      stage: "radial-gradient(ellipse at 50% 30%, #25272c 0%, #0c0d0f 75%)", radius: 6, font: SANS
    },
    lava: {
      name: "Lava Lamp", tag: "Molten red, orange & magenta blobs",
      bg: "#120404", bgElevated: "#1c0707", panel: "#160505",
      text: "#fff0e8", accent: "#ff6a2b",
      stage: "radial-gradient(circle at 25% 80%, rgba(255,60,20,.55), transparent 45%), radial-gradient(circle at 80% 25%, rgba(255,0,128,.35), transparent 45%), radial-gradient(circle at 55% 55%, rgba(255,170,0,.25), transparent 40%), #0d0303",
      radius: 20, font: ROUND
    },
    velvet: {
      name: "Royal Velvet", tag: "Deep purple with gold trim",
      bg: "#10051a", bgElevated: "#1a0a29", panel: "#14071f",
      text: "#fbf1ff", accent: "#e6b84d",
      stage: "radial-gradient(ellipse at 50% 0%, rgba(230,184,77,.22), transparent 55%), linear-gradient(170deg, #2a0f45 0%, #0b0314 75%)",
      radius: 12, font: SERIF
    },
    dune: {
      name: "Desert Dune", tag: "Warm sand and copper at dusk",
      bg: "#1a120b", bgElevated: "#241a10", panel: "#1e150d",
      text: "#fbeedc", accent: "#e0914a",
      stage: "linear-gradient(180deg, #4a2f18 0%, #2a1a0d 45%, #120b06 100%)",
      radius: 10, font: SERIF
    },
    holo: {
      name: "Hologram", tag: "Iridescent glass on midnight",
      bg: "#080b14", bgElevated: "#10162a", panel: "#0c1120",
      text: "#f0f6ff", accent: "#8ef0ff",
      stage: "conic-gradient(from 210deg at 70% 30%, rgba(142,240,255,.25), rgba(200,140,255,.25), rgba(255,160,220,.22), rgba(150,255,200,.22), rgba(142,240,255,.25)), #060912",
      radius: 16, font: SANS
    },
    rosegold: {
      name: "Rose Gold", tag: "Blush metal on charcoal",
      bg: "#161011", bgElevated: "#1f1718", panel: "#1a1213",
      text: "#fff1ee", accent: "#eba596",
      stage: "radial-gradient(ellipse at 50% 20%, rgba(235,165,150,.28), transparent 60%), linear-gradient(160deg, #2a1c1e, #0e0809)",
      radius: 16, font: SERIF
    },
    comicpop: {
      name: "Comic Pop", tag: "Bold yellow with halftone dots",
      bg: "#14122b", bgElevated: "#1d1a40", panel: "#17153a",
      text: "#fffbe6", accent: "#ffd400",
      stage: "radial-gradient(circle, rgba(255,212,0,.16) 2px, transparent 2.6px) 0 0 / 16px 16px, linear-gradient(160deg, #2b1f6b, #120f2e)",
      radius: 6, font: "\"Comic Sans MS\", \"Trebuchet MS\", Arial, sans-serif"
    },
    tokyo: {
      name: "Tokyo Rain", tag: "Wet neon street at night",
      bg: "#070a14", bgElevated: "#0e1324", panel: "#0a0e1d",
      text: "#eef2ff", accent: "#ff4d6d",
      stage: "repeating-linear-gradient(100deg, rgba(120,170,255,.07) 0 1px, transparent 1px 9px), radial-gradient(ellipse at 20% 85%, rgba(255,77,109,.38), transparent 55%), radial-gradient(ellipse at 85% 20%, rgba(70,130,255,.32), transparent 55%), #05070f",
      radius: 8, font: SANS
    },
    matcha: {
      name: "Matcha Latte", tag: "Soft green and cream (light)",
      bg: "#eef2e4", bgElevated: "#fbfdf4", panel: "#e4ead6",
      text: "#1d2a17", accent: "#3f7d3a", light: true,
      stage: "radial-gradient(ellipse at 50% 30%, #fbfdf4 0%, #d3dcc0 85%)",
      radius: 18, font: ROUND
    },
    arctic: {
      name: "Arctic Day", tag: "Crisp white and ice blue (light)",
      bg: "#eaf2fa", bgElevated: "#ffffff", panel: "#dfeaf6",
      text: "#0f1e33", accent: "#1d6fd1", light: true,
      stage: "linear-gradient(180deg, #ffffff 0%, #cfe2f5 100%)",
      radius: 12, font: SANS
    },
    paperlight: {
      name: "Paper", tag: "Light & clean",
      bg: "#f4f4f2", bgElevated: "#ffffff", panel: "#ececea",
      text: "#141414", accent: "#141414", light: true,
      stage: "radial-gradient(ellipse at 50% 30%, #ffffff 0%, #e4e4e0 80%)",
      radius: 14, font: SERIF
    }
  };
  // Control styles change the SHAPE and layout of the control bar, buttons, seek and volume sliders (see style.css [data-ctl]).
  var CONTROL_STYLES = {
    classic: { name: "Modern Classic", tag: "Round buttons, thin sliders" },
    glass:   { name: "Glass",   tag: "Frosted floating capsule" },
    cyber:   { name: "Cyberpunk", tag: "Angular, segmented sliders" },
    minimal: { name: "Minimalist", tag: "Line icons, hairline sliders" },
    analog:  { name: "Classic Analog", tag: "Chunky knob buttons, tape sliders" },
    xp:      { name: "Retro Desktop", tag: "Docked one-row bar, title-bar chrome" },
    tactical:{ name: "Tactical", tag: "Chamfered armour keys, hazard stripe, crosshair seek" },
    glyph:   { name: "Glyph", tag: "Bracket buttons, text-mode sliders" },
    grid:    { name: "Neon Grid", tag: "Glowing rounded keys, laser-line sliders" },
    dock:    { name: "Modern Dock", tag: "Docked one-row bar, flat square keys" },
    soft:    { name: "Soft Touch", tag: "Pillowy pressed-out keys, no outlines" },
    ring:    { name: "Neon Ring", tag: "Glowing outline rings, hairline laser sliders" },
    hifi:    { name: "Hi-Fi Receiver", tag: "Brushed faceplate, steel knobs, amber display" },
    bubble:  { name: "Bubble Pop", tag: "Big bright bubbles, fat rounded sliders" }
  };
  // Each theme picks a control style by default; the person can override it in Themes.
  var CTL_BY_PRESET = { ghost: "classic", obsidian: "minimal", neon: "cyber", midnight: "glass", cyber: "cyber", aurora: "glass",
    ice: "glass", crimson: "classic", mono: "minimal", deepspace: "glass", retro: "analog", terminal: "cyber", paperlight: "minimal", luna: "xp", studio: "dock",
    frontline: "tactical", ironfist: "tactical", toxic: "tactical", glyphwire: "glyph", blueprint: "glyph", vaporgrid: "grid", midas: "classic",
    lava: "bubble", velvet: "hifi", dune: "analog", holo: "ring", rosegold: "soft", comicpop: "bubble", tokyo: "ring", matcha: "soft", arctic: "soft" };
  var DEFAULT_PREFS = { preset: "ghost", customAccent: null, customBg: null, ctl: "auto" };

  function hexToRgb(hex) {
    var h = String(hex || "#000000").replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    var num = parseInt(h.slice(0, 6), 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function toHex(c) {
    function p(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); }
    return "#" + p(c.r) + p(c.g) + p(c.b);
  }
  // mix(a, b, t): t=0 -> a, t=1 -> b
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
  }
  function relativeLuminance(hex) {
    var rgb = hexToRgb(hex);
    var a = [rgb.r, rgb.g, rgb.b].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrastColor(hex) { return relativeLuminance(hex) > 0.5 ? "#0a0a0c" : "#ffffff"; }
  function rgba(hex, alpha) {
    var c = hexToRgb(hex);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var p = Object.assign({}, DEFAULT_PREFS, raw ? JSON.parse(raw) : {});
      if (!PRESETS[p.preset]) p.preset = "ghost";
      if (p.ctl !== "auto" && !CONTROL_STYLES[p.ctl]) p.ctl = "auto";   // e.g. a preset removed in an update
      return p;
    } catch (e) { return Object.assign({}, DEFAULT_PREFS); }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) { /* storage unavailable */ }
  }

  function GhostThemesCtl(prefs) {
    return prefs.ctl && prefs.ctl !== "auto" && CONTROL_STYLES[prefs.ctl] ? prefs.ctl : (CTL_BY_PRESET[prefs.preset] || "classic");
  }
  function apply(prefs) {
    var preset = PRESETS[prefs.preset] || PRESETS.ghost;
    var root = document.documentElement;
    var set = function (k, v) { root.style.setProperty(k, v); };
    var accent = prefs.customAccent || preset.accent;
    var customBg = prefs.customBg;
    var isLight = !!preset.light;
    if (customBg) isLight = relativeLuminance(customBg) > 0.5;   // custom color decides light/dark text
    var text = customBg ? (isLight ? "#141414" : "#f3f3f5") : preset.text;

    // Custom background color recolors EVERYTHING (sidebar + main stage), not just the body.
    var bg = customBg || preset.bg;
    var lift = isLight ? "#ffffff" : "#ffffff", sink = "#000000";
    var bgElevated = customBg ? (isLight ? mix(bg, lift, 0.55) : mix(bg, lift, 0.05)) : preset.bgElevated;
    var panel = customBg ? (isLight ? mix(bg, sink, 0.04) : mix(bg, sink, 0.25)) : preset.panel;
    var stage = customBg
      ? "radial-gradient(ellipse at 50% 30%, " + (isLight ? mix(bg, "#ffffff", 0.5) : mix(bg, "#ffffff", 0.08)) + " 0%, " + bg + " 75%)"
      : preset.stage;

    set("--bg", bg);
    set("--bg-elevated", bgElevated);
    set("--panel", panel);
    set("--stage-bg", stage);
    set("--text", text);
    set("--accent", accent);
    set("--accent-contrast", contrastColor(accent));
    set("--accent-soft", rgba(accent, 0.16));
    set("--glow", rgba(accent, 0.35));
    set("--radius-sm", Math.max(2, Math.round(preset.radius * 0.6)) + "px");
    set("--radius-md", preset.radius + "px");
    set("--radius-lg", Math.round(preset.radius * 1.4) + "px");
    set("--font", preset.font);

    if (isLight) {
      set("--text-dim", "#4a4a4a");
      set("--text-faint", "#8a8a8a");
      set("--border", "rgba(0,0,0,0.12)");
      set("--border-soft", "rgba(0,0,0,0.08)");
      set("--panel-glass", "rgba(0,0,0,0.045)");
      set("--hover", "rgba(0,0,0,0.08)");
      set("--fade", "linear-gradient(180deg, transparent, rgba(255,255,255,0.78) 45%, rgba(255,255,255,0.92))");
      set("--on-visual", "#ffffff");
      set("color-scheme", "light");
    } else {
      set("--text-dim", "#a0a0a8");
      set("--text-faint", "#64646c");
      set("--border", "rgba(255,255,255,0.09)");
      set("--border-soft", "rgba(255,255,255,0.06)");
      set("--panel-glass", "rgba(255,255,255,0.045)");
      set("--hover", "rgba(255,255,255,0.10)");
      set("--fade", "linear-gradient(180deg, transparent, rgba(0,0,0,0.72) 45%, rgba(0,0,0,0.86))");
      set("--on-visual", "#ffffff");
      set("color-scheme", "dark");
    }
    document.body.setAttribute("data-theme", prefs.preset);
    document.body.setAttribute("data-ctl", GhostThemesCtl(prefs));
    // Every theme has its own play-button SHAPE (css/advanced.css). It applies while the control style is "Match theme";
    // choosing a control style by hand keeps that style's buttons instead.
    if (!prefs.ctl || prefs.ctl === "auto") document.body.setAttribute("data-ps", prefs.preset); else document.body.removeAttribute("data-ps");
    document.body.classList.toggle("is-light", isLight);
    document.body.classList.toggle("has-glyph", !!preset.glyph);
    if (global.GhostGlyph) global.GhostGlyph.sync(!!preset.glyph);
  }

  var GhostThemes = {
    PRESETS: PRESETS,
    CONTROL_STYLES: CONTROL_STYLES,
    controlStyle: function () { return GhostThemesCtl(this.current); },
    setControlStyle: function (key) {
      if (key !== "auto" && !CONTROL_STYLES[key]) return;
      this.current.ctl = key; apply(this.current); savePrefs(this.current);
    },
    current: loadPrefs(),
    init: function () { apply(this.current); },
    // Picking a theme keeps a custom accent / background only if the person set one after.
    setPreset: function (key) {
      if (!PRESETS[key]) return;
      this.current.preset = key;
      this.current.customAccent = null;
      this.current.customBg = null;
      this.current.ctl = "auto";
      apply(this.current); savePrefs(this.current);
    },
    setAccent: function (hex) { this.current.customAccent = hex; apply(this.current); savePrefs(this.current); },
    setBackground: function (hex) { this.current.customBg = hex; apply(this.current); savePrefs(this.current); },
    clearCustom: function () {
      this.current.customAccent = null; this.current.customBg = null;
      apply(this.current); savePrefs(this.current);
    },
    reset: function () {
      this.current = Object.assign({}, DEFAULT_PREFS);
      apply(this.current); savePrefs(this.current);
    }
  };

  global.GhostThemes = GhostThemes;
})(window);
