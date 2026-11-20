import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import '@/features/questions/trailMap/trailMap.css';

/** The map's ink at sticker size, for an empty page. */
export function InkBook() {
  return (
    <svg
      aria-hidden
      className="trail-map block h-auto w-[140px] overflow-visible sm:w-[168px]"
      viewBox="0 0 96 72"
    >
      <path
        className="tm-card tm-ink"
        d="M10 22 Q29 16 48 23 L48 60 Q29 53 10 59 Z"
      />
      <path
        className="tm-card tm-ink"
        d="M48 23 Q67 16 86 22 L86 59 Q67 53 48 60 Z"
      />
      <path
        className="tm-ink-soft"
        d="M16 30 Q28 26 42 30 M16 37 Q28 33 42 37 M16 44 Q26 41 36 44 M54 30 Q66 26 80 30 M54 37 Q66 33 80 37 M54 44 Q64 41 74 44"
      />
      <path className="tm-ink-thin" d="M8 61 Q29 55 48 62 Q67 55 88 61" />
    </svg>
  );
}

/** A workspace with nothing in it: the ink, a short title and, for those who
 * may add, the one button that adds a file. */
export function WorkspaceEmpty({ onUpload }: { onUpload?: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <InkBook />
      <p className="t-subtitle">{m.workspace_empty_title()}</p>
      {onUpload && (
        <Button iconLeft="upload" onClick={onUpload}>
          {m.action_add_file()}
        </Button>
      )}
    </div>
  );
}
