// The coin image, prepared in the browser before upload: raster files are centre-cropped and
// resized to a 512×512 square (what every pump.fun card shows), so a 6 MB photo becomes a small
// upload and the preview is exactly what the coin page will show. GIFs are kept as-is (a canvas
// would drop the animation), so they must already be under the upload limit.
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// What the server accepts (DESIGN §11.3: the data URL is validated at 2 MB).
export const MAX_UPLOAD = 2 * 1024 * 1024;
/// What a raster file may be before resizing; past this even decoding is slow on a phone.
export const MAX_SOURCE = 12 * 1024 * 1024;
export const SIDE = 512;

export type PreparedImage = { dataUrl: string; type: string; bytes: number; width: number; height: number; resized: boolean; sourceBytes: number };

const read = (f: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("Could not read the file")); r.readAsDataURL(f); });
const load = (url: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That file is not a readable image")); i.src = url; });
const dataUrlBytes = (u: string) => Math.floor(((u.length - u.indexOf(",") - 1) * 3) / 4);

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Use a png, jpg, gif or webp");
  if (file.type === "image/gif") {
    if (file.size > MAX_UPLOAD) throw new Error(`GIFs are kept as they are, so this one must be under 2 MB (it is ${(file.size / 1048576).toFixed(1)} MB)`);
    const dataUrl = await read(file);
    const img = await load(dataUrl);
    return { dataUrl, type: file.type, bytes: file.size, width: img.naturalWidth, height: img.naturalHeight, resized: false, sourceBytes: file.size };
  }
  if (file.size > MAX_SOURCE) throw new Error(`That image is ${(file.size / 1048576).toFixed(0)} MB; please use one under 12 MB`);
  const img = await load(await read(file));
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error("That file is not a readable image");
  const square = w === h && w <= SIDE;
  // Already a small square: keep the original bytes (no re-encoding, no quality loss).
  if (square && file.size <= MAX_UPLOAD) return { dataUrl: img.src, type: file.type, bytes: file.size, width: w, height: h, resized: false, sourceBytes: file.size };
  const side = Math.min(w, h);
  const c = document.createElement("canvas");
  c.width = c.height = SIDE;
  const g = c.getContext("2d");
  if (!g) throw new Error("This browser cannot resize images; upload a square png under 2 MB");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SIDE, SIDE);
  // Photos stay jpeg; anything with transparency stays png (a webp becomes png: pump.fun's
  // metadata hosts have been inconsistent with webp). Fall back to jpeg if png is still too big.
  let type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  let dataUrl = c.toDataURL(type, 0.92);
  if (dataUrlBytes(dataUrl) > MAX_UPLOAD && type === "image/png") { type = "image/jpeg"; dataUrl = c.toDataURL(type, 0.9); }
  const bytes = dataUrlBytes(dataUrl);
  if (bytes > MAX_UPLOAD) throw new Error("Even resized, the image is over 2 MB; try a simpler one");
  return { dataUrl, type, bytes, width: SIDE, height: SIDE, resized: true, sourceBytes: file.size };
}

export const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/// Form helpers shared by the launch form: a bare handle becomes a full profile URL, so what gets
/// written into the metadata is always a link.
export function normaliseSocial(kind: "twitter" | "telegram" | "website", raw: string): string {
  let v = raw.trim();
  if (!v) return "";
  if (kind === "website") {
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v;
  }
  if (/^https?:\/\//i.test(v)) return v;
  v = v.replace(/^@/, "");
  if (kind === "twitter") {
    v = v.replace(/^(?:www\.)?(?:x\.com|twitter\.com)\//i, "");
    return v ? `https://x.com/${v}` : "";
  }
  v = v.replace(/^(?:www\.)?t\.me\//i, "");
  return v ? `https://t.me/${v}` : "";
}
export const isHttpUrl = (v: string) => { try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; } };
