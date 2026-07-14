/**
 * BullStake mark — the bull skull wearing a steak crown, redrawn as an inline
 * SVG from the brand art so it stays crisp at nav sizes and the eyes can glow
 * the exact site green. Original vector (license-clean), no asset files.
 */
export function BullLogo({ size = 38 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden
      className="shrink-0"
    >
      {/* Horns */}
      <path
        d="M14 18 C10 34 16 48 30 54 L36 44 C25 39 20 30 22 20 C22 16 16 14 14 18 Z"
        fill="#fff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"
      />
      <path
        d="M86 18 C90 34 84 48 70 54 L64 44 C75 39 80 30 78 20 C78 16 84 14 86 18 Z"
        fill="#fff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"
      />
      {/* Skull */}
      <path
        d="M50 22 C67 22 76 33 76 47 C76 57 71 63 66 67 L66 78 C66 88 59 94 50 94 C41 94 34 88 34 78 L34 67 C29 63 24 57 24 47 C24 33 33 22 50 22 Z"
        fill="#fff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"
      />
      {/* Cheek lines */}
      <path d="M34 66 L40 62 M66 66 L60 62" stroke="#000" strokeWidth="1.8" strokeLinecap="round" />
      {/* Eyes: black sockets, green slit pupils */}
      <path d="M30 46 C34 42 42 42 45 46 C45 52 41 56 36 56 C32 56 30 51 30 46 Z" fill="#000" />
      <path d="M70 46 C66 42 58 42 55 46 C55 52 59 56 64 56 C68 56 70 51 70 46 Z" fill="#000" />
      <path d="M33 47 C36 45.4 41 45.2 44 47" stroke="#22e884" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M67 47 C64 45.4 59 45.2 56 47" stroke="#22e884" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      {/* Nose slits */}
      <path d="M45 64 C44 68 44 71 45.5 73 C47 71.5 47 67 46.5 64 Z" fill="#000" />
      <path d="M55 64 C56 68 56 71 54.5 73 C53 71.5 53 67 53.5 64 Z" fill="#000" />
      {/* Teeth row */}
      <path
        d="M38 80 L62 80 M42 76 L42 86 M47 76 L47 87 M53 76 L53 87 M58 76 L58 86 M38 76 C38 84 40 88 44 89 M62 76 C62 84 60 88 56 89"
        stroke="#000" strokeWidth="1.8" fill="none" strokeLinecap="round"
      />
      {/* Steak crown: fat rim + dark marbled face */}
      <path
        d="M31 20 C36 10 64 8 72 15 C79 21 76 30 68 33 C58 37 40 36 33 31 C28 27 28 24 31 20 Z"
        fill="#fff" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"
      />
      <path
        d="M35 21 C40 13 62 12 68 18 C73 22 71 28 64 30 C55 33 42 32 37 28 C33 25 33 24 35 21 Z"
        fill="#0a0a0a" stroke="#000" strokeWidth="1.5"
      />
      {/* Marbling */}
      <g stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round">
        <ellipse cx="52" cy="21" rx="4.5" ry="2.6" />
        <path d="M47.5 21 C44 20 41 19.5 38 21.5" />
        <path d="M56.5 21.5 C60 22 63 23 65.5 25" />
        <path d="M50 23.5 C48 26 46 27.5 43 28.5" />
        <path d="M54 23.5 C55.5 26 57.5 27.5 60 28" />
        <path d="M51 18.6 C50 16.5 49 15.5 47 14.8" />
        <path d="M55 18.8 C57 17 59 16 61.5 15.8" />
      </g>
      {/* Vertebrae nub */}
      <path
        d="M30 74 C26 76 24 80 25 84 M28 78 L33 80 M26 82 L31 84"
        stroke="#000" strokeWidth="2" fill="none" strokeLinecap="round"
      />
    </svg>
  );
}
