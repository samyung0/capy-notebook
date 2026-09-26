import type { SVGProps } from 'react';

/** Provider logos for sign-in and cloud import buttons. */

export function GoogleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden height="18" viewBox="0 0 24 24" width="18" {...props}>
      <path
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
        fill="#34A853"
      />
      <path
        d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9z"
        fill="#FBBC05"
      />
      <path
        d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5L6.4 10c.8-2.3 3-4 5.6-4z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function MicrosoftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden height="18" viewBox="0 0 24 24" width="18" {...props}>
      <rect fill="#F25022" height="9.5" width="9.5" x="2" y="2" />
      <rect fill="#7FBA00" height="9.5" width="9.5" x="12.5" y="2" />
      <rect fill="#00A4EF" height="9.5" width="9.5" x="2" y="12.5" />
      <rect fill="#FFB900" height="9.5" width="9.5" x="12.5" y="12.5" />
    </svg>
  );
}

export function OneDriveIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden height="18" viewBox="0 0 256 165" width="28" {...props}>
      {/* Icon from SVG Logos by Gil Barbara - https://raw.githubusercontent.com/gilbarbara/logos/master/LICENSE.txt */}
      <path
        d="m154.66 110.682l52.842-50.534c-10.976-42.8-54.57-68.597-97.37-57.62a80 80 0 0 0-46.952 33.51c.817-.02 91.48 74.644 91.48 74.644"
        fill="#0364B8"
      />
      <path
        d="m97.618 45.552l-.002.009a63.7 63.7 0 0 0-33.619-9.543c-.274 0-.544.017-.818.02C27.852 36.476-.432 65.47.005 100.798a63.97 63.97 0 0 0 11.493 35.798l79.165-9.915l60.694-48.94z"
        fill="#0078D4"
      />
      <path
        d="M207.502 60.148a53 53 0 0 0-3.51-.131a51.8 51.8 0 0 0-20.61 4.254l-.002-.005l-32.022 13.475l35.302 43.607l63.11 15.341c13.62-25.283 4.164-56.82-21.12-70.44a52 52 0 0 0-21.148-6.1"
        fill="#1490DF"
      />
      <path
        d="M11.498 136.596a63.91 63.91 0 0 0 52.5 27.417h139.994a51.99 51.99 0 0 0 45.778-27.323l-98.413-58.95z"
        fill="#28A8EA"
      />
    </svg>
  );
}
