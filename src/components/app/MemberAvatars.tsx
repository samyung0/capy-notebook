import {
  type ComponentProps,
  type PointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';

export type MemberAvatar = { avatarUrl?: string; id: string; name: string };

// 30px avatars overlapping by 8px, 8px apart after your own; at most 7
// avatars, fewer when the row is narrower, the rest in a +N chip.
const SIZE = 30;
const STEP = 22;
const OWN_GAP = 8;
const MAX_SHOWN = 7;
// The hovered avatar lifts 4px and grows 5%; each neighbour lifts 0.45 of
// the one before it (transitions.dev avatar-group-hover).
const LIFT = -4;
const FALLOFF = 0.45;
const SCALE = 1.05;
const EASE_IN = 'cubic-bezier(0.22, 1, 0.36, 1)';
const EASE_OUT = 'cubic-bezier(0.34, 3.85, 0.64, 1)';

/** One avatar of the row, lifted by the row's hover. */
const AVATAR =
  'relative size-7.5 shrink-0 rounded-full ring-2 ring-surface [transform:translateY(var(--lift,0))_scale(var(--lift-scale,1))] [transition:transform_320ms] motion-reduce:transform-none motion-reduce:transition-none';

/** How many avatars fit in `width` (you included), with a chip for `total`. */
function fitCount(width: number, total: number) {
  for (let shown = Math.min(total, MAX_SHOWN); shown > 1; shown -= 1) {
    const chip = shown < total ? STEP : 0;
    if (SIZE + OWN_GAP + SIZE + STEP * (shown - 2) + chip <= width)
      return shown;
  }
  return 1;
}

/** Your avatar as the workspace panel foot's menu trigger, with the unread
 * dot. */
export function OwnAvatarButton({
  avatarUrl,
  className,
  dot,
  name,
  pending = false,
  ...props
}: ComponentProps<'button'> & {
  avatarUrl?: string;
  dot?: boolean;
  name?: string;
  pending?: boolean;
}) {
  return (
    <button
      aria-busy={pending}
      // The ring is the avatar's border, so focus shows as an outline.
      className={cn(
        AVATAR,
        'cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-action focus-visible:outline-offset-2',
        className
      )}
      data-avatar
      title={name}
      type="button"
      {...props}
    >
      {pending ? (
        <Skeleton className="size-7.5 rounded-full" />
      ) : (
        <Avatar
          aria-hidden
          className="size-7.5 text-[11px]"
          name={name}
          src={avatarUrl}
        />
      )}
      {dot && (
        <span className="absolute top-0 right-0 size-2.25 rounded-full bg-solid-error ring-2 ring-surface" />
      )}
    </button>
  );
}

/** The workspace panel foot's members: `own` (your avatar, the menu
 * trigger), then the other members overlapping, lifting under the pointer. */
export function MemberAvatars({
  members,
  own,
}: {
  /** The other members, you excluded. */
  members: MemberAvatar[];
  own: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width)
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const total = members.length + 1;
  const shown = width ? fitCount(width, total) : 1;
  const others = members.slice(0, shown - 1);
  const rest = total - shown;

  // Written straight to the avatars so hovering never re-renders.
  function lift(target: Element | null) {
    const avatars = ref.current?.querySelectorAll<HTMLElement>('[data-avatar]');
    if (!avatars) return;
    const index = target ? [...avatars].indexOf(target as HTMLElement) : -1;
    avatars.forEach((avatar, i) => {
      avatar.style.transitionTimingFunction = index < 0 ? EASE_OUT : EASE_IN;
      const shift = index < 0 ? 0 : LIFT * FALLOFF ** Math.abs(index - i);
      avatar.style.setProperty('--lift', `${shift.toFixed(3)}px`);
      avatar.style.setProperty('--lift-scale', i === index ? `${SCALE}` : '1');
    });
  }

  return (
    <div
      className="flex h-9 min-w-0 flex-1 items-center px-1 [&>[data-slot=dropdown-menu-anchor]]:mr-2"
      onPointerLeave={() => lift(null)}
      onPointerOver={(event: PointerEvent) =>
        lift((event.target as Element).closest('[data-avatar]'))
      }
      ref={ref}
    >
      {own}
      {others.map((member, i) => (
        <span
          className={cn(AVATAR, i > 0 && '-ml-2')}
          data-avatar
          key={member.id}
          title={member.name}
        >
          <Avatar
            aria-hidden
            className="size-7.5 text-[11px]"
            name={member.name}
            src={member.avatarUrl}
          />
        </span>
      ))}
      {rest > 0 && (
        <span
          className={cn(
            AVATAR,
            'grid place-items-center bg-surface-hover-bg font-bold text-[11px] text-fg-muted',
            others.length > 0 && '-ml-2'
          )}
          data-avatar
        >
          +{rest}
        </span>
      )}
    </div>
  );
}
