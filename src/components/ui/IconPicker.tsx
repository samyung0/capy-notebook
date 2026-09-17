import { useId, useState } from 'react';
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
  const descriptionID = useId();
  const style = iconStyles.find((item) => item.id === styleID)!;
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
      <DialogContent aria-describedby={descriptionID} className="max-w-[620px]">
        <DialogTitle>{m.icon_choose()}</DialogTitle>
        <p className="t-meta -mt-3 mb-4 text-fg-muted" id={descriptionID}>
          {m.icon_picker_hint()}
        </p>
        <div
          aria-label={m.icon_style()}
          className="mb-5 flex gap-1 overflow-x-auto pb-2"
          role="group"
        >
          {iconStyles.map((item) => (
            <Button
              aria-pressed={styleID === item.id}
              key={item.id}
              onClick={() => setStyleID(item.id)}
              size="sm"
              type="button"
              variant={styleID === item.id ? 'dark' : 'ghost-hover'}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div
          aria-label={style.label}
          className="grid grid-cols-4 gap-2 sm:grid-cols-6"
          role="group"
        >
          {style.avatars.map((icon) => (
            <button
              aria-label={icon.id}
              aria-pressed={draft === icon.id}
              className={cn(
                'relative aspect-square rounded-card border-2 p-1.5 outline-none transition-colors hover:bg-page-hover focus-visible:ring-2 focus-visible:ring-action',
                draft === icon.id
                  ? 'border-action bg-page-hover'
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
                <span className="absolute right-0.5 bottom-0.5 rounded-full bg-action p-0.5 text-action-fg">
                  <Icon name="check" size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button
            onClick={() => setOpen(false)}
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          <Button
            disabled={!draft}
            onClick={() => {
              if (draft) {
                onChange(draft);
                setOpen(false);
              }
            }}
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
