/* Builds www/ (what the phone app ships) from www-src/ (readable source): minifies every JS and CSS file with esbuild.
 * Top-level scripts are NOT bundled or renamed at global scope, so every window.* / shared global keeps working. */
"use strict";
const fs = require("fs"), path = require("path");
let esbuild; try { esbuild = require("esbuild"); } catch (e) { console.error("Run `npm install` first (esbuild is missing)."); process.exit(1); }
const SRC = path.join(__dirname, "..", "www-src"), OUT = path.join(__dirname, "..", "www");
fs.rmSync(OUT, { recursive: true, force: true });
let before = 0, after = 0;
(function walk(dir, rel) {
  fs.mkdirSync(path.join(OUT, rel), { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const from = path.join(dir, name), to = path.join(OUT, rel, name), st = fs.statSync(from);
    if (st.isDirectory()) { walk(from, path.join(rel, name)); continue; }
    const ext = path.extname(name).toLowerCase(), raw = fs.readFileSync(from);
    let out = raw;
    if (ext === ".js") out = Buffer.from(esbuild.transformSync(raw.toString("utf8"), { loader: "js", minify: true, target: "es2019", legalComments: "none" }).code);
    else if (ext === ".css") out = Buffer.from(esbuild.transformSync(raw.toString("utf8"), { loader: "css", minify: true, legalComments: "none" }).code);
    else if (ext === ".html") out = Buffer.from(raw.toString("utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\n\s*\n/g, "\n"));
    if (ext === ".js" || ext === ".css" || ext === ".html") { before += raw.length; after += out.length; }
    fs.writeFileSync(to, out);
  }
})(SRC, "");
console.log("minified js/css/html: " + (before / 1024).toFixed(0) + " KB -> " + (after / 1024).toFixed(0) + " KB (" + Math.round(100 - after / before * 100) + "% smaller)");
