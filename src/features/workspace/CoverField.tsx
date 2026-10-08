import { useState } from 'react';
import type { CoverConfig } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { CoverArt, useCoverPaint } from '@/components/ui/CoverArt';
import type { WorkspaceCardFields } from '@/components/ui/WorkspaceCard';
import { m } from '@/i18n';
import { CoverPicker } from './CoverPicker';

/**
 * A workspace card's cover in settings: the cover with Change cover, or
 * Choose cover alone. Both rows are h-14, so picking or removing one moves
 * nothing below it.
 */
export function CoverField({
  value,
  onChange,
  ownerId,
  card,
  disabled,
}: {
  value: CoverConfig | null;
  onChange: (next: CoverConfig | null) => void;
  ownerId: string;
  card: WorkspaceCardFields;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-14 items-center gap-4">
      {value && <CoverStrip cover={value} name={card.name} ownerId={ownerId} />}
      <Button
        disabled={disabled}
        onClick={() => setOpen(true)}
        size={value ? 'sm' : 'md'}
        type="button"
        variant="outline"
      >
        {value ? m.cover_change() : m.cover_choose()}
      </Button>
      <CoverPicker
        card={card}
        onChange={onChange}
        onOpenChange={setOpen}
        open={open}
        ownerId={ownerId}
        value={value}
      />
    </div>
  );
}

function CoverStrip({
  cover,
  name,
  ownerId,
}: {
  cover: CoverConfig;
  name: string;
  ownerId: string;
}) {
  const paint = useCoverPaint(ownerId, name, cover);
  return (
    <span className="relative h-full min-w-0 flex-1 overflow-hidden rounded-button">
      <CoverArt paint={{ ...paint, shade: false }} />
    </span>
  );
}
