/* Ghost Media Player MOBILE edition — runs first, before any other script.
 * First launch only: switches the heavy desktop extras off so a phone stays smooth. The user can still turn anything
 * back on in Settings afterwards; their choice is never overwritten again. */
(function () {
  "use strict";
  var doc = document.documentElement;
  doc.classList.add("is-mobile");
  if (window.Capacitor && (window.Capacitor.isNativePlatform ? window.Capacitor.isNativePlatform() : true)) doc.classList.add("is-native");
  try {
    if (!localStorage.getItem("ghost.mobile.init.v1")) {
      localStorage.setItem("ghost.look3d.v1", "0");      // 3D look off (costs GPU on weak phones)
      localStorage.setItem("ghost.nav.mode", "simple");  // the bottom tab bar replaces the desktop orb menu
      localStorage.setItem("ghost.ui.v1", "normal");     // classic layout, tuned for phones
      localStorage.setItem("ghost.mobile.init.v1", "1");
    }
  } catch (e) { /* storage unavailable: defaults still apply */ }
})();
