export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center"
      style={{
        background: '#222222',
        borderRadius: 10,
        flex: `0 0 ${size}px`,
        height: size,
        width: size,
      }}
    >
      <svg
        fill="none"
        height={size * 0.62}
        viewBox="0 0 36 36"
        width={size * 0.62}
      >
        <rect fill="#ffffff" height="4.6" rx="1.8" width="17" x="7" y="7" />
        <rect
          fill="#aef07f"
          height="4.6"
          rx="1.8"
          width="12.5"
          x="7"
          y="15.7"
        />
        <rect fill="#ffffff" height="4.6" rx="1.8" width="17" x="7" y="24.4" />
        <circle cx="26" cy="18" fill="#8c7bd9" r="2.8" />
      </svg>
    </span>
  );
}
