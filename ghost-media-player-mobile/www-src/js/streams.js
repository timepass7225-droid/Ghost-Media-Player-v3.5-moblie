/* Ghost Media Player — Open folder, network stream and disc image (ISO)
 *
 *  Folder   : every playable file inside a chosen folder is added (works in browser and desktop).
 *  Network  : paste a direct http(s) link to a video / audio file or an internet radio stream.
 *  Disc ISO : desktop app only. The .iso is read directly (ISO 9660 / Joliet); playable media inside
 *             it is listed and streamed out of the image without extracting anything.
 *
 * Live TV: IPTV .m3u playlists are listed as channels and played by the built-in HLS engine (js/ghosthls.js).
 * Honest limits: the engine plays what Chromium can decode (H.264/AAC, MP4, WebM, MP3, FLAC, OGG, WAV...).
 * DVD-Video (VOB / MPEG-2), copy-protected discs, DRM channels, HEVC channels and audio-CD tracks cannot be decoded.
 */
(function (global) {
  "use strict";
  var MEDIA = /\.(mp4|m4v|webm|mkv|mov|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i;
  var VIDEO = /\.(mp4|m4v|webm|mkv|mov|ogv)$/i;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function core() { return global.GhostCore; }
  function toast(m) { if (core()) core().toast(m); }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

  function modal(html) {
    var wrap = document.createElement("div");
    wrap.className = "gs-modal";
    wrap.innerHTML = '<div class="gs-card" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(wrap);
    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); document.removeEventListener("keydown", onKey, true); }
    function onKey(e) { if (e.key === "Escape") { e.stopPropagation(); close(); } }
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("mousedown", function (e) { if (e.target === wrap) close(); });
    wrap.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", close); });
    return { el: wrap, close: close, q: function (s) { return wrap.querySelector(s); } };
  }

  /* ---------------------------------------------------------------- folder */
  function openFolder() {
    var inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true; inp.setAttribute("webkitdirectory", ""); inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener("change", function () {
      var files = Array.prototype.filter.call(inp.files || [], function (f) { return MEDIA.test(f.name) || /^(audio|video)\//.test(f.type); });
      files.sort(function (a, b) { return (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }); });
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (!files.length) { toast("No playable audio or video in that folder"); return; }
      var dt = document.getElementById("fileInput");
      // reuse the normal import path so lyrics files, recents etc. behave exactly as with "Open files"
      var list = new DataTransfer();
      files.forEach(function (f) { list.items.add(f); });
      dt.files = list.files;
      dt.dispatchEvent(new Event("change", { bubbles: true }));
      dt.value = "";
      toast(files.length + " file(s) from the folder added");
    });
    inp.click();
  }

  /* ---------------------------------------------------------------- network */
  function openStream() {
    var m = modal(
      '<h3>Open network stream</h3>' +
      '<p class="gs-note">Paste a direct link to a video or audio file, an internet-radio stream, an HLS live link (.m3u8) or a channel list (.m3u).</p>' +
      '<input class="gs-input" id="gsUrl" type="url" placeholder="https://example.com/video.mp4  or  http://radio.example:8000/stream" spellcheck="false" autocomplete="off">' +
      '<p class="gs-note gs-note--warn" id="gsMsg" hidden></p>' +
      '<p class="gs-note gs-note--warn">Works for direct media files and plain streams the engine can decode. Web pages (YouTube, etc.) and DRM-protected streams cannot be played.</p>' +
      '<div class="gs-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="gsPlay">Play</button></div>');
    var url = m.q("#gsUrl"); url.focus();
    var busy = false;
    function play(finalUrl, type, label) {
      var direct = finalUrl;
      var viaProxy = global.ghostStream ? global.ghostStream.proxyUrl(finalUrl) : finalUrl;
      var path = finalUrl.split("?")[0];
      var name = decodeURIComponent((path.split("/").filter(Boolean).pop() || label || finalUrl)).slice(0, 80);
      var kind = /^video\//.test(type) || VIDEO.test(path) ? "video" : "audio";
      core().addRemote([{ url: viaProxy, name: name || "Network stream", kind: kind, sizeLabel: "stream" }]);
    }
    function go() {
      if (busy) return;
      var v = url.value.trim();
      if (!/^https?:\/\/\S+$/i.test(v)) { toast("Enter a full http(s) link"); return; }
      if (/\.m3u8?(\?|$)/i.test(v) && !/\.m3u8(\?|$)/i.test(v)) { m.close(); openTv(v); return; }       // a .m3u list of channels
      if (/\.m3u8(\?|$)/i.test(v)) { m.close(); core().addRemote([{ url: "hls:" + v, name: decodeURIComponent((v.split("?")[0].split("/").filter(Boolean).slice(-2, -1)[0] || "Live stream")).slice(0, 60), kind: "video", sizeLabel: "live" }]); return; }
      if (!global.ghostStream) { m.close(); play(v, "", ""); return; }          // browser build: let the engine try directly
      busy = true; m.q("#gsPlay").textContent = "Checking\u2026"; m.q("#gsPlay").disabled = true;
      function fail(reason) { busy = false; m.q("#gsPlay").textContent = "Play"; m.q("#gsPlay").disabled = false; var n = m.q("#gsMsg"); n.textContent = reason; n.hidden = false; }
      global.ghostStream.probe(v).then(function (r) {
        if (!r.ok) return fail(r.reason || "This link can't be opened.");
        if (r.hls) { m.close(); core().addRemote([{ url: "hls:" + r.finalUrl, name: decodeURIComponent((r.finalUrl.split("?")[0].split("/").filter(Boolean).slice(-2, -1)[0] || "Live stream")).slice(0, 60), kind: "video", sizeLabel: "live" }]); return; }
        if (r.transcode) { m.close(); core().addRemote([{ url: "hls:" + r.finalUrl, name: decodeURIComponent((r.finalUrl.split("?")[0].split("/").filter(Boolean).pop() || "Live stream")).slice(0, 60), kind: "video", sizeLabel: "live" }]); return; }
        if (r.playlist && r.playlist.length > 1) { m.close(); openTv(v); return; }
        if (r.playlist) {
          return global.ghostStream.probe(r.playlist[0]).then(function (r2) {
            if (!r2.ok || r2.playlist) return fail(r2.reason || "The playlist's first entry can't be opened.");
            m.close(); play(r2.finalUrl, r2.type, ""); toast("Playlist: playing the first stream");
          });
        }
        m.close(); play(r.finalUrl, r.type, "");
      }, function () { fail("Couldn't check this link."); });
    }
    m.q("#gsPlay").addEventListener("click", go);
    url.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
  }


  /* ---------------------------------------------------------------- live TV (IPTV .m3u playlists) */
  var DEFAULT_TV = "https://iptv-org.github.io/iptv/index.m3u";
  var tvCache = { url: "", channels: [] };

  function parseM3U(text) {
    var out = [], lines = text.split(/\r?\n/), cur = null, opts = null, i, ln;
    for (i = 0; i < lines.length; i++) {
      ln = lines[i].trim();
      if (!ln) continue;
      if (ln.indexOf("#EXTINF:") === 0) {
        var comma = ln.indexOf(",", 8);
        var attrs = ln.slice(8, comma < 0 ? undefined : comma), name = comma < 0 ? "" : ln.slice(comma + 1).trim();
        var g = /group-title="([^"]*)"/.exec(attrs), l = /tvg-logo="([^"]*)"/.exec(attrs);
        cur = { name: name || "Channel", group: g && g[1] ? g[1].split(";")[0] : "Other", logo: l ? l[1] : "" };
        opts = {};
      } else if (ln.indexOf("#EXTVLCOPT:") === 0 && cur) {
        var kv = ln.slice(11), eq = kv.indexOf("=");
        if (eq > 0) { var k = kv.slice(0, eq).toLowerCase(), v = kv.slice(eq + 1); if (k === "http-referrer" || k === "http-referer") opts.ref = v; if (k === "http-user-agent") opts.ua = v; }
      } else if (ln[0] !== "#" && /^https?:\/\//i.test(ln) && cur) {
        cur.url = ln; cur.opts = opts; out.push(cur); cur = null;
      }
    }
    return out;
  }

  function channelItem(c) {
    var path = c.url.split("?")[0], isAudio = /\.(mp3|aac|ogg|oga|opus|m4a|flac)$/i.test(path);
    var direct = /\.(mp4|webm|mkv|mov|mp3|aac|ogg|oga|opus|m4a|flac|wav)$/i.test(path);
    var o = c.opts && (c.opts.ref || c.opts.ua) ? c.opts : null;
    var url = direct ? (global.ghostStream ? global.ghostStream.proxyUrl(c.url, o) : c.url)
                     : "hls:" + c.url + (o ? "#ghost=" + encodeURIComponent(JSON.stringify(o)) : "");
    return { url: url, name: c.name, kind: isAudio ? "audio" : "video", sizeLabel: "live" };
  }

  function loadText(url) {
    if (global.ghostStream && global.ghostStream.text) return global.ghostStream.text(url);
    return fetch(url).then(function (r) { return r.ok ? r.text().then(function (t) { return { ok: true, text: t }; }) : { ok: false, reason: "The server answered HTTP " + r.status + "." }; })
      .catch(function () { return { ok: false, reason: "Couldn't load this playlist here (the server blocks browsers). The desktop app can." }; });
  }

  function openTv(prefill) {
    var saved = ""; try { saved = localStorage.getItem("ghost.tv.url") || ""; } catch (e) { /* ignore */ }
    var m = modal(
      '<h3>Live TV channels</h3>' +
      '<p class="gs-note">Load an IPTV playlist (.m3u). Thousands of free channels, grouped by category. Many public channels are offline or only work in some countries.</p>' +
      '<div class="gs-urlrow"><input class="gs-input" id="gsTvUrl" type="url" spellcheck="false" autocomplete="off" placeholder="https://iptv-org.github.io/iptv/index.m3u"><button class="btn btn--primary" id="gsTvLoad">Load</button></div>' +
      '<p class="gs-note" id="gsTvStatus">Press Load to fetch the channel list.</p>' +
      '<div class="gs-tvbar" id="gsTvBar" hidden><input class="gs-input" id="gsTvSearch" type="search" placeholder="Search channels\u2026" spellcheck="false"><select class="gs-input gs-select" id="gsTvGroup"></select></div>' +
      '<div class="gs-list gs-list--tv" id="gsTvList" hidden></div>' +
      '<div class="gs-actions"><button class="btn btn--ghost" data-close>Close</button></div>');
    m.el.querySelector(".gs-card").classList.add("gs-card--wide");
    var urlEl = m.q("#gsTvUrl"), status = m.q("#gsTvStatus"), list = m.q("#gsTvList"), bar = m.q("#gsTvBar"), search = m.q("#gsTvSearch"), group = m.q("#gsTvGroup");
    urlEl.value = prefill || saved || DEFAULT_TV;
    var shown = 200, filtered = [];

    function render() {
      var q = search.value.trim().toLowerCase(), g = group.value;
      filtered = tvCache.channels.filter(function (c) { return (!g || c.group === g) && (!q || c.name.toLowerCase().indexOf(q) >= 0); });
      var html = filtered.slice(0, shown).map(function (c, i) {
        return '<button type="button" class="gs-ch" data-i="' + i + '">' +
          (c.logo ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">' : '<span class="gs-ch__ph"></span>') +
          '<span class="gs-ch__n">' + esc(c.name) + '</span><span class="gs-ch__g">' + esc(c.group) + '</span></button>';
      }).join("");
      if (filtered.length > shown) html += '<button type="button" class="gs-more" id="gsMore">Show more (' + (filtered.length - shown) + ' left)</button>';
      if (!filtered.length) html = '<p class="gs-note" style="padding:12px">No channels match.</p>';
      list.innerHTML = html;
      status.textContent = filtered.length + " of " + tvCache.channels.length + " channels";
    }
    function showList() {
      var groups = {}; tvCache.channels.forEach(function (c) { groups[c.group] = (groups[c.group] || 0) + 1; });
      group.innerHTML = '<option value="">All categories</option>' + Object.keys(groups).sort().map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + ' (' + groups[k] + ')</option>'; }).join("");
      bar.hidden = false; list.hidden = false; shown = 200; render();
    }
    function load() {
      var u = urlEl.value.trim();
      if (!/^https?:\/\/\S+$/i.test(u)) { status.textContent = "Enter a full http(s) link to a .m3u playlist."; return; }
      status.textContent = "Loading the channel list\u2026 (big lists take a few seconds)";
      m.q("#gsTvLoad").disabled = true;
      loadText(u).then(function (r) {
        m.q("#gsTvLoad").disabled = false;
        if (!r || !r.ok) { status.textContent = (r && r.reason) || "Couldn't load the playlist."; return; }
        var ch = parseM3U(r.text);
        if (!ch.length) { status.textContent = "No channels found in this playlist."; return; }
        tvCache = { url: u, channels: ch };
        try { localStorage.setItem("ghost.tv.url", u); } catch (e) { /* ignore */ }
        showList();
      });
    }
    m.q("#gsTvLoad").addEventListener("click", load);
    urlEl.addEventListener("keydown", function (e) { if (e.key === "Enter") load(); });
    var t = 0;
    search.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { shown = 200; render(); }, 140); });
    group.addEventListener("change", function () { shown = 200; render(); });
    list.addEventListener("click", function (e) {
      if (e.target.id === "gsMore") { shown += 300; render(); return; }
      var b = e.target.closest(".gs-ch"); if (!b) return;
      var c = filtered[+b.getAttribute("data-i")]; if (!c) return;
      m.close();
      core().addRemote([channelItem(c)]);
      toast("Tuning: " + c.name);
    });
    if (tvCache.channels.length && tvCache.url === urlEl.value.trim()) showList(); else if (prefill) load();
  }

  /* ---------------------------------------------------------------- ISO */
  function openIso() {
    if (!global.ghostDisc) { toast("Disc images need the desktop app"); return; }
    global.ghostDisc.openIso().then(function (r) {
      if (!r || r.canceled) return;
      if (r.error) { toast(r.error); return; }
      var media = r.files.filter(function (f) { return MEDIA.test(f.name); });
      var vob = r.files.filter(function (f) { return /\.vob$/i.test(f.name); }).length;
      var rows = media.map(function (f) {
        return '<label class="gs-row"><input type="checkbox" checked data-i="' + f.i + '"><span class="gs-row__n">' + esc(f.path) + '</span><span class="gs-row__s">' + fmtSize(f.size) + '</span></label>';
      }).join("");
      var note = media.length ? "" : '<p class="gs-note gs-note--warn">No audio or video this engine can decode was found in this image.</p>';
      if (vob) note += '<p class="gs-note gs-note--warn">This image holds a DVD-Video structure (' + vob + ' VOB files). DVD video uses MPEG-2 and menus, which this engine cannot decode or show.</p>';
      var m = modal(
        '<h3>Disc image: ' + esc(r.label || "ISO") + '</h3>' +
        '<p class="gs-note">' + media.length + ' playable file(s) found' + (r.joliet ? " (long filenames)" : "") + '. Pick what to add to the playlist.</p>' + note +
        '<div class="gs-list">' + rows + '</div>' +
        '<div class="gs-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--primary" id="gsAdd"' + (media.length ? "" : " disabled") + '>Add &amp; play</button></div>');
      var addBtn = m.q("#gsAdd");
      if (addBtn) addBtn.addEventListener("click", function () {
        var picked = Array.prototype.map.call(m.el.querySelectorAll("input[data-i]:checked"), function (c) { return +c.getAttribute("data-i"); });
        var list = media.filter(function (f) { return picked.indexOf(f.i) >= 0; }).map(function (f) {
          return { url: global.ghostDisc.urlFor(r.sid, f.i), name: f.name, size: f.size, kind: VIDEO.test(f.name) ? "video" : "audio" };
        });
        m.close();
        if (list.length) core().addRemote(list);
      });
    });
  }

  /* ---------------------------------------------------------------- buttons */
  function init() {
    var host = document.querySelector(".sidebar__section");
    if (!host || host.querySelector("[data-gs]")) return;
    var row = document.createElement("div");
    row.className = "gs-btns";
    row.innerHTML =
      '<button type="button" class="btn btn--ghost" data-gs="folder" title="Add every song / video in a folder">Folder</button>' +
      '<button type="button" class="btn btn--ghost" data-gs="stream" title="Play a link or internet stream">Stream</button>' +
      '<button type="button" class="btn btn--ghost" data-gs="tv" title="Live TV channels from an IPTV playlist">TV</button>' +
      (global.ghostDisc ? '<button type="button" class="btn btn--ghost" data-gs="iso" title="Play media inside a disc image (.iso)">Disc ISO</button>' : "");
    host.appendChild(row);
    row.addEventListener("click", function (e) {
      var b = e.target.closest("[data-gs]"); if (!b) return;
      var k = b.getAttribute("data-gs");
      if (k === "folder") openFolder(); else if (k === "stream") openStream(); else if (k === "tv") openTv(); else openIso();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  global.GhostStreams = { openFolder: openFolder, openStream: openStream, openIso: openIso, openTv: openTv, parseM3U: parseM3U };
})(window);
