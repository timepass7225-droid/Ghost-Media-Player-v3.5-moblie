/* Ghost Media Player — minimal audio tag reader (offline, no library)
 *
 * Reads only what the new DJ / Lyrics screens need, straight from the local
 * File, without decoding any audio:
 *   MP3  : ID3v2.2/2.3/2.4 (title, artist, album, USLT lyrics), ID3v1 fallback
 *   FLAC : Vorbis comments (title, artist, album, LYRICS / UNSYNCEDLYRICS)
 * Anything else (or any parse problem) simply yields an empty result — nothing
 * is ever guessed. Only the frames that are needed are read from disk, so large
 * embedded cover art is skipped rather than loaded.
 */
(function (global) {
  "use strict";

  var MAX_TEXT = 512 * 1024;       // never pull more than this for a text frame
  var MAX_SCAN = 64 * 1024 * 1024; // sanity limit for tag size

  function readBlob(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(blob);
    });
  }
  function bytes(file, start, len) { return readBlob(file.slice(start, start + len)); }

  function synchsafe(b, o) { return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }
  function be32(b, o) { return ((b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]); }
  function le32(b, o) { return (b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + (b[o + 3] * 16777216)); }
  function ascii(b, o, n) { var s = ""; for (var i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; }

  function dec(label, u8) { try { return new TextDecoder(label).decode(u8); } catch (e) { return ""; } }

  /* ID3 text decoding: 0 = ISO-8859-1, 1 = UTF-16 (BOM), 2 = UTF-16BE, 3 = UTF-8 */
  function decodeText(enc, u8) {
    if (enc === 1) {
      if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return dec("utf-16be", u8.subarray(2));
      if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return dec("utf-16le", u8.subarray(2));
      return dec("utf-16le", u8);
    }
    if (enc === 2) return dec("utf-16be", u8);
    if (enc === 3) return dec("utf-8", u8);
    return dec("iso-8859-1", u8);
  }
  function trimNulls(s) { return s.replace(/\u0000+$/g, "").replace(/^\uFEFF/, ""); }

  function unsync(u8) {            // undo ID3 unsynchronisation (FF 00 -> FF)
    var out = new Uint8Array(u8.length), j = 0;
    for (var i = 0; i < u8.length; i++) {
      out[j++] = u8[i];
      if (u8[i] === 0xFF && u8[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  /* index of the terminator that ends a descriptor string in this encoding */
  function termIndex(enc, u8, from) {
    if (enc === 1 || enc === 2) {
      for (var i = from; i + 1 < u8.length; i += 2) if (u8[i] === 0 && u8[i + 1] === 0) return i;
      return -1;
    }
    for (var k = from; k < u8.length; k++) if (u8[k] === 0) return k;
    return -1;
  }

  function parseTextFrame(body) {
    if (!body.length) return "";
    var enc = body[0];
    var txt = trimNulls(decodeText(enc, body.subarray(1)));
    return txt.split("\u0000").map(function (s) { return s.trim(); }).filter(Boolean).join(" / ");
  }
  function parseUSLT(body) {
    if (body.length < 5) return "";
    var enc = body[0];
    var pos = 4;                                   // enc + 3-byte language
    var t = termIndex(enc, body, pos);
    if (t === -1) return "";
    pos = t + ((enc === 1 || enc === 2) ? 2 : 1);
    return trimNulls(decodeText(enc, body.subarray(pos))).replace(/\r\n?/g, "\n");
  }

  function readID3v2(file) {
    return bytes(file, 0, 10).then(function (h) {
      if (h.length < 10 || ascii(h, 0, 3) !== "ID3") return null;
      var ver = h[3], flags = h[5], size = synchsafe(h, 6);
      if ((ver !== 2 && ver !== 3 && ver !== 4) || size <= 0 || size > MAX_SCAN) return null;
      var end = 10 + size, out = {};

      function finish() { return out; }
      function frames(pos) {
        var idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
        if (pos + hdrLen > end) return finish();
        return bytes(file, pos, hdrLen).then(function (fh) {
          if (fh.length < hdrLen || fh[0] === 0) return finish();            // padding
          var id = ascii(fh, 0, idLen);
          var fsize = ver === 2 ? ((fh[3] << 16) | (fh[4] << 8) | fh[5]) : (ver === 4 ? synchsafe(fh, 4) : be32(fh, 4));
          if (!/^[A-Z0-9]+$/.test(id) || fsize <= 0 || pos + hdrLen + fsize > end) return finish();
          var fflags = ver === 2 ? 0 : ((fh[8] << 8) | fh[9]);
          var next = pos + hdrLen + fsize;

          var key = null;
          if (id === "TIT2" || id === "TT2") key = "title";
          else if (id === "TPE1" || id === "TP1") key = "artist";
          else if (id === "TALB" || id === "TAL") key = "album";
          else if (id === "USLT" || id === "ULT") key = "lyrics";
          if (!key || out[key]) return frames(next);

          var compressedOrEncrypted = ver === 4 ? (fflags & 0x000C) : (fflags & 0x00C0);
          if (compressedOrEncrypted) return frames(next);
          var want = Math.min(fsize, MAX_TEXT);
          return bytes(file, pos + hdrLen, want).then(function (body) {
            var dli = ver === 4 && (fflags & 0x0001);
            var uns = ver === 4 ? (fflags & 0x0002) : (flags & 0x80);
            if (dli) body = body.subarray(4);
            if (uns) body = unsync(body);
            var v = key === "lyrics" ? parseUSLT(body) : parseTextFrame(body);
            if (v && v.trim()) out[key] = v.trim();
            return frames(next);
          });
        });
      }

      if (flags & 0x40 && ver >= 3) {          // extended header: skip it
        return bytes(file, 10, 4).then(function (eh) {
          var ehs = ver === 4 ? synchsafe(eh, 0) : be32(eh, 0) + 4;
          return frames(10 + ehs);
        });
      }
      return frames(10);
    });
  }

  function readID3v1(file) {
    if (file.size < 128) return Promise.resolve(null);
    return bytes(file, file.size - 128, 128).then(function (b) {
      if (ascii(b, 0, 3) !== "TAG") return null;
      function f(o, n) { return dec("iso-8859-1", b.subarray(o, o + n)).replace(/\u0000.*$/, "").trim(); }
      var r = { title: f(3, 30), artist: f(33, 30), album: f(63, 30) };
      return (r.title || r.artist || r.album) ? r : null;
    });
  }

  function readFlac(file) {
    return bytes(file, 0, 4).then(function (m) {
      if (ascii(m, 0, 4) !== "fLaC") return null;
      var out = {};
      function block(pos, n) {
        if (n > 64) return out;
        return bytes(file, pos, 4).then(function (h) {
          if (h.length < 4) return out;
          var last = !!(h[0] & 0x80), type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
          var next = pos + 4 + len;
          if (type === 4 && len > 8 && len <= MAX_SCAN) {
            return bytes(file, pos + 4, Math.min(len, MAX_TEXT * 2)).then(function (b) {
              var o = 0, vlen = le32(b, o); o += 4 + vlen;
              var cnt = le32(b, o); o += 4;
              for (var i = 0; i < cnt && o + 4 <= b.length; i++) {
                var l = le32(b, o); o += 4;
                if (o + l > b.length) break;
                var s = dec("utf-8", b.subarray(o, o + l)); o += l;
                var eq = s.indexOf("=");
                if (eq < 1) continue;
                var k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
                if (!v) continue;
                if (k === "TITLE" && !out.title) out.title = v;
                else if (k === "ARTIST" && !out.artist) out.artist = v;
                else if (k === "ALBUM" && !out.album) out.album = v;
                else if ((k === "LYRICS" || k === "UNSYNCEDLYRICS") && !out.lyrics) out.lyrics = v.replace(/\r\n?/g, "\n");
              }
              return out;
            });
          }
          if (last) return out;
          return block(next, n + 1);
        });
      }
      return block(4, 0);
    });
  }

  function read(file) {
    if (!file || typeof file.slice !== "function") return Promise.resolve({});
    var empty = {};
    if (!file || !file.slice) return Promise.resolve(empty);
    var ext = ((file.name || "").split(".").pop() || "").toLowerCase();
    var job;
    if (ext === "flac") job = readFlac(file);
    else if (ext === "mp3") job = readID3v2(file).then(function (r) { return r && (r.title || r.artist || r.lyrics) ? r : readID3v1(file).then(function (v1) { return Object.assign({}, v1 || {}, r || {}); }); });
    else job = Promise.resolve(null);
    return job.then(function (r) { return r || empty; }, function () { return empty; });
  }

  global.GhostTags = { read: read };
})(window);
