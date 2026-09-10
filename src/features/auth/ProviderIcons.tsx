import type { SVGProps } from 'react';

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
