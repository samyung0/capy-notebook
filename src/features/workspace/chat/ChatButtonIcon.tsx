import { useId } from 'react';

/** The AI star (Icon's `ai`), in its 24px box. */
const STAR =
  'M12 2.5C12.6 7.6 16.4 11.4 21.5 12C16.4 12.6 12.6 16.4 12 21.5C11.4 16.4 7.6 12.6 2.5 12C7.6 11.4 11.4 7.6 12 2.5Z';

/** The phone chat button's glossy AI star: a lit face over a darker side for
 * thickness, a top highlight and a soft shadow. Drawn for the dark purple
 * circle it sits on. */
export function ChatButtonIcon({ size = 32 }: { size?: number }) {
  // useId's colons would break the url(#…) references.
  const id = useId().replace(/[^\w-]/g, '');
  return (
    <svg
      aria-hidden
      className="block overflow-visible"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <defs>
        <linearGradient id={`${id}face`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d4cdef" />
        </linearGradient>
        <linearGradient id={`${id}shine`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}clip`}>
          <path d={STAR} />
        </clipPath>
        <filter height="190%" id={`${id}shadow`} width="180%" x="-40%" y="-40%">
          <feDropShadow
            dx="0"
            dy="1.2"
            floodColor="#000000"
            floodOpacity="0.45"
            stdDeviation="1"
          />
        </filter>
      </defs>
      <g filter={`url(#${id}shadow)`}>
        <path d={STAR} fill="#9487cc" transform="translate(0 1)" />
        <path d={STAR} fill={`url(#${id}face)`} />
      </g>
      <rect
        clipPath={`url(#${id}clip)`}
        fill={`url(#${id}shine)`}
        height="8"
        width="24"
        y="2.5"
      />
    </svg>
  );
}
