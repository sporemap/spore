// The phone bottom sheet around the map's side panel: a 28×4 handle and two snap states. Peek (~170 px)
// shows the coin and its two actions; full (80dvh) scrolls the whole panel. Only the HANDLE takes
// gestures (pointer events, propagation stopped), so a pinch or pan on the canvas keeps zooming the map:
// a tap toggles, a drag up ≥ 40 px expands, a drag down ≥ 60 px closes (clears ?focus). The visible
// height is reported through `onHeight` so the page can keep the selected bubble above the sheet.
import { useEffect, useLayoutEffect, useRef, type ReactNode, type PointerEvent as RPointerEvent } from "react";

export type SheetState = "peek" | "full";
const CLOSE_PX = 60, EXPAND_PX = 40, TAP_PX = 6;

type Props = { state: SheetState; onState: (s: SheetState) => void; onClose: () => void; onHeight?: (px: number) => void; label: string; children: ReactNode };

export default function Sheet({ state, onState, onClose, onHeight, label, children }: Props) {
  const el = useRef<HTMLElement>(null);
  const drag = useRef<{ id: number; y0: number; dy: number } | null>(null);
  const suppressClick = useRef(false);
  const onHeightRef = useRef(onHeight); onHeightRef.current = onHeight;

  useLayoutEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const report = () => onHeightRef.current?.(Math.round(node.getBoundingClientRect().height));
    const ro = new ResizeObserver(report);
    ro.observe(node);
    report();
    return () => ro.disconnect();
  }, []);
  // Expanded content starts at the top again when the sheet goes back to peek.
  useEffect(() => { if (state === "peek" && el.current) el.current.scrollTop = 0; }, [state]);

  const setOffset = (dy: number) => { if (el.current) el.current.style.transform = dy ? `translateY(${dy}px)` : ""; };
  const down = (e: RPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    suppressClick.current = false;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0 };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  };
  const move = (e: RPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = e.clientY - d.y0;
    // Follow the finger downwards (a hint that letting go closes it); upward drags only resist a little.
    setOffset(d.dy > 0 ? d.dy : Math.max(-24, d.dy / 3));
  };
  const up = (e: RPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const d = drag.current;
    drag.current = null;
    setOffset(0);
    if (!d || d.id !== e.pointerId) return;
    if (Math.abs(d.dy) < TAP_PX) return; // a tap: the click handler toggles
    suppressClick.current = true;
    if (d.dy >= CLOSE_PX) onClose();
    else if (d.dy <= -EXPAND_PX) onState("full");
  };
  const cancel = (e: RPointerEvent<HTMLButtonElement>) => { e.stopPropagation(); drag.current = null; setOffset(0); };

  return (
    <section ref={el} className={`map-sheet ${state}`} aria-label={label}>
      <button type="button" className="map-sheet-handle" aria-label={state === "peek" ? "Expand details" : "Collapse details"} aria-expanded={state === "full"}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
        onClick={(e) => { e.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; return; } onState(state === "peek" ? "full" : "peek"); }}>
        <i aria-hidden="true" />
      </button>
      {children}
    </section>
  );
}
