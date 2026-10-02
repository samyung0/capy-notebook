import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';

export type HugeIconProps = React.ComponentProps<'svg'> & {
  /** A Hugeicons element, or Capy's own icon as stroked 24×24 path strings. */
  icon: IconSvgElement | readonly string[];
  size?: number;
  strokeWidth?: number;
};

/** Renders one icon at Capy's stroke. `Icon` names them; the Office runtime imports only its own. */
export function HugeIcon({
  icon,
  size = 18,
  strokeWidth = 1.8,
  style,
  ...rest
}: HugeIconProps) {
  const props = {
    'aria-hidden': true,
    'data-icon': true,
    fill: 'none',
    height: size,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeWidth,
    style: { display: 'block', flex: '0 0 auto', ...style },
    viewBox: '0 0 24 24',
    width: size,
    ...rest,
  } as const;
  if (icon.every((d) => typeof d === 'string'))
    return (
      <svg {...props} stroke="currentColor">
        {icon.map((d, i) => (
          <path d={d} key={i} />
        ))}
      </svg>
    );
  return (
    <HugeiconsIcon
      {...props}
      color="currentColor"
      icon={icon as IconSvgElement}
    />
  );
}
