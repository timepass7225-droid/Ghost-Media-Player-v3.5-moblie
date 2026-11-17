// Generates the synthetic audio / lyrics fixtures used by the browser tests (nothing copyrighted).
"use strict";
var fs = require("fs"), path = require("path"), S = require("./synth.js");
var out = process.argv[2] || path.join(__dirname, "fixtures");
fs.mkdirSync(out, { recursive: true });

function wav(name, samples, sr) {
  var n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (var i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767 * 0.9))), 44 + i * 2);
  fs.writeFileSync(path.join(out, name), buf);
}
var SR = 22050;
wav("kick128.wav", S.makeTrack({ bpm: 128, offset: 0.33, seconds: 60, sr: SR, hats: 8, snare: true, bass: true, noise: 0.01, seed: 21 }), SR);
wav("kick120.wav", S.makeTrack({ bpm: 120, offset: 0.12, seconds: 60, sr: SR, hats: 8, snare: true, bass: true, noise: 0.01, seed: 22 }), SR);

var n = 20 * SR, tone = new Float32Array(n);
for (var i = 0; i < n; i++) tone[i] = 0.3 * Math.sin(2 * Math.PI * 100 * i / SR) + 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR) + 0.3 * Math.sin(2 * Math.PI * 8000 * i / SR);
wav("tone.wav", tone, SR);

var click = new Float32Array(8 * SR);
for (var j = 0; j < 220; j++) click[Math.round(0.5 * SR) + j] = 0.9 * Math.sin(2 * Math.PI * 1000 * j / SR) * (1 - j / 220);
wav("click.wav", click, SR);

var noteTrack = new Float32Array(30 * SR);
for (var k = 0; k < noteTrack.length; k++) noteTrack[k] = 0.25 * Math.sin(2 * Math.PI * 330 * k / SR);
wav("song.wav", noteTrack, SR);
wav("other.wav", noteTrack, SR);

fs.writeFileSync(path.join(out, "song.lrc"),
  "[ti:Test Song]\n[ar:Test Artist]\n[offset:0]\n[00:01.00]First line\n[00:04.50]Second line\n[00:08.00]Third line\n[00:08.00][00:20.00]Repeated chorus\n[00:12.25]Fourth <00:12.50>line <00:13.00>here\n[00:16]\n[00:25.000]Last line\n");
fs.writeFileSync(path.join(out, "other.lrc"), "[00:00.50]Other song line one\n[00:03.00]Other song line two\n[00:06.00]Other song line three\n");
fs.writeFileSync(path.join(out, "crlf.lrc"), "[ar:CR LF]\r\n[00:02.00]alpha\r\n[00:04.00]beta\r\n[00:06.00]gamma\r\n");
fs.writeFileSync(path.join(out, "plain.txt"), "Verse one line A\nVerse one line B\n\nChorus line A\nChorus line B\n");
fs.writeFileSync(path.join(out, "binary.lrc"), Buffer.from(Array.from({ length: 2000 }, function (_, x) { return (x * 37) % 256; })));
fs.writeFileSync(path.join(out, "empty.lrc"), "[ti:Nothing]\n[ar:Nobody]\n");
// UTF-16LE LRC with BOM and Latin-1 LRC
var u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("[00:01.00]Zażółć gęślą\n[00:03.00]jaźń\n", "utf16le")]);
fs.writeFileSync(path.join(out, "u16.lrc"), u16);
fs.writeFileSync(path.join(out, "latin1.lrc"), Buffer.from("[00:01.00]caf\xe9 cr\xe8me\n[00:03.00]se\xf1or\n", "latin1"));
// offset-shifted LRC (+500 ms => lines appear 0.5 s earlier)
fs.writeFileSync(path.join(out, "offset.lrc"), "[offset:500]\n[00:02.00]early\n[00:04.00]early two\n");

// MP3-shaped file with ID3v2.3 tags + USLT lyrics (only the tag is real; it is for the tag reader test)
function frame(id, body) { var h = Buffer.alloc(10); h.write(id, 0); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); }
function txt(s) { return Buffer.concat([Buffer.from([3]), Buffer.from(s, "utf8")]); }
var uslt = Buffer.concat([Buffer.from([3]), Buffer.from("eng"), Buffer.from("desc\0", "utf8"), Buffer.from("[00:01.00]Embedded one\n[00:03.00]Embedded two\n", "utf8")]);
var frames = Buffer.concat([frame("TIT2", txt("Tagged Title")), frame("TPE1", txt("Tagged Artist")), frame("TALB", txt("Tagged Album")), frame("USLT", uslt)]);
var size = frames.length, hdr = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
fs.writeFileSync(path.join(out, "tagged.mp3"), Buffer.concat([hdr, frames, Buffer.alloc(512)]));
// FLAC-shaped file with Vorbis comment
function le32(v) { var b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }
var comments = ["TITLE=Flac Title", "ARTIST=Flac Artist", "LYRICS=plain flac lyrics line"].map(function (c) { return Buffer.concat([le32(Buffer.byteLength(c)), Buffer.from(c)]); });
var vendor = Buffer.from("test");
var vc = Buffer.concat([le32(vendor.length), vendor, le32(comments.length)].concat(comments));
var bh = Buffer.from([0x84, (vc.length >> 16) & 255, (vc.length >> 8) & 255, vc.length & 255]);
fs.writeFileSync(path.join(out, "tagged.flac"), Buffer.concat([Buffer.from("fLaC"), bh, vc, Buffer.alloc(64)]));
console.log("fixtures in", out, fs.readdirSync(out).join(", "));
