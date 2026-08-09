import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { formatFileSize } from '@/features/files/fileUtils';
import type { HeavyMaterial, HeavyMaterialChoice } from './heavyDocument';

/**
 * Interstitial for a document heavy enough to be worth a warning. It offers a
 * cheaper way in rather than refusing: read-only skips the collaboration
 * handshake and the editing plugins, which is most of the cost of a large note.
 */
export function HeavyMaterialGate({
  material,
  title,
  onChoose,
}: {
  material: HeavyMaterial;
  title: string;
  onChoose: (choice: HeavyMaterialChoice) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-card bg-tint-warning text-tint-warning-fg">
        <Icon className="size-6.5" name="warning" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <p className="t-card-title font-bold">This note is large</p>
        <p>
          {title} is {formatFileSize(material.sizeBytes)} across{' '}
          {material.nodeCount.toLocaleString()} blocks. Editing it may be slow
          on this device.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <Button
          data-testid="heavy-material-read-only"
          onClick={() => onChoose('readOnly')}
          variant="accent"
        >
          Open read-only
        </Button>
        <Button
          data-testid="heavy-material-open"
          onClick={() => onChoose('interactive')}
          variant="outline"
        >
          Open anyway
        </Button>
      </div>
    </div>
  );
}
