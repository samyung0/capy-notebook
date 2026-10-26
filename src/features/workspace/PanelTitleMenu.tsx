import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';

export interface PanelView<T extends string> {
  icon: IconName;
  label: string;
  value: T;
}

/** A workspace panel's title that switches its view: the current view's name
 * with a chevron, opening the others with a check on the current one.
 * `extra` items follow under a separator, e.g. Study, which opens elsewhere. */
export function PanelTitleMenu<T extends string>({
  value,
  views,
  onChange,
  extra = [],
}: {
  value: T;
  views: PanelView<T>[];
  onChange: (value: T) => void;
  extra?: MenuItem[];
}) {
  const current = views.find((view) => view.value === value);
  return (
    <Menu
      align="start"
      items={[
        ...views.map((view) => ({
          checked: view.value === value,
          icon: view.icon,
          label: view.label,
          onClick: () => onChange(view.value),
        })),
        ...extra.map((item, i) => ({ ...item, separated: i === 0 })),
      ]}
      trigger={
        <button
          className={cn(
            BASE_BUTTON_STYLE,
            'group/title -ml-0.5 flex h-8 min-w-0 items-center gap-1 px-1.5 text-fg hover:bg-surface-hover-bg data-[state=open]:bg-surface-hover-bg'
          )}
          data-panel-title
          type="button"
        >
          <span className="t-subtitle min-w-0 truncate">{current?.label}</span>
          <Icon
            className="shrink-0 text-fg-muted transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-in-out) group-data-[state=open]/title:rotate-180"
            name="chevronDown"
            size={16}
          />
        </button>
      }
    />
  );
}
