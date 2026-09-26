import { useState } from 'react';
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
import { SectionGallery } from './SectionGallery';

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
  return (
    <Dialog
      onOpenChange={(next) => {
        if (next) setDraft(value);
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
          const content = event.currentTarget as HTMLElement;
          (
            content.querySelector<HTMLElement>('[aria-pressed="true"]') ??
            content.querySelector<HTMLElement>('[role="region"]')
          )?.focus();
        }}
      >
        <DialogTitle className="shrink-0 pr-8">{m.icon_choose()}</DialogTitle>
        <SectionGallery
          className="h-[350px] min-[22.5rem]:h-[400px] min-[30rem]:h-[440px]"
          initialSectionId={
            iconStyles.find((item) =>
              item.avatars.some((icon) => icon.id === value)
            )?.id
          }
          label={m.icon_style()}
          sections={iconStyles.map((item) => ({
            content: (
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
            ),
            count: item.avatars.length,
            id: item.id,
            label: item.label,
            thumbnail: (
              <img
                alt=""
                className="size-7.5 shrink-0 rounded-lg"
                height={30}
                src={item.avatars[0].src}
                width={30}
              />
            ),
          }))}
        />
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
