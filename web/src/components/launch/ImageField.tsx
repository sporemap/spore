// The coin image: drop, click, or paste (⌘V anywhere on the page). Raster files are cropped and
// resized to a 512×512 square in the browser (lib/image), so the preview is exactly what the
// coin page will show and the upload stays small; errors read inline, under the field.
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { IMAGE_TYPES, kb, prepareImage, type PreparedImage } from "../../lib/image";

type Props = { value: PreparedImage | null; onChange: (v: PreparedImage | null) => void; tint: string; onPreviewLoad?: (img: HTMLImageElement) => void; pasteTarget?: boolean };

export default function ImageField({ value, onChange, tint, onPreviewLoad, pasteTarget = true }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Stale-result guard: a slow decode of file A must not overwrite a later file B.
  const seq = useRef(0);

  async function take(file: File | undefined | null) {
    if (!file) return;
    const n = ++seq.current;
    setBusy(true); setError(null);
    try {
      const p = await prepareImage(file);
      if (n === seq.current) onChange(p);
    } catch (e) {
      if (n === seq.current) { setError(e instanceof Error ? e.message : String(e)); }
    } finally { if (n === seq.current) setBusy(false); }
  }

  // Paste: the first image item on the clipboard, from anywhere on the page while the form is
  // mounted (a screenshot copied from another app is the common case).
  useEffect(() => {
    if (!pasteTarget) return;
    const onPaste = (ev: ClipboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !(target as HTMLInputElement).type?.startsWith("file")) {
        // Text fields keep their own paste unless the clipboard holds only an image.
        if (ev.clipboardData?.getData("text/plain")) return;
      }
      const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      ev.preventDefault();
      void take(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteTarget]);

  const onDrop = (ev: DragEvent) => { ev.preventDefault(); setOver(false); void take(ev.dataTransfer.files?.[0]); };
  const pick = () => input.current?.click();

  return (
    <div className="image-field">
      <div
        className={`dropzone v2 ${value ? "has" : ""} ${over ? "over" : ""} ${error ? "bad" : ""} ${busy ? "busy" : ""}`}
        style={{ "--tint": tint } as CSSProperties}
        onDragOver={(ev) => { ev.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        onClick={pick} onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } }}
        role="button" tabIndex={0} aria-label={value ? "Replace the coin image" : "Choose the coin image"}
      >
        {value ? (
          <>
            <img className="dz-preview" src={value.dataUrl} alt="coin image preview" onLoad={(ev) => onPreviewLoad?.(ev.currentTarget)} />
            <div className="dz-meta">
              <b>{value.width}×{value.height} · {kb(value.bytes)}</b>
              <span className="muted">{value.resized ? `cropped to a square and resized from ${kb(value.sourceBytes)}` : value.type === "image/gif" ? "GIF kept as-is (animation preserved)" : "kept as-is"}</span>
              <span className="dz-actions">
                <button type="button" className="btn sm ghost" onClick={(ev) => { ev.stopPropagation(); pick(); }}>Replace</button>
                <button type="button" className="btn sm ghost" onClick={(ev) => { ev.stopPropagation(); onChange(null); setError(null); }}>Remove</button>
              </span>
            </div>
          </>
        ) : (
          <>
            <span className="dropzone-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 8" /></svg></span>
            <span className="dz-copy"><b>{busy ? "Preparing…" : over ? "Drop it" : "Drop an image"}</b>{!busy && <>, click to choose, or paste<br /><small className="muted">png · jpg · webp up to 12 MB (resized to 512×512) · gif under 2 MB, kept as-is</small></>}</span>
          </>
        )}
        <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} onClick={(ev) => ev.stopPropagation()} onChange={(ev) => { void take(ev.target.files?.[0]); ev.target.value = ""; }} aria-hidden="true" tabIndex={-1} />
      </div>
      {error && <span className="field-error" role="alert">{error}</span>}
    </div>
  );
}
