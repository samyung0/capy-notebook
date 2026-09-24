import { useCallback, useId, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconStyles } from '@/lib/icon-catalog';
import { Button } from './Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from './Dialog';
import { Icon } from './Icon';

/** Chooses a local draft; the containing form owns persistence. */
export function IconPicker({
  value,
  onChange,
  disabled = false,
}: {
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [styleID, setStyleID] = useState(iconStyles[0].id);
  const pickerID = useId();
  const galleryRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  const syncStyle = useCallback(() => {
    const gallery = galleryRef.current;
    if (!gallery) return;
    const top =
      gallery.scrollTop +
      Number.parseFloat(getComputedStyle(gallery).paddingTop);
    let index = 0;
    sectionRefs.current.forEach((section, i) => {
      if (section && section.offsetTop <= top + 1) index = i;
    });
    // The last section may be too short to reach the top of the gallery.
    if (
      gallery.scrollTop > 0 &&
      gallery.scrollTop + gallery.clientHeight >= gallery.scrollHeight - 1
    ) {
      index = iconStyles.length - 1;
    }
    setStyleID(iconStyles[index].id);
  }, []);

  const observeGallery = useCallback(
    (node: HTMLDivElement | null) => {
      galleryRef.current = node;
      if (!node) return;
      const observer = new ResizeObserver(syncStyle);
      observer.observe(node);
      return () => {
        observer.disconnect();
        galleryRef.current = null;
      };
    },
    [syncStyle]
  );

  const scrollToStyle = (index: number, behavior: ScrollBehavior) => {
    const gallery = galleryRef.current;
    const section = sectionRefs.current[index];
    if (!(gallery && section)) return;
    gallery.scrollTo({
      behavior,
      top:
        section.offsetTop -
        Number.parseFloat(getComputedStyle(gallery).paddingTop),
    });
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) {
          setDraft(value);
          setStyleID(
            iconStyles.find((item) =>
              item.avatars.some((icon) => icon.id === value)
            )?.id ?? iconStyles[0].id
          );
        }
        setOpen(next);
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button disabled={disabled} size="sm" type="button" variant="outline">
          {m.icon_choose()}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        cardScrollContainerClassName="min-h-0 overflow-hidden px-4 min-[30rem]:px-5 md:px-5.5"
        className="max-w-[912px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          scrollToStyle(
            iconStyles.findIndex((item) => item.id === styleID),
            'instant'
          );
          const gallery = galleryRef.current;
          const selected = gallery?.querySelector<HTMLButtonElement>(
            '[aria-pressed="true"]'
          );
          (selected ?? gallery)?.focus();
        }}
      >
        <DialogTitle className="shrink-0 pr-8">{m.icon_choose()}</DialogTitle>
        <div className="flex h-[350px] min-h-0 min-[22.5rem]:h-[400px] min-[30rem]:h-[440px]">
          <nav
            aria-label={m.icon_style()}
            className="hidden w-[172px] shrink-0 overflow-y-auto pr-4 md:block"
          >
            <p className="t-label px-2 pt-1 pb-3 text-fg-muted">
              {m.icon_style()}
            </p>
            {iconStyles.map((item, index) => (
              <Button
                aria-controls={`${pickerID}-${item.id}`}
                aria-current={styleID === item.id ? 'location' : undefined}
                className={cn(
                  'mb-1 h-auto min-h-11.5 w-full justify-start gap-2 px-2 py-1.75 text-fg-muted',
                  styleID === item.id &&
                    'bg-tint-accent-1/60 text-tint-accent-1-fg hover:bg-tint-accent-1'
                )}
                key={item.id}
                onClick={() =>
                  scrollToStyle(
                    index,
                    window.matchMedia('(prefers-reduced-motion: reduce)')
                      .matches
                      ? 'instant'
                      : 'smooth'
                  )
                }
                size="sm"
                type="button"
                variant="ghost-hover"
              >
                <img
                  alt=""
                  className="size-7.5 shrink-0 rounded-lg"
                  height={30}
                  src={item.avatars[0].src}
                  width={30}
                />
                <span>{item.label}</span>
                <span className="t-label ml-auto font-normal text-fg-muted">
                  {item.avatars.length}
                </span>
              </Button>
            ))}
          </nav>
          <div
            aria-label={m.icon_style()}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-0 pt-0! pb-3 outline-none focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg sm:p-4.5 md:border-divider md:border-l md:p-6"
            onScroll={syncStyle}
            ref={observeGallery}
            role="region"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus enables native keyboard scrolling of the gallery.
            tabIndex={0}
          >
            {iconStyles.map((item, index) => (
              <section
                aria-labelledby={`${pickerID}-${item.id}-title`}
                className="pb-6 last:pb-0 min-[30rem]:pb-7"
                id={`${pickerID}-${item.id}`}
                key={item.id}
                ref={(node) => {
                  sectionRefs.current[index] = node;
                }}
              >
                <h3
                  className="t-subtitle mx-0.5 mb-3 min-[30rem]:mb-3.5"
                  id={`${pickerID}-${item.id}-title`}
                >
                  {item.label}
                </h3>
                <div className="grid grid-cols-3 gap-1.5 min-[22.5rem]:grid-cols-4 min-[30rem]:grid-cols-6">
                  {item.avatars.map((icon) => (
                    <button
                      aria-label={icon.id}
                      aria-pressed={draft === icon.id}
                      className={cn(
                        'relative aspect-square rounded-card border-2 p-1 outline-none transition-colors hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg min-[30rem]:p-1.25',
                        draft === icon.id
                          ? 'border-solid-accent-1 bg-tint-accent-1 hover:bg-tint-accent-1'
                          : 'border-transparent'
                      )}
                      key={icon.id}
                      onClick={() => setDraft(icon.id)}
                      type="button"
                    >
                      <img
                        alt=""
                        className="h-full w-full rounded-button"
                        height={80}
                        loading="lazy"
                        src={icon.src}
                        width={80}
                      />
                      {draft === icon.id && (
                        <span className="absolute right-1 bottom-1 rounded-full bg-tint-accent-1-fg p-0.5 text-surface">
                          <Icon name="check" size={12} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <DialogFooter className="shrink-0 flex-row">
          <Button
            className="flex-1 min-[30rem]:flex-none"
            onClick={() => setOpen(false)}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            className="flex-1 min-[30rem]:flex-none"
            disabled={!draft}
            onClick={() => {
              if (draft) {
                onChange(draft);
                setOpen(false);
              }
            }}
            size="lg"
            type="button"
            variant="accent"
          >
            {m.icon_use()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
