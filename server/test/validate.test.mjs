// Upload validation: plain-text fields, socials, image magic bytes and metadata stripping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainText, ticker, social, website, uploadFields, sniffImage, imageFromDataUrl, stripImageMetadata, LIMITS } from "../lib/validate.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
// Minimal JPEG: SOI, APP0 (JFIF), APP1 (Exif stub), SOS marker + two bytes, EOI.
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0")), seg(0xe1, Buffer.from("Exif\0\0SECRET-GPS")), seg(0xe2, Buffer.from("ICC_PROFILE\0")), Buffer.from([0xff, 0xda, 0, 2, 0xab, 0xcd, 0xff, 0xd9])]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(4)]);

test("plainText: trims, caps, refuses markup, control and invisible characters", () => {
  assert.equal(plainText("  Spore  ", "name", { max: 32 }), "Spore");
  assert.equal(plainText("", "description", { max: 400 }), "");
  assert.throws(() => plainText("", "name", { max: 32, required: true }), /name is required/);
  assert.throws(() => plainText("x".repeat(33), "name", { max: 32 }), /at most 32/);
  assert.throws(() => plainText("<b>Spore</b>", "name", { max: 32 }), /plain text/);
  assert.throws(() => plainText("Spo\u0000re", "name", { max: 32 }), /control/);
  assert.throws(() => plainText("Spo​re", "name", { max: 32 }), /invisible/);
  assert.throws(() => plainText("Spo‮re", "symbol", { max: 13 }), /invisible/);
  assert.throws(() => plainText("two\nlines", "name", { max: 32 }), /control/);
  assert.equal(plainText("two\r\nlines", "description", { max: 400, multiline: true }), "two\nlines");
  assert.throws(() => plainText(42, "name", { max: 32 }), /must be text/);
});

test("ticker, socials and website normalize or reject", () => {
  assert.equal(ticker("spore"), "SPORE");
  assert.throws(() => ticker("bad ticker"), /1–13 letters/);
  assert.throws(() => ticker("$SPORE"), /letters or digits/);
  assert.equal(social("@spore_fun", "twitter", { hosts: ["x.com", "twitter.com"], base: "https://x.com/" }), "https://x.com/spore_fun");
  assert.equal(social("https://twitter.com/spore/", "twitter", { hosts: ["x.com", "twitter.com"], base: "https://x.com/" }), "https://twitter.com/spore");
  assert.throws(() => social("https://evil.example/spore", "twitter", { hosts: ["x.com"], base: "https://x.com/" }), /x.com link/);
  assert.throws(() => social("<script>", "telegram", { hosts: ["t.me"], base: "https://t.me/" }), /plain text/);
  assert.equal(social("", "telegram", { hosts: ["t.me"], base: "https://t.me/" }), "");
  assert.equal(website("spore.fun"), "https://spore.fun/");
  assert.equal(website("http://spore.fun/x?y=1"), "http://spore.fun/x?y=1");
  assert.throws(() => website("javascript:alert(1)"), /valid URL|http\(s\)/);
  assert.throws(() => website("https://user:pw@spore.fun"), /http\(s\)/);
  assert.throws(() => website("localhost"), /http\(s\)/);
});

test("uploadFields: the whole form, first bad field named", () => {
  const f = uploadFields({ name: " Spore ", symbol: "spore", description: "First.\nSecond.", twitter: "@spore", telegram: "https://t.me/spore", website: "spore.fun" });
  assert.deepEqual(f, { name: "Spore", symbol: "SPORE", description: "First.\nSecond.", twitter: "https://x.com/spore", telegram: "https://t.me/spore", website: "https://spore.fun/" });
  assert.throws(() => uploadFields({ name: "Spore", symbol: "SPORE", description: "<img src=x onerror=alert(1)>" }), /description must be plain text/);
  assert.throws(() => uploadFields({ name: "Spore", symbol: "SPORE", description: "d".repeat(LIMITS.description + 1) }), /description must be at most/);
  assert.throws(() => uploadFields(null), /name is required/);
});

test("sniffImage recognizes the four raster types and nothing else", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(GIF), "image/gif");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniffImage(Buffer.from("<!doctype html><html>")), null);
  assert.equal(sniffImage(Buffer.from([1, 2, 3])), null);
  assert.equal(sniffImage(null), null);
});

test("imageFromDataUrl: declared type must match the bytes; size caps; EXIF stripped", () => {
  const png = imageFromDataUrl(`data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(png.type, "image/png"); assert.ok(png.bytes.equals(PNG), "a PNG without text chunks is byte-identical");
  assert.equal(imageFromDataUrl(`data:image/jpg;base64,${JPEG.toString("base64")}`).type, "image/jpeg", "image/jpg alias");
  assert.throws(() => imageFromDataUrl(`data:image/png;base64,${JPEG.toString("base64")}`), /is jpeg, not png/);
  assert.throws(() => imageFromDataUrl(`data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`), /not a png, jpeg/);
  assert.throws(() => imageFromDataUrl("data:image/svg+xml;base64,PHN2Zy8+"), /png, jpeg, gif or webp/);
  assert.throws(() => imageFromDataUrl("data:image/png;base64,"), /data URL/);
  assert.throws(() => imageFromDataUrl(`data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString("base64")}`), /under 2 MB/);
  assert.throws(() => imageFromDataUrl(`data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`), /under 2 MB/);
  assert.throws(() => imageFromDataUrl(42), /data URL/);
});

test("stripImageMetadata drops JPEG APP1/APP13 and PNG text chunks, keeps pixels, ICC and unknown formats", () => {
  const j = stripImageMetadata(JPEG, "image/jpeg");
  assert.equal(j.includes("SECRET-GPS"), false, "Exif gone");
  assert.equal(j.includes("ICC_PROFILE"), true, "ICC kept");
  assert.equal(j.includes("JFIF"), true);
  assert.ok(j.subarray(-4).equals(Buffer.from([0xab, 0xcd, 0xff, 0xd9])), "scan data and EOI intact");
  assert.equal(sniffImage(j), "image/jpeg");
  // PNG with a tEXt chunk between IHDR and IDAT.
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); };
  const withText = Buffer.concat([PNG.subarray(0, 33), chunk("tEXt", Buffer.from("Author\0Secret Person")), chunk("eXIf", Buffer.from("II*\0gps")), PNG.subarray(33)]);
  const p = stripImageMetadata(withText, "image/png");
  assert.equal(p.includes("Secret Person"), false); assert.equal(p.includes("gps"), false);
  assert.ok(p.equals(PNG), "exactly the original chunks remain");
  assert.ok(stripImageMetadata(WEBP, "image/webp").equals(WEBP));
  assert.ok(stripImageMetadata(GIF, "image/gif").equals(GIF));
  assert.ok(stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff]), "image/jpeg").length > 0, "truncated container returns bytes, never throws");
});
