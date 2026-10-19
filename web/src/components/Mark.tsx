import { useId } from "react";

/// The Spore mark: a lime seed with a dimple, a teal spore nestled in the dimple and a violet
/// speck drifting off. The three colours are the depth colours (d0 lime, d1 teal, d2 violet), so
/// the mark is the family tree in miniature. Inline so it inherits CSS sizing and gets a glow from
/// `.mark`; public/mark.svg and public/favicon.svg carry the same geometry for static use and
/// tools/brand.mts renders the PNG icon set and the OG image from those files. Keep the four in
/// step when the shape changes.
export const MARK_PATH = "M49.21 32.16A22 22 0 1 1 35.11 17.18A11 11 0 0 0 49.21 32.16Z";
export const MARK_SPORES = [{ cx: 48, cy: 19, r: 7, fill: "#5ce0c8" }, { cx: 59.5, cy: 7.5, r: 4, fill: "#b08cff" }] as const;

export default function Mark({ size = 26, className = "" }: { size?: number; className?: string }) {
  // Several marks share a page (nav, footer, 404); gradient ids must not collide between them.
  const id = useId();
  return (
    <svg className={`mark ${className}`} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-seed`} cx="36%" cy="32%" r="70%">
          <stop offset="0" stopColor="#eaffc4" />
          <stop offset=".5" stopColor="#b6ff5c" />
          <stop offset="1" stopColor="#7ed32f" />
        </radialGradient>
      </defs>
      <path d={MARK_PATH} fill={`url(#${id}-seed)`} />
      {MARK_SPORES.map((s) => <circle key={s.fill} cx={s.cx} cy={s.cy} r={s.r} fill={s.fill} />)}
    </svg>
  );
}
