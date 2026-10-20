import { useId } from 'react';

const BODY =
  'M8 7h16a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-5.2l-2.8 3.2-2.8-3.2H8a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z';

/** The phone chat button's glossy bubble: a lit face over a darker side for
 * thickness, a top highlight and a soft shadow, tilted 8°. Drawn for the
 * dark purple circle it sits on. */
export function ChatBubbleIcon({ size = 30 }: { size?: number }) {
  // useId's colons would break the url(#…) references.
  const id = useId().replace(/[^\w-]/g, '');
  return (
    <svg
      aria-hidden
      className="block overflow-visible"
      height={size}
      viewBox="0 0 32 32"
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
        <filter height="190%" id={`${id}shadow`} width="180%" x="-40%" y="-40%">
          <feDropShadow
            dx="0"
            dy="1.6"
            floodColor="#000000"
            floodOpacity="0.45"
            stdDeviation="1.3"
          />
        </filter>
      </defs>
      <g transform="rotate(-8 16 16)">
        <g filter={`url(#${id}shadow)`}>
          <path d={BODY} fill="#9487cc" transform="translate(0 1.4)" />
          <path d={BODY} fill={`url(#${id}face)`} />
        </g>
        <path
          d="M8.6 8.2h14.8a3 3 0 0 1 3 3v1.6H5.6v-1.6a3 3 0 0 1 3-3z"
          fill={`url(#${id}shine)`}
        />
      </g>
    </svg>
  );
}
