/* Ghost Media Player — built-in HLS (.m3u8) player. No external library.
 *
 *   playlist (.m3u8) -> segments (MPEG-TS or fMP4) -> [TS demux -> fMP4 transmux] -> MediaSource -> <video>/<audio>
 *
 * Supports: master + media playlists, live (rolling) and VOD, H.264 video + AAC audio in MPEG-TS,
 * audio-only HLS, fMP4 segments (EXT-X-MAP), AES-128 encrypted segments, automatic variant choice.
 * Not supported (reported with a clear message): HEVC/other codecs the browser engine cannot decode,
 * SAMPLE-AES / DRM, MP3-in-TS audio.
 *
 * Usage: var h = new GhostHLS(mediaElement, "https://.../index.m3u8", { wrap: fn(url)->fetchUrl, onFatal: fn(msg) });
 *        h.destroy();
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ playlist parsing */
  function absUrl(rel, base) { try { return new URL(rel, base).href; } catch (e) { return rel; } }

  function parseAttrs(s) {
    var out = {}, re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g, m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function parsePlaylist(text, base) {
    var lines = text.split(/\r?\n/), i, ln;
    if (!/^#EXTM3U/.test(text.replace(/^\uFEFF/, "").trim())) return { error: "Not an HLS playlist" };
    var isMaster = /#EXT-X-STREAM-INF/.test(text);
    if (isMaster) {
      var variants = [], pending = null;
      for (i = 0; i < lines.length; i++) {
        ln = lines[i].trim();
        if (ln.indexOf("#EXT-X-STREAM-INF:") === 0) pending = parseAttrs(ln.slice(18));
        else if (ln && ln[0] !== "#" && pending) {
          var res = /(\d+)x(\d+)/.exec(pending.RESOLUTION || "");
          variants.push({ url: absUrl(ln, base), bw: parseInt(pending.BANDWIDTH || "0", 10), h: res ? +res[2] : 0, codecs: pending.CODECS || "" });
          pending = null;
        }
      }
      return { master: true, variants: variants };
    }
    var p = { master: false, segments: [], target: 6, endlist: false, mediaSeq: 0, key: null, map: null, vod: false };
    var dur = 0, seq = 0, key = null, map = null, disc = false;
    for (i = 0; i < lines.length; i++) {
      ln = lines[i].trim();
      if (!ln) continue;
      if (ln.indexOf("#EXT-X-TARGETDURATION:") === 0) p.target = parseFloat(ln.slice(22)) || 6;
      else if (ln.indexOf("#EXT-X-MEDIA-SEQUENCE:") === 0) { p.mediaSeq = parseInt(ln.slice(22), 10) || 0; seq = p.mediaSeq; }
      else if (ln.indexOf("#EXT-X-PLAYLIST-TYPE:VOD") === 0) p.vod = true;
      else if (ln.indexOf("#EXT-X-ENDLIST") === 0) p.endlist = true;
      else if (ln.indexOf("#EXTINF:") === 0) dur = parseFloat(ln.slice(8)) || 0;
      else if (ln.indexOf("#EXT-X-DISCONTINUITY") === 0 && ln.indexOf("SEQUENCE") < 0) disc = true;
      else if (ln.indexOf("#EXT-X-KEY:") === 0) {
        var a = parseAttrs(ln.slice(11));
        key = a.METHOD === "NONE" ? null : { method: a.METHOD, uri: a.URI ? absUrl(a.URI, base) : "", iv: a.IV || "" };
      } else if (ln.indexOf("#EXT-X-MAP:") === 0) {
        var m = parseAttrs(ln.slice(11));
        map = { url: absUrl(m.URI, base), range: m.BYTERANGE || "" };
      } else if (ln[0] !== "#") {
        p.segments.push({ url: absUrl(ln, base), dur: dur, seq: seq++, key: key, map: map, disc: disc });
        dur = 0; disc = false;
      }
    }
    return p;
  }

  /* ------------------------------------------------------------------ byte helpers */
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function cat(arrs) {
    var len = 0, i; for (i = 0; i < arrs.length; i++) len += arrs[i].length;
    var out = new Uint8Array(len), o = 0;
    for (i = 0; i < arrs.length; i++) { out.set(arrs[i], o); o += arrs[i].length; }
    return out;
  }
  function box(type) {
    var parts = Array.prototype.slice.call(arguments, 1).map(function (p) { return p instanceof Uint8Array ? p : new Uint8Array(p); });
    var body = cat(parts);
    var head = new Uint8Array(8);
    head.set(u32(body.length + 8), 0);
    for (var i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
    return cat([head, body]);
  }
  function zeros(n) { return new Uint8Array(n); }

  /* ------------------------------------------------------------------ H.264 SPS (size + codec string) */
  function unescapeRbsp(b) {
    var out = [], z = 0;
    for (var i = 0; i < b.length; i++) {
      if (z >= 2 && b[i] === 3) { z = 0; continue; }
      out.push(b[i]); z = b[i] === 0 ? z + 1 : 0;
    }
    return new Uint8Array(out);
  }
  function BitReader(b) { this.b = b; this.p = 0; }
  BitReader.prototype.bit = function () { var v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1; this.p++; return v; };
  BitReader.prototype.bits = function (n) { var v = 0; while (n--) v = v * 2 + this.bit(); return v; };
  BitReader.prototype.ue = function () { var z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (Math.pow(2, z) - 1 + this.bits(z)) : 0; };
  BitReader.prototype.se = function () { var k = this.ue(); return (k & 1) ? (k + 1) / 2 : -k / 2; };

  function parseSps(sps) {
    var r = new BitReader(unescapeRbsp(sps.subarray(1)));
    var profile = r.bits(8); r.bits(8); r.bits(8); r.ue();
    var chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].indexOf(profile) >= 0) {
      chroma = r.ue();
      if (chroma === 3) r.bit();
      r.ue(); r.ue(); r.bit();
      if (r.bit()) {
        var cnt = chroma !== 3 ? 8 : 12;
        for (var i = 0; i < cnt; i++) if (r.bit()) { var last = 8, next = 8, size = i < 6 ? 16 : 64; for (var j = 0; j < size; j++) { if (next !== 0) { next = (last + r.se() + 256) % 256; } last = next === 0 ? last : next; } }
      }
    }
    r.ue();
    var poc = r.ue();
    if (poc === 0) r.ue(); else if (poc === 1) { r.bit(); r.se(); r.se(); var n = r.ue(); for (var k = 0; k < n; k++) r.se(); }
    r.ue(); r.bit();
    var wMbs = r.ue() + 1, hMap = r.ue() + 1, frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    var cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    var subW = chroma === 3 ? 1 : 2, subH = chroma === 1 ? 2 : 1;
    var cropX = chroma === 0 ? 1 : subW, cropY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
    return { width: wMbs * 16 - (cl + cr) * cropX, height: (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * cropY };
  }

  /* ------------------------------------------------------------------ MPEG-TS demux */
  function ptsAt(p, o) {
    return ((p[o] >> 1) & 7) * 1073741824 + ((p[o + 1] << 7) | (p[o + 2] >> 1)) * 32768 + ((p[o + 3] << 7) | (p[o + 4] >> 1));
  }

  function demuxTS(buf) {
    var d = new Uint8Array(buf), n = d.length, start = 0, i;
    while (start < 188 && !(d[start] === 0x47 && d[start + 188] === 0x47)) start++;
    var pmtPid = -1, vPid = -1, aPid = -1, hevc = false, mp3 = false;
    var pes = {};
    var out = { video: [], audio: [], sps: null, pps: null, asc: null, sr: 0, ch: 0, objType: 2, hevc: false, mp3: false };

    function finishPes(pid) {
      var e = pes[pid]; if (!e || !e.chunks.length) return;
      var data = cat(e.chunks); e.chunks = [];
      if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
      var flags = data[7], hl = data[8], pts = -1, dts = -1;
      if (flags & 0x80) pts = ptsAt(data, 9);
      if (flags & 0x40) dts = ptsAt(data, 14); else dts = pts;
      var payload = data.subarray(9 + hl);
      if (pid === vPid) handleVideo(payload, pts, dts);
      else if (pid === aPid) handleAudio(payload, pts);
    }

    function handleVideo(p, pts, dts) {
      if (pts < 0) return;
      var nals = [], j = 0, L = p.length, s = -1;
      while (j + 2 < L) {
        if (p[j] === 0 && p[j + 1] === 0 && p[j + 2] === 1) {
          if (s >= 0) { var e = j; while (e > s && p[e - 1] === 0) e--; nals.push(p.subarray(s, e)); }
          s = j + 3; j += 3;
        } else j++;
      }
      if (s >= 0) nals.push(p.subarray(s, L));
      var key = false, parts = [];
      nals.forEach(function (nal) {
        if (!nal.length) return;
        var t = nal[0] & 31;
        if (t === 7) { if (!out.sps) out.sps = nal.slice(); return; }
        if (t === 8) { if (!out.pps) out.pps = nal.slice(); return; }
        if (t === 9 || t === 12) return;
        if (t === 5) key = true;
        parts.push(new Uint8Array(u32(nal.length)), nal);
      });
      if (parts.length) out.video.push({ dts: dts, pts: pts, key: key, data: cat(parts) });
    }

    function handleAudio(p, pts) {
      var j = 0, k = 0;
      while (j + 7 <= p.length) {
        if (p[j] !== 0xFF || (p[j + 1] & 0xF0) !== 0xF0) { j++; continue; }
        var hdr = (p[j + 1] & 1) ? 7 : 9;
        var objType = ((p[j + 2] >> 6) & 3) + 1, fi = (p[j + 2] >> 2) & 15, ch = ((p[j + 2] & 1) << 2) | (p[j + 3] >> 6);
        var fl = ((p[j + 3] & 3) << 11) | (p[j + 4] << 3) | (p[j + 5] >> 5);
        if (fl < hdr || j + fl > p.length) break;
        var rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        var sr = rates[fi] || 44100;
        if (!out.asc) {
          out.sr = sr; out.ch = ch || 2; out.objType = objType;
          out.asc = new Uint8Array([(objType << 3) | (fi >> 1), ((fi & 1) << 7) | ((ch || 2) << 3)]);
        }
        if (pts >= 0) out.audio.push({ pts: pts + k * 1024 * 90000 / sr, data: p.slice(j + hdr, j + fl) });
        k++; j += fl;
      }
    }

    for (i = start; i + 188 <= n; i += 188) {
      if (d[i] !== 0x47) continue;
      var pid = ((d[i + 1] & 0x1F) << 8) | d[i + 2], pusi = d[i + 1] & 0x40, afc = (d[i + 3] >> 4) & 3;
      var off = i + 4;
      if (afc & 2) off += 1 + d[i + 4];
      if (!(afc & 1) || off >= i + 188) continue;
      var payload = d.subarray(off, i + 188);
      if (pid === 0 && pmtPid < 0) {
        var po = pusi ? 1 + payload[0] : 0;
        var secLen = ((payload[po + 1] & 15) << 8) | payload[po + 2];
        for (var q = po + 8; q + 4 <= po + 3 + secLen - 4; q += 4) {
          var prog = (payload[q] << 8) | payload[q + 1];
          if (prog !== 0) { pmtPid = ((payload[q + 2] & 0x1F) << 8) | payload[q + 3]; break; }
        }
      } else if (pid === pmtPid && vPid < 0 && aPid < 0) {
        var o2 = pusi ? 1 + payload[0] : 0;
        var sl = ((payload[o2 + 1] & 15) << 8) | payload[o2 + 2];
        var pil = ((payload[o2 + 10] & 15) << 8) | payload[o2 + 11];
        var e2 = o2 + 12 + pil, endE = o2 + 3 + sl - 4;
        while (e2 + 5 <= endE) {
          var st = payload[e2], ep = ((payload[e2 + 1] & 0x1F) << 8) | payload[e2 + 2], il = ((payload[e2 + 3] & 15) << 8) | payload[e2 + 4];
          if (st === 0x1b && vPid < 0) vPid = ep;
          else if (st === 0x0f && aPid < 0) aPid = ep;
          else if (st === 0x24) hevc = true;
          else if ((st === 0x03 || st === 0x04) && !mp3) mp3 = true;
          e2 += 5 + il;
        }
        out.hevc = hevc; out.mp3 = mp3;
      } else if (pid === vPid || pid === aPid) {
        var ent = pes[pid] || (pes[pid] = { chunks: [] });
        if (pusi) finishPes(pid);
        ent.chunks.push(payload);
      }
    }
    finishPes(vPid); finishPes(aPid);
    return out;
  }

  /* ------------------------------------------------------------------ fMP4 muxing */
  function unityMatrix() {
    var m = new Uint8Array(36);
    m.set([0, 1, 0, 0], 0); m.set([0, 1, 0, 0], 16); m.set([0x40, 0, 0, 0], 32);
    return m;
  }

  function buildInit(track) {
    var isVideo = track.type === "video", ts = isVideo ? 90000 : track.sr, id = isVideo ? 1 : 2, sd;
    if (isVideo) {
      var sps = track.sps, pps = track.pps, size = track.size;
      var avcC = box("avcC", [1, sps[1], sps[2], sps[3], 0xFF, 0xE1], u16(sps.length), sps, [1], u16(pps.length), pps);
      var nameBytes = new Uint8Array(32);
      sd = box("avc1", zeros(6), u16(1), zeros(16), u16(size.width), u16(size.height), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), nameBytes, u16(0x18), u16(0xFFFF), avcC);
    } else {
      var asc = track.asc;
      var esds = box("esds", zeros(4),
        [3, 25], u16(0), [0],
        [4, 17, 0x40, 0x15], zeros(3), u32(0), u32(0),
        [5, 2], asc,
        [6, 1, 2]);
      sd = box("mp4a", zeros(6), u16(1), zeros(8), u16(track.ch), u16(16), u16(0), u16(0), u32(track.sr * 65536), esds);
    }
    var stbl = box("stbl", box("stsd", zeros(4), u32(1), sd), box("stts", zeros(4), u32(0)), box("stsc", zeros(4), u32(0)), box("stsz", zeros(4), u32(0), u32(0)), box("stco", zeros(4), u32(0)));
    var minf = box("minf", isVideo ? box("vmhd", [0, 0, 0, 1], zeros(8)) : box("smhd", zeros(8)),
      box("dinf", box("dref", zeros(4), u32(1), box("url ", [0, 0, 0, 1]))), stbl);
    var mdia = box("mdia", box("mdhd", zeros(4), u32(0), u32(0), u32(ts), u32(0), u16(0x55C4), u16(0)),
      box("hdlr", zeros(4), zeros(4), isVideo ? [0x76, 0x69, 0x64, 0x65] : [0x73, 0x6F, 0x75, 0x6E], zeros(12), [0]), minf);
    var tkhd = box("tkhd", [0, 0, 0, 7], u32(0), u32(0), u32(id), zeros(4), u32(0), zeros(8), u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0), unityMatrix(),
      u32(isVideo ? track.size.width * 65536 : 0), u32(isVideo ? track.size.height * 65536 : 0));
    return { trak: box("trak", tkhd, mdia), trex: box("trex", zeros(4), u32(id), u32(1), u32(0), u32(0), u32(0)), id: id };
  }

  function buildInitSegment(tracks) {
    var built = tracks.map(buildInit);
    var mvhd = box("mvhd", zeros(4), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), u16(0), zeros(8), unityMatrix(), zeros(24), u32(built.length + 1));
    var moov = box.apply(null, ["moov", mvhd].concat(built.map(function (b) { return b.trak; })).concat([box.apply(null, ["mvex"].concat(built.map(function (b) { return b.trex; })))]));
    var ftyp = box("ftyp", [0x69, 0x73, 0x6F, 0x6D], u32(512), [0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x36, 0x61, 0x76, 0x63, 0x31, 0x6D, 0x70, 0x34, 0x31]);
    return cat([ftyp, moov]);
  }

  var fragSeq = 1;
  function buildFragment(trackSamples) {
    // trackSamples: [{ id, base (tfdt), samples:[{dur,size,flags,cts,data}] }]
    function make(offsets) {
      var trafs = trackSamples.map(function (t, idx) {
        var trun = [0, 0, 0x0F, 0x01].concat(u32(t.samples.length), u32(offsets[idx]));
        var rows = new Uint8Array(t.samples.length * 16), dv = new DataView(rows.buffer);
        t.samples.forEach(function (s, k) { dv.setUint32(k * 16, s.dur); dv.setUint32(k * 16 + 4, s.size); dv.setUint32(k * 16 + 8, s.flags); dv.setUint32(k * 16 + 12, s.cts); });
        var tfdt = new Uint8Array(12); var dv2 = new DataView(tfdt.buffer); dv2.setUint32(0, 0x01000000); dv2.setUint32(4, Math.floor(t.base / 4294967296)); dv2.setUint32(8, t.base >>> 0);
        return box("traf", box("tfhd", [0, 2, 0, 0], u32(t.id)), box("tfdt", tfdt.subarray(0, 12)), box("trun", trun, rows));
      });
      return box.apply(null, ["moof", box("mfhd", zeros(4), u32(fragSeq))].concat(trafs));
    }
    var moof0 = make(trackSamples.map(function () { return 0; }));
    var offsets = [], run = moof0.length + 8;
    trackSamples.forEach(function (t) { offsets.push(run); t.samples.forEach(function (s) { run += s.size; }); });
    var moof = make(offsets);
    var datas = [];
    trackSamples.forEach(function (t) { t.samples.forEach(function (s) { datas.push(s.data); }); });
    fragSeq++;
    return cat([moof, box("mdat", cat(datas))]);
  }

  /* TS segment -> { init (first time only), fragment, codecs } */
  function Transmuxer() { this.init = null; this.tracks = null; this.mime = ""; }
  Transmuxer.prototype.push = function (buf) {
    var t = demuxTS(buf);
    if (t.hevc && !t.video.length) throw new Error("This channel uses HEVC/H.265 video, which this player cannot decode.");
    if (!t.video.length && !t.audio.length) {
      if (t.mp3) throw new Error("This stream uses MP3-in-TS audio, which is not supported.");
      throw new Error("No playable H.264/AAC data in this segment.");
    }
    var hasV = t.video.length > 0 && t.sps && t.pps, hasA = t.audio.length > 0 && t.asc;
    if (!hasV && !hasA) throw new Error("Stream parameters missing in the first segment.");
    var tracks = [];
    if (!this.init) {
      var codecs = [];
      if (hasV) {
        var size = parseSps(t.sps);
        tracks.push({ type: "video", sps: t.sps, pps: t.pps, size: size });
        codecs.push("avc1." + [t.sps[1], t.sps[2], t.sps[3]].map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""));
      }
      if (hasA) { tracks.push({ type: "audio", asc: t.asc, sr: t.sr, ch: t.ch }); codecs.push("mp4a.40." + t.objType); }
      this.tracks = { v: hasV, a: hasA, sr: t.sr };
      this.init = buildInitSegment(tracks);
      this.mime = (hasV ? "video/mp4" : "audio/mp4") + '; codecs="' + codecs.join(",") + '"';
      this.fresh = true;
    } else { this.fresh = false; }
    var useV = this.tracks.v && t.video.length > 0, useA = this.tracks.a && t.audio.length > 0;
    if (!useV && !useA) throw new Error("Empty segment");
    var base = Infinity;
    if (useV) base = Math.min(base, t.video[0].dts);
    if (useA) base = Math.min(base, t.audio[0].pts);
    var list = [];
    if (useV) {
      var vs = t.video, samples = vs.map(function (s, k) {
        var dur = k + 1 < vs.length ? vs[k + 1].dts - s.dts : (k > 0 ? vs[k].dts - vs[k - 1].dts : 3600);
        return { dur: Math.max(1, Math.round(dur)), size: s.data.length, flags: s.key ? 0x02000000 : 0x01010000, cts: Math.max(0, Math.round(s.pts - s.dts)), data: s.data };
      });
      list.push({ id: 1, base: Math.round(vs[0].dts - base), samples: samples });
    }
    if (useA) {
      var sr = this.tracks.sr, as = t.audio;
      list.push({ id: 2, base: Math.round((as[0].pts - base) * sr / 90000), samples: as.map(function (s) { return { dur: 1024, size: s.data.length, flags: 0x02000000, cts: 0, data: s.data }; }) });
    }
    return { fragment: buildFragment(list), init: this.fresh ? this.init : null, mime: this.mime };
  };

  function findTag(b, tag) {
    var c = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
    for (var i = 0; i + 4 <= b.length; i++) if (b[i] === c[0] && b[i + 1] === c[1] && b[i + 2] === c[2] && b[i + 3] === c[3]) return i;
    return -1;
  }
  function mimeFromInit(b) {
    if (findTag(b, "hvcC") >= 0 || findTag(b, "hev1") >= 0 || findTag(b, "hvc1") >= 0) throw new Error("This channel uses HEVC/H.265 video, which this player cannot decode.");
    if (findTag(b, "av01") >= 0) throw new Error("This channel uses AV1 video, which this player does not support.");
    var codecs = [], v = findTag(b, "avcC");
    if (v >= 0) codecs.push("avc1." + [b[v + 5], b[v + 6], b[v + 7]].map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""));
    if (findTag(b, "mp4a") >= 0) codecs.push("mp4a.40.2");
    return (v >= 0 ? "video/mp4" : "audio/mp4") + '; codecs="' + codecs.join(",") + '"';
  }

  /* ------------------------------------------------------------------ the player */
  var AHEAD_SECONDS = 30, KEEP_BEHIND = 25;

  function GhostHLS(el, url, cfg) {
    this.el = el; this.url = url; this.cfg = cfg || {};
    this.dead = false; this.sb = null; this.mux = new Transmuxer(); this.keys = {}; this.initUrl = "";
    this.ms = new MediaSource();
    this.objUrl = URL.createObjectURL(this.ms);
    var self = this;
    el.src = this.objUrl;
    this.ms.addEventListener("sourceopen", function () { self._run().catch(function (e) { self._fatal(e); }); }, { once: true });
    this.gapTimer = setInterval(function () { self._gapJump(); }, 500);
  }

  GhostHLS.prototype._fatal = function (e) {
    if (this.dead) return;
    var msg = e && e.message ? e.message : String(e);
    if (this.cfg.onFatal) this.cfg.onFatal(msg);
  };

  GhostHLS.prototype._u = function (u) { return this.cfg.wrap ? this.cfg.wrap(u) : u; };

  GhostHLS.prototype._get = async function (u, binary) {
    var last = null;
    for (var a = 0; a < 3 && !this.dead; a++) {
      try {
        var r = await fetch(this._u(u));
        if (!r.ok) throw new Error("HTTP " + r.status);
        return binary ? await r.arrayBuffer() : await r.text();
      } catch (e) { last = e; await sleep(400 * (a + 1)); }
    }
    throw new Error("Could not load " + (u.length > 70 ? u.slice(0, 70) + "\u2026" : u) + " (" + (last && last.message ? last.message : "network") + ")");
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  GhostHLS.prototype._decrypt = async function (seg, data) {
    var k = seg.key;
    if (!k) return data;
    if (k.method !== "AES-128") throw new Error("This stream is protected (" + k.method + ") and can't be played.");
    var raw = this.keys[k.uri] || (this.keys[k.uri] = await this._get(k.uri, true));
    var iv = new Uint8Array(16);
    if (k.iv) { var hex = k.iv.replace(/^0x/i, "").padStart(32, "0"); for (var i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16); }
    else { var dv = new DataView(iv.buffer); dv.setUint32(12, seg.seq >>> 0); }
    var ck = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    return await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, ck, data);
  };

  GhostHLS.prototype._waitSb = function () {
    var sb = this.sb, self = this;
    return new Promise(function (res) {
      if (!sb.updating) return res();
      var done = function () { sb.removeEventListener("updateend", done); res(); };
      sb.addEventListener("updateend", done);
    });
  };

  GhostHLS.prototype._append = async function (bytes) {
    await this._waitSb();
    if (this.dead) return;
    var sb = this.sb, self = this;
    await new Promise(function (res, rej) {
      var ok = function () { sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad); res(); };
      var bad = function () { sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad); rej(new Error("The player rejected this video data (unsupported codec or damaged stream).")); };
      sb.addEventListener("updateend", ok); sb.addEventListener("error", bad);
      try { sb.appendBuffer(bytes); } catch (e) {
        sb.removeEventListener("updateend", ok); sb.removeEventListener("error", bad);
        if (e && e.name === "QuotaExceededError") { self._trim(true).then(res); } else rej(e);
      }
    });
  };

  GhostHLS.prototype._trim = async function (force) {
    var sb = this.sb, t = this.el.currentTime;
    if (!sb || sb.updating) return;
    try {
      if (sb.buffered.length) {
        var s = sb.buffered.start(0), cut = t - (force ? 5 : KEEP_BEHIND);
        if (cut - s > 5) { sb.remove(s, cut); await this._waitSb(); }
      }
    } catch (e) { /* ignore */ }
  };

  GhostHLS.prototype._ahead = function () {
    try {
      var b = this.el.buffered, t = this.el.currentTime;
      for (var i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i) - t;
    } catch (e) { /* ignore */ }
    return 0;
  };

  GhostHLS.prototype._gapJump = function () {
    if (this.dead || !this.el || this.el.paused) return;
    try {
      var b = this.el.buffered, t = this.el.currentTime;
      if (this.el.readyState >= 3) return;
      for (var i = 0; i < b.length; i++) if (b.start(i) > t && b.start(i) - t < 2.5) { this.el.currentTime = b.start(i) + 0.05; return; }
    } catch (e) { /* ignore */ }
  };

  GhostHLS.prototype._pickVariant = function (vs) {
    var usable = vs.filter(function (v) { return !/hvc1|hev1|av01|vp09/.test(v.codecs); });
    if (!usable.length) usable = vs;
    usable.sort(function (a, b) { return a.bw - b.bw; });
    // best variant up to 720p (smooth + good looking); otherwise the smallest one
    var best = null;
    usable.forEach(function (v) { if (!v.h || v.h <= 720) best = v; });
    return best || usable[0];
  };

  GhostHLS.prototype._run = async function () {
    var mediaUrl = this.url, pl, text;
    for (var depth = 0; depth < 3; depth++) {
      text = await this._get(mediaUrl, false);
      pl = parsePlaylist(text, mediaUrl);
      if (pl.error) throw new Error("This link is not an HLS playlist.");
      if (!pl.master) break;
      if (!pl.variants.length) throw new Error("The playlist has no streams.");
      mediaUrl = this._pickVariant(pl.variants).url;
    }
    if (pl.master) throw new Error("Playlist nesting too deep.");
    var nextSeq = -1, ended = false, sentMap = "";
    while (!this.dead) {
      if (!pl.segments.length) throw new Error("The playlist has no segments.");
      if (nextSeq < 0) nextSeq = pl.endlist ? pl.segments[0].seq : Math.max(pl.segments[0].seq, pl.segments[pl.segments.length - 1].seq - 2);
      for (var i = 0; i < pl.segments.length && !this.dead; i++) {
        var seg = pl.segments[i];
        if (seg.seq < nextSeq) continue;
        while (!this.dead && this._ahead() > AHEAD_SECONDS) { await sleep(700); await this._trim(); }
        if (this.dead) return;
        var data = await this._get(seg.url, true);
        data = await this._decrypt(seg, data);
        var u8 = new Uint8Array(data);
        if (u8[0] === 0x47) {
          var r = this.mux.push(data);
          if (!this.sb) this._openBuffer(r.mime);
          if (r.init) await this._append(r.init);
          await this._append(r.fragment);
        } else {
          // fragmented MP4 segments: read the real codecs out of the init segment
          if (seg.map && seg.map.url !== sentMap) {
            var init = new Uint8Array(await this._get(seg.map.url, true));
            if (!this.sb) this._openBuffer(mimeFromInit(init));
            await this._append(init); sentMap = seg.map.url;
          } else if (!this.sb) this._openBuffer('video/mp4; codecs="avc1.64001f,mp4a.40.2"');
          await this._append(u8);
        }
        nextSeq = seg.seq + 1;
        await this._trim();
      }
      if (pl.endlist) { ended = true; break; }
      await sleep(Math.max(1000, pl.target * 500));
      text = await this._get(mediaUrl, false);
      pl = parsePlaylist(text, mediaUrl);
    }
    if (ended && !this.dead) { await this._waitSb(); try { if (this.ms.readyState === "open") this.ms.endOfStream(); } catch (e) { /* ignore */ } }
  };

  GhostHLS.prototype._openBuffer = function (mime) {
    if (!global.MediaSource || !MediaSource.isTypeSupported(mime)) throw new Error("The video format of this channel isn't supported by the engine (" + mime + ").");
    this.sb = this.ms.addSourceBuffer(mime);
    try { this.sb.mode = "sequence"; } catch (e) { /* ignore */ }
  };

  GhostHLS.prototype.destroy = function () {
    this.dead = true;
    clearInterval(this.gapTimer);
    try { if (this.ms.readyState === "open") this.ms.endOfStream(); } catch (e) { /* ignore */ }
    try { this.el.removeAttribute("src"); this.el.load(); } catch (e) { /* ignore */ }
    try { URL.revokeObjectURL(this.objUrl); } catch (e) { /* ignore */ }
  };

  global.GhostHLS = GhostHLS;
  global.GhostHLS._parsePlaylist = parsePlaylist;
  global.GhostHLS._parseSps = parseSps;
  global.GhostHLS.supported = !!(global.MediaSource && global.MediaSource.isTypeSupported);
})(window);
