// Input validation for the upload endpoint: plain-text fields (no markup, no control or invisible
// characters, hard length caps) and image bytes (the declared type must match the magic bytes;
// SVG is never an image here because it can carry scripts). Also strips EXIF-style metadata from
// JPEG and PNG uploads so a creator's camera data never reaches the public metadata host — done by
// walking the container format, which needs no image library.

export const LIMITS = { name: 32, symbol: 13, description: 400, social: 100, website: 200, imageBytes: 2 * 1024 * 1024 };

// C0/C1 controls (newline allowed only where `multiline`), zero-width and bidi-override code points
// (homograph tricks in a ticker), and anything that looks like markup.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const MARKUP_RE = /[<>]/;

/** Returns the cleaned string or throws `Error` with a user-facing message naming the field. */
export function plainText(value, field, { max, required = false, multiline = false } = {}) {
  if (value == null || value === "") { if (required) throw new Error(`${field} is required`); return ""; }
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const s = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (required && !s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} must be at most ${max} characters`);
  if (MARKUP_RE.test(s)) throw new Error(`${field} must be plain text (no < or >)`);
  if (INVISIBLE_RE.test(s)) throw new Error(`${field} contains invisible characters`);
  if (CONTROL_RE.test(s) || (!multiline && s.includes("\n"))) throw new Error(`${field} contains control characters`);
  return s;
}

export function ticker(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{1,13}$/.test(value)) throw new Error("ticker must be 1–13 letters or digits");
  return value.toUpperCase();
}

const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** A handle (`@name`) or a profile URL on the given hosts → normalized URL; empty stays empty. */
export function social(value, field, { hosts, base }) {
  const s = plainText(value, field, { max: LIMITS.social });
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    let u; try { u = new URL(s); } catch { throw new Error(`${field} must be a valid link`); }
    if (u.username || u.password || !hosts.includes(u.hostname.toLowerCase().replace(/^www\./, ""))) throw new Error(`${field} must be a ${hosts[0]} link or a handle`);
    return `https://${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  }
  const h = s.replace(/^@/, "");
  if (!HANDLE_RE.test(h)) throw new Error(`${field} must be a handle or a ${hosts[0]} link`);
  return `${base}${h}`;
}

export function website(value) {
  const s = plainText(value, "website", { max: LIMITS.website });
  if (!s) return "";
  let u; try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error("website must be a valid URL"); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes(".")) throw new Error("website must be a public http(s) URL");
  return u.toString();
}

/** Every text field of an upload, validated and normalized; throws on the first bad field. */
export function uploadFields(body) {
  const b = body && typeof body === "object" ? body : {};
  return {
    name: plainText(b.name, "name", { max: LIMITS.name, required: true }),
    symbol: ticker(b.symbol),
    description: plainText(b.description, "description", { max: LIMITS.description, multiline: true }),
    twitter: social(b.twitter, "twitter", { hosts: ["x.com", "twitter.com"], base: "https://x.com/" }),
    telegram: social(b.telegram, "telegram", { hosts: ["t.me", "telegram.me"], base: "https://t.me/" }),
    website: website(b.website),
  };
}

// ---------------------------------------------------------------- images
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The image type the first bytes prove, or null (SVG, HTML, anything else). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Parses a data URL into `{ type, bytes }` after proving the bytes are the declared image type. */
export function imageFromDataUrl(dataUrl, { maxBytes = LIMITS.imageBytes } = {}) {
  const m = typeof dataUrl === "string" && dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw new Error("image must be a png, jpeg, gif or webp data URL");
  // base64 inflates by 4/3: refuse before decoding what could never fit.
  if (m[2].length > Math.ceil(maxBytes * 4 / 3) + 4) throw new Error(`image must be under ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) throw new Error("image is empty");
  if (bytes.length > maxBytes) throw new Error(`image must be under ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const declared = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  const actual = sniffImage(bytes);
  if (actual !== declared) throw new Error(actual ? `image is ${actual.slice(6)}, not ${declared.slice(6)}` : "image bytes are not a png, jpeg, gif or webp");
  return { type: declared, bytes: stripImageMetadata(bytes, declared) };
}

/**
 * Drops metadata segments that carry EXIF/XMP/IPTC (camera model, GPS, editing history):
 * JPEG APP1 and APP13 markers, PNG text/EXIF chunks. Pixel data, colour profiles (JPEG APP2 ICC,
 * PNG iCCP) and animation are untouched. GIF has no such segments; WebP metadata chunks sit in a
 * container whose size fields would need rewriting, so WebP is returned as-is.
 */
export function stripImageMetadata(bytes, type) {
  try {
    if (type === "image/jpeg") return stripJpeg(bytes);
    if (type === "image/png") return stripPng(bytes);
  } catch { /* malformed container: keep the original bytes, the browser decides */ }
  return bytes;
}

function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; } // standalone markers
    if (marker === 0xda) { out.push(buf.subarray(i)); i = buf.length; break; } // start of scan: the rest is entropy-coded data
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    if (marker !== 0xe1 && marker !== 0xed) out.push(seg); // APP1 (Exif/XMP) and APP13 (Photoshop IPTC) dropped
    i += 2 + len;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return Buffer.concat(out);
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return Buffer.concat(out);
}
