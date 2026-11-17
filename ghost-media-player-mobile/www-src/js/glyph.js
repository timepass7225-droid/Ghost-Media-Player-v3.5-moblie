/* Ghost Media Player — Glyphwire text-art stage
 * The background is a live field of text characters. The ghost silhouette is "drawn" by brighter,
 * denser characters; everything around it is faint, flickering code. Every few seconds a band
 * of the picture glitches sideways. Canvas 2D only, ~12 fps, stops when the theme is off or the
 * window is hidden.
 */
(function (global) {
  "use strict";
  var GHOST = "M32 6C20.4 6 11 15.6 11 27.5v27.7c0 1.8 2 2.8 3.4 1.6l5-4.4 5.2 4.5c1 .9 2.5.9 3.5 0l4.6-4 4.6 4c1 .9 2.5.9 3.5 0l5.2-4.5 5 4.4c1.4 1.2 3.4.2 3.4-1.6V27.5C53 15.6 43.6 6 32 6z";
  var DENSE = "@#%&8WM$B0QO";
  var FAINT = "01.:+-/\\|<>[]{}=_~^*";
  var CW = 9, CH = 15;
  var canvas = null, ctx = null, raf = 0, last = 0, cols = 0, rows = 0, mask = null, grid = null, glitch = null, running = false, host = null, ro = null;

  function rnd(n) { return (Math.random() * n) | 0; }

  function buildMask() {
    var off = document.createElement("canvas"); off.width = cols; off.height = rows;
    var o = off.getContext("2d");
    o.fillStyle = "#000"; o.fillRect(0, 0, cols, rows);
    var h = rows * 0.74, sc = h / 52;                        // ghost is ~52 units tall inside its 64 box
    // cells are taller than wide: stretch x so the ghost keeps its proportions
    var aspect = CH / CW;
    o.save();
    o.translate(cols * 0.5 - 32 * sc * aspect, rows * 0.5 - 31 * sc);
    o.scale(sc * aspect, sc);
    o.fillStyle = "#fff"; o.fill(new Path2D(GHOST));
    o.globalCompositeOperation = "destination-out";
    o.beginPath(); o.arc(24, 26, 3.4, 0, 6.3); o.arc(40, 26, 3.4, 0, 6.3); o.fill();
    o.restore();
    var d = o.getImageData(0, 0, cols, rows).data;
    mask = new Uint8Array(cols * rows);
    for (var i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
  }

  function resize() {
    if (!canvas || !host) return;
    var w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CW); rows = Math.ceil(h / CH);
    buildMask();
    grid = new Array(cols * rows);
    for (var i = 0; i < grid.length; i++) grid[i] = mask[i] ? DENSE.charAt(rnd(DENSE.length)) : FAINT.charAt(rnd(FAINT.length));
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 80) return;
    last = t;
    if (!grid) return;
    var w = cols * CW, h = rows * CH, i, x, y;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "13px Consolas, 'Courier New', monospace";
    ctx.textBaseline = "top";
    // mutate a share of the cells each frame
    var n = (grid.length * 0.05) | 0;
    for (i = 0; i < n; i++) {
      var k = rnd(grid.length);
      grid[k] = mask[k] ? DENSE.charAt(rnd(DENSE.length)) : FAINT.charAt(rnd(FAINT.length));
    }
    var pulse = 0.82 + 0.18 * Math.sin(t / 420);
    for (y = 0; y < rows; y++) {
      for (x = 0; x < cols; x++) {
        var idx = y * cols + x;
        if (mask[idx]) {
          ctx.fillStyle = "rgba(255,255,255," + (pulse * (0.75 + Math.random() * 0.25)).toFixed(2) + ")";
        } else {
          ctx.fillStyle = "rgba(255,255,255," + (0.07 + (Math.random() < 0.02 ? 0.35 : 0)).toFixed(2) + ")";
        }
        ctx.fillText(grid[idx], x * CW, y * CH);
      }
    }
    // glitch band: shift a horizontal strip sideways for a moment
    if (!glitch && Math.random() < 0.035) glitch = { y: rnd(Math.max(1, h - 80)), h: 14 + rnd(60), dx: (rnd(40) - 20) || 12, until: t + 140 + rnd(200) };
    if (glitch) {
      if (t > glitch.until) glitch = null;
      else {
        var dpr = canvas.width / w;
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(canvas, 0, glitch.y * dpr, canvas.width, glitch.h * dpr, glitch.dx * dpr, glitch.y * dpr, canvas.width, glitch.h * dpr);
        ctx.restore();
      }
    }
  }

  function start() {
    if (running) return;
    host = document.getElementById("stage");
    if (!host) return;
    canvas = document.createElement("canvas");
    canvas.className = "glyph-canvas"; canvas.setAttribute("aria-hidden", "true");
    host.insertBefore(canvas, host.firstChild);
    ctx = canvas.getContext("2d");
    running = true;
    resize();
    if (global.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(host); } else global.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf); raf = 0;
    if (ro) { ro.disconnect(); ro = null; } else global.removeEventListener("resize", resize);
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = ctx = grid = mask = glitch = null;
  }
  document.addEventListener("visibilitychange", function () {
    if (!running) return;
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) raf = requestAnimationFrame(frame);
  });

  global.GhostGlyph = { sync: function (on) { if (on) start(); else stop(); } };
  // the theme may have been applied before this script loaded
  if (document.body && document.body.classList.contains("has-glyph")) start();
})(window);
