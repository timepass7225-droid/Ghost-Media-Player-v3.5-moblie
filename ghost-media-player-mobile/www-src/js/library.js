/* Ghost Media Player — library & recents
 * Playlist entries hold live object URLs (session-only).
 * Recent entries persist only metadata (name/size/type/date) to localStorage,
 * since File/Blob objects cannot survive a page reload.
 */
(function (global) {
  "use strict";

  var RECENTS_KEY = "ghost.recents.v1";
  var SETTINGS_KEY = "ghost.settings.v1";
  var MAX_RECENTS = 25;

  function kindFromType(mime, name) {
    var ext = (name.split(".").pop() || "").toLowerCase();
    if (mime.indexOf("video") === 0) return "video";
    if (mime.indexOf("audio") === 0) return "audio";
    if (mime.indexOf("image") === 0) return "image";
    var videoExt = ["mkv", "webm", "mp4", "mov", "avi", "ogv", "m4v", "3gp"];
    var audioExt = ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "weba"];
    var imageExt = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];
    if (videoExt.indexOf(ext) !== -1) return "video";
    if (audioExt.indexOf(ext) !== -1) return "audio";
    if (imageExt.indexOf(ext) !== -1) return "image";
    return "unknown";
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  var GhostLibrary = {
    items: [],        // {id, file, url, name, size, kind, ext}
    recents: loadJSON(RECENTS_KEY, []),
    settings: loadJSON(SETTINGS_KEY, {
      defaultVolume: 80,
      autoplayNext: true,
      rememberPosition: true,
      loopMode: "off",     // off | one | all
      confirmClear: true
    }),

    addFiles: function (fileList) {
      var added = [];
      for (var i = 0; i < fileList.length; i++) {
        var file = fileList[i];
        var kind = kindFromType(file.type || "", file.name || "file");
        if (kind === "unknown") continue;
        var id = "m_" + Date.now() + "_" + i + "_" + Math.random().toString(36).slice(2, 7);
        var url = URL.createObjectURL(file);
        var entry = {
          id: id, file: file, url: url, name: file.name,
          size: file.size, kind: kind,
          sizeLabel: formatBytes(file.size)
        };
        this.items.push(entry);
        added.push(entry);
        this._pushRecent(entry);
      }
      saveJSON(RECENTS_KEY, this.recents);
      return added;
    },

    /* Items that are not local File objects: network streams and files inside a disc image. */
    addRemote: function (list) {
      var added = [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        var kind = r.kind || kindFromType("", r.name || "stream");
        if (kind === "unknown") continue;
        var entry = { id: "m_" + Date.now() + "_r" + i + "_" + Math.random().toString(36).slice(2, 7), file: null, url: r.url, name: r.name,
          size: r.size || 0, kind: kind, sizeLabel: r.sizeLabel || (r.size ? formatBytes(r.size) : "stream"), remote: true };
        this.items.push(entry); added.push(entry);
      }
      return added;
    },

    removeItem: function (id) {
      var idx = this.items.findIndex(function (m) { return m.id === id; });
      if (idx !== -1) {
        try { URL.revokeObjectURL(this.items[idx].url); } catch (e) { /* ignore */ }
        this.items.splice(idx, 1);
      }
    },

    clearLibrary: function () {
      this.items.forEach(function (m) { try { URL.revokeObjectURL(m.url); } catch (e) {} });
      this.items = [];
    },

    _pushRecent: function (entry) {
      this.recents = this.recents.filter(function (r) { return r.name !== entry.name || r.size !== entry.size; });
      this.recents.unshift({
        name: entry.name, size: entry.size, kind: entry.kind,
        sizeLabel: entry.sizeLabel, openedAt: Date.now()
      });
      if (this.recents.length > MAX_RECENTS) this.recents.length = MAX_RECENTS;
    },

    clearRecents: function () {
      this.recents = [];
      saveJSON(RECENTS_KEY, this.recents);
    },

    saveSettings: function () {
      saveJSON(SETTINGS_KEY, this.settings);
    },

    formatBytes: formatBytes
  };

  global.GhostLibrary = GhostLibrary;
})(window);
