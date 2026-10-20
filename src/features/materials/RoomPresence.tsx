import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import {
  type PresenceDevice,
  type PresencePerson,
  type PresenceStore,
  presencePeople,
} from '@/features/collaboration/presence';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** Avatars before the +N count (Epo 2026-10-20). */
const SHOWN = 3;
/** transitions.dev's avatar group hover: the hovered avatar lifts 4px and
 * grows 5%, each neighbour lifts 0.45 as much as the one before it. */
const LIFT_PX = -4;
const FALLOFF = 0.45;
const SCALE = 1.05;

export function deviceLabel({ browser, os }: PresenceDevice) {
  if (browser && os) return m.presence_device({ browser, os });
  return browser ?? os ?? m.presence_device_unknown();
}

/** An avatar's hover: the person's name and each device they have the
 * document open on. */
export function PresenceCard({ person }: { person: PresencePerson }) {
  return (
    <>
      <span className="font-semibold">
        {person.name ?? m.editor_collaborator()}
      </span>
      {person.devices.map((device) => (
        <span key={`${device.browser}:${device.os}`}>
          {deviceLabel(device)}
        </span>
      ))}
    </>
  );
}

/**
 * Who else is editing the open document (Epo 2026-10-20): one avatar per
 * person, at most three, then a +N count; each avatar's hover lists that
 * person's devices. The user's own avatar shows only while the document is
 * open on another tab or device of theirs, which the room lists (it never
 * lists this tab). Hidden below sm. Hovering spreads the group like
 * transitions.dev's avatar group: a clean lift in, a bouncy return.
 */
export function RoomPresence({ store }: { store: PresenceStore }) {
  const [connections, setConnections] = useState(store.getState().connections);
  useEffect(() => {
    setConnections(store.getState().connections);
    return store.subscribe((state) => setConnections(state.connections));
  }, [store]);
  const people = useMemo(() => presencePeople(connections), [connections]);
  const [hovered, setHovered] = useState<number | null>(null);
  if (people.length === 0) return null;
  const shown = people.slice(0, SHOWN);
  const more = people.length - shown.length;
  // Distances as variables, not an inline transform, so reduced motion's
  // class can keep the avatars still.
  const lift = (index: number) =>
    hovered === null
      ? undefined
      : ({
          '--presence-lift': `${(LIFT_PX * FALLOFF ** Math.abs(index - hovered)).toFixed(3)}px`,
          '--presence-scale': index === hovered ? SCALE : 1,
        } as CSSProperties);
  const itemClass = cn(
    '-ml-1.5 inline-flex rounded-full ring-2 ring-surface first:ml-0',
    'translate-y-[var(--presence-lift,0px)] scale-[var(--presence-scale,1)] transition-[translate,scale] duration-[320ms] motion-reduce:translate-y-0 motion-reduce:scale-100 motion-reduce:transition-none',
    hovered === null
      ? 'ease-(--motion-ease-bounce-strong)'
      : 'ease-(--motion-ease-smooth-out)'
  );
  return (
    <div
      aria-label={m.presence_group()}
      className="mr-1 hidden items-center sm:flex"
      data-testid="room-presence"
      onPointerLeave={() => setHovered(null)}
      role="group"
    >
      {shown.map((person, index) => (
        <Tooltip key={person.person}>
          <TooltipTrigger
            className={cn(itemClass, 'outline-none focus-visible:ring-action')}
            data-presence-person={person.person}
            onPointerEnter={() => setHovered(index)}
            render={<span />}
            style={lift(index)}
            tabIndex={0}
          >
            <Avatar
              className="size-6 text-[10px]"
              name={person.name ?? undefined}
              src={person.avatar ?? undefined}
            />
          </TooltipTrigger>
          <TooltipContent
            className="flex-col items-start gap-0.5"
            side="bottom"
          >
            <PresenceCard person={person} />
          </TooltipContent>
        </Tooltip>
      ))}
      {more > 0 && (
        <span
          aria-label={m.presence_more({ count: more })}
          className={cn(
            itemClass,
            'size-6 items-center justify-center bg-surface-hover-bg font-medium text-[10px] text-fg'
          )}
          data-presence-more={more}
          onPointerEnter={() => setHovered(shown.length)}
          role="img"
          style={lift(shown.length)}
        >
          +{more}
        </span>
      )}
    </div>
  );
}
