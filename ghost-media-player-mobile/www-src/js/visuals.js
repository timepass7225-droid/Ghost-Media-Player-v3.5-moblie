/* Ghost Media Player — Background Visuals
 *
 * User-supplied images, animated GIFs and videos shown behind audio playback.
 * The library starts EMPTY: nothing is bundled, downloaded or preselected.
 *
 * Storage backends (same interface):
 *  - Electron: the main process copies each file into <userData>/background-visuals
 *    and serves it through the local ghost-visual:// protocol.
 *  - Fallback (Capacitor / plain browser): the file is copied into IndexedDB as a
 *    Blob, and a temporary object URL is created only for the visual in use.
 * Either way the original file is not a dependency after import, and nothing is
 * uploaded anywhere.
 */
(function (global) {
  "use strict";

  var IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "avif", "svg"];
  var VIDEO_EXT = ["mp4", "webm", "ogv", "m4v", "mov", "mkv"];
  var DEFAULT_SETTINGS = { enabled: false, selectedId: null, opacity: 100 };

  function extOf(name) {
    var i = String(name || "").lastIndexOf(".");
    return i === -1 ? "" : name.slice(i + 1).toLowerCase();
  }
  function baseName(name) {
    var i = String(name || "").lastIndexOf(".");
    return (i > 0 ? name.slice(0, i) : name) || "Untitled";
  }

  /* ---------------------------------------------------------- Electron backend */
  function electronBackend(api) {
    return {
      kind: "electron",
      load: function () { return api.load(); },
      importFiles: function () {
        return api.importFiles().then(function (r) { return r; });
      },
      rename: function (id, name) { return api.rename(id, name); },
      remove: function (id) { return api.remove(id); },
      saveSettings: function (patch) { return api.saveSettings(patch); },
      acquire: function (item) {
        return Promise.resolve({ url: api.urlFor(item.id), release: function () {} });
      }
    };
  }

  /* ---------------------------------------------------------- IndexedDB backend */
  function idbBackend() {
    var DB = "ghost-background-visuals", STORE = "files", SETTINGS_KEY = "ghost.visuals.settings.v1";
    var dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: "id" }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbPromise;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, mode);
          var out = fn(t.objectStore(STORE));
          t.oncomplete = function () { resolve(out && "result" in out ? out.result : undefined); };
          t.onerror = t.onabort = function () { reject(t.error); };
        });
      });
    }
    function readSettings() {
      try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY))); }
      catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
    }
    function writeSettings(s) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    }
    function meta(rec) {
      return { id: rec.id, name: rec.name, type: rec.type, ext: rec.ext, size: rec.size, addedAt: rec.addedAt };
    }
    function typeOf(file) {
      var ext = extOf(file.name), mime = file.type || "";
      if (mime === "image/gif" || ext === "gif") return "gif";
      if (mime.indexOf("video/") === 0 || VIDEO_EXT.indexOf(ext) !== -1) return "video";
      if (mime.indexOf("image/") === 0 || IMAGE_EXT.indexOf(ext) !== -1) return "image";
      return null;
    }
    function pickFiles() {
      return new Promise(function (resolve) {
        var input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "image/*,video/*,.gif,.mkv";
        input.style.display = "none";
        input.addEventListener("change", function () {
          var files = Array.prototype.slice.call(input.files || []);
          input.remove();
          resolve(files);
        });
        input.addEventListener("cancel", function () { input.remove(); resolve([]); });
        document.body.appendChild(input);
        input.click();
      });
    }

    return {
      kind: "idb",
      load: function () {
        return tx("readonly", function (s) { return s.getAll(); }).then(function (rows) {
          rows = (rows || []).sort(function (a, b) { return a.addedAt - b.addedAt; });
          var settings = readSettings();
          if (settings.selectedId && !rows.some(function (r) { return r.id === settings.selectedId; })) {
            settings.selectedId = null;
            writeSettings(settings);
          }
          return { items: rows.map(meta), settings: settings };
        });
      },
      importFiles: function () {
        return pickFiles().then(function (files) {
          var created = [], skipped = [];
          var chain = Promise.resolve();
          if (!files.length) return { created: created, skipped: skipped, canceled: true };
          files.forEach(function (file, i) {
            var type = typeOf(file);
            if (!type) { skipped.push(file.name); return; }
            var rec = {
              id: "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + i,
              name: baseName(file.name), type: type, ext: extOf(file.name), size: file.size,
              addedAt: Date.now() + i, blob: file      // a File is a Blob; IndexedDB stores its bytes
            };
            chain = chain.then(function () {
              return tx("readwrite", function (s) { return s.put(rec); });
            }).then(function () { created.push(meta(rec)); }, function () { skipped.push(file.name); });
          });
          return chain.then(function () { return { created: created, skipped: skipped }; });
        });
      },
      rename: function (id, name) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(STORE, "readwrite"), s = t.objectStore(STORE);
            var g = s.get(id);
            g.onsuccess = function () {
              if (!g.result) { resolve(false); return; }
              g.result.name = name;
              s.put(g.result);
            };
            t.oncomplete = function () { resolve(true); };
            t.onerror = t.onabort = function () { reject(t.error); };
          });
        });
      },
      remove: function (id) {
        return tx("readwrite", function (s) { return s.delete(id); }).then(function () {
          var st = readSettings();
          if (st.selectedId === id) { st.selectedId = null; writeSettings(st); }
          return true;
        });
      },
      saveSettings: function (patch) {
        var s = readSettings();
        if (typeof patch.enabled === "boolean") s.enabled = patch.enabled;
        if ("selectedId" in patch) s.selectedId = patch.selectedId || null;
        if (isFinite(patch.opacity)) s.opacity = Math.max(0, Math.min(100, Math.round(patch.opacity)));
        writeSettings(s);
        return Promise.resolve(s);
      },
      acquire: function (item) {
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var g = db.transaction(STORE, "readonly").objectStore(STORE).get(item.id);
            g.onsuccess = function () {
              if (!g.result) { reject(new Error("missing")); return; }
              var url = URL.createObjectURL(g.result.blob);
              resolve({ url: url, release: function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } } });
            };
            g.onerror = function () { reject(g.error); };
          });
        });
      }
    };
  }

  /* ---------------------------------------------------------- shared helpers */

  // Build the single element used to show a visual. Video is ALWAYS muted, volume 0,
  // never routed through Web Audio, and is forced back to silent if anything tries
  // to change that.
  function buildElement(item, url) {
    var el;
    if (item.type === "video") {
      el = document.createElement("video");
      el.muted = true;
      el.defaultMuted = true;
      el.volume = 0;
      el.loop = true;
      el.autoplay = false;                // playback is driven explicitly by the controller
      el.playsInline = true;
      el.preload = "auto";
      el.disablePictureInPicture = true;
      el.disableRemotePlayback = true;
      el.setAttribute("muted", "");
      el.setAttribute("playsinline", "");
      el.addEventListener("volumechange", function () {
        if (!el.muted) el.muted = true;
        if (el.volume !== 0) el.volume = 0;
      });
    } else {
      el = document.createElement("img");   // native <img> keeps GIFs truly animated (and looping)
      el.alt = "";
      el.draggable = false;
      el.decoding = "async";
    }
    el.className = "visual-el";
    el.src = url;
    return el;
  }

  function releaseElement(el) {
    if (!el) return;
    try {
      if (el.tagName === "VIDEO") { el.pause(); el.removeAttribute("src"); el.load(); }
      else { el.removeAttribute("src"); }
    } catch (e) { /* ignore */ }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /* ---------------------------------------------------------- manager */
  var GhostVisuals = {
    items: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    backend: null,
    ready: false,
    onError: null,          // set by app.js to surface problems as toasts
    buildElement: buildElement,
    releaseElement: releaseElement,

    init: function () {
      var self = this;
      this.backend = global.ghostVisuals ? electronBackend(global.ghostVisuals) : idbBackend();
      return this.backend.load().then(function (snap) {
        self.items = snap.items || [];
        self.settings = Object.assign({}, DEFAULT_SETTINGS, snap.settings);
        self.ready = true;
      }, function () {
        self.items = [];
        self.settings = Object.assign({}, DEFAULT_SETTINGS);
        self.ready = true;
        if (self.onError) self.onError("Background Visual storage could not be opened");
      });
    },

    get: function (id) {
      for (var i = 0; i < this.items.length; i++) if (this.items[i].id === id) return this.items[i];
      return null;
    },
    selected: function () { return this.settings.selectedId ? this.get(this.settings.selectedId) : null; },

    // Opens the native picker, copies the files into persistent storage and returns
    // { created: [items], skipped: [names], canceled? }.
    add: function () {
      var self = this;
      return this.backend.importFiles().then(function (res) {
        (res.created || []).forEach(function (it) { self.items.push(it); });
        return res;
      });
    },

    rename: function (id, name) {
      var self = this, clean = String(name || "").trim().slice(0, 120);
      if (!clean) return Promise.resolve(false);
      return this.backend.rename(id, clean).then(function (ok) {
        var it = self.get(id);
        if (ok && it) it.name = clean;
        return ok;
      });
    },

    remove: function (id) {
      var self = this;
      return this.backend.remove(id).then(function () {
        self.items = self.items.filter(function (i) { return i.id !== id; });
        if (self.settings.selectedId === id) self.settings.selectedId = null;
      });
    },

    _save: function (patch) {
      var self = this;
      Object.assign(this.settings, patch);
      return this.backend.saveSettings(patch).then(function (s) {
        if (s) self.settings = Object.assign({}, self.settings, s);
      });
    },
    setEnabled: function (on) { return this._save({ enabled: !!on }); },
    // Choosing a visual also switches the feature ON, so the pick shows up immediately
    // in the main playback area (previously it stayed invisible while the switch was OFF).
    select: function (idOrNull) {
      var patch = { selectedId: idOrNull || null };
      if (idOrNull) patch.enabled = true;
      return this._save(patch);
    },
    setOpacity: function (pct) { return this._save({ opacity: pct }); },
    // Reset never adds a default visual: selection goes back to None and the feature
    // is switched OFF. Imported files are kept.
    reset: function () { return this._save({ enabled: false, selectedId: null, opacity: 100 }); },

    acquire: function (item) { return this.backend.acquire(item); }
  };

  /* ---------------------------------------------------------- display controller
   * Shows at most ONE visual element inside the given layer, only while audio is
   * the main media. Track changes do not rebuild it; stopping audio, switching to
   * video/image, turning the feature off or choosing None releases it entirely. */
  GhostVisuals.createDisplay = function (layer) {
    var node = null, activeId = null, releaseFn = null, seq = 0, failedId = null;
    var ctx = { audio: false, idle: false, playing: false };

    function teardown() {
      seq++;                       // invalidates any in-flight mount
      releaseElement(node);
      if (releaseFn) { try { releaseFn(); } catch (e) { /* ignore */ } }
      node = null; releaseFn = null; activeId = null;
      layer.hidden = true;
      layer.classList.remove("is-ready");
    }

    function applyPlayback() {
      if (!node || node.tagName !== "VIDEO") return;
      if (ctx.playing) {
        var p = node.play();
        if (p && p.catch) p.catch(function () { /* muted autoplay can only fail if unloaded */ });
      } else {
        node.pause();
      }
    }

    function fail(item, msg) {
      teardown();
      failedId = item.id;          // don't retry a broken file on every play/pause event
      if (GhostVisuals.onError) GhostVisuals.onError(msg);
    }

    function mount(item) {
      var mySeq = ++seq;
      activeId = item.id;          // set immediately so repeated syncs don't re-mount
      GhostVisuals.acquire(item).then(function (res) {
        if (mySeq !== seq) { res.release(); return; }     // superseded while loading
        releaseFn = res.release;
        node = buildElement(item, res.url);
        var ready = function () {
          if (mySeq !== seq) return;
          layer.classList.add("is-ready");
          applyPlayback();
        };
        node.addEventListener(item.type === "video" ? "loadeddata" : "load", ready, { once: true });
        node.addEventListener("error", function () {
          if (mySeq !== seq) return;
          fail(item, "\u201c" + item.name + "\u201d can't be displayed — the file or codec isn't supported");
        }, { once: true });
        layer.appendChild(node);
        layer.hidden = false;
      }, function () {
        if (mySeq !== seq) return;
        fail(item, "\u201c" + item.name + "\u201d could not be loaded");
      });
    }

    return {
      // state: { audio: bool (audio is the main media on screen),
      //          idle: bool (nothing loaded — the empty main stage), playing: bool }
      sync: function (state) {
        if (state) ctx = { audio: !!state.audio, idle: !!state.idle, playing: !!state.playing };
        var s = GhostVisuals.settings;
        var item = (ctx.audio || ctx.idle) && s.enabled ? GhostVisuals.selected() : null;
        if (!item) { failedId = null; if (node || activeId) teardown(); return; }
        if (failedId && item.id !== failedId) failedId = null;
        if (item.id === failedId) return;
        layer.style.opacity = String(Math.max(0, Math.min(100, s.opacity)) / 100);
        if (activeId === item.id) { applyPlayback(); return; }
        teardown();
        mount(item);
      },
      isActive: function () { return !!node; }
    };
  };

  global.GhostVisuals = GhostVisuals;
})(window);
