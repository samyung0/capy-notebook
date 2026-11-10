import { zodResolver } from '@hookform/resolvers/zod';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import { useMoveMaterial, useTopics, useUpdateMaterial } from '@/api/hooks';
import type { Material } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { MoveToTopicDialog } from '@/features/workspace/MoveToTopicDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const titleSchema = z.object({
  title: z.string().trim().min(1).max(updateMaterialBodyTitleMax),
});
type TitleFields = z.infer<typeof titleSchema>;
const LINE_BREAKS = /\s*[\r\n]+\s*/g;

/** A title field is as tall as its text. */
const autosize = (element: HTMLTextAreaElement | null) => {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
};

/* Which notes have Info open, shared by a note's views (its painted copy, the
   editor, Preview): open in one, it is open in the next, so the note does not
   jump by Info's height as one takes over from another. */
const openInfo = new Set<string>();
const infoWatchers = new Set<() => void>();
const watchInfo = (watch: () => void) => {
  infoWatchers.add(watch);
  return () => {
    infoWatchers.delete(watch);
  };
};

function useInfoOpen(id: string | undefined) {
  const open = useSyncExternalStore(
    watchInfo,
    () => id !== undefined && openInfo.has(id),
    // Closed where a note is rendered to a string.
    () => false
  );
  const setOpen = (next: boolean) => {
    if (id === undefined) return;
    if (next) openInfo.add(id);
    else openInfo.delete(id);
    for (const watch of infoWatchers) watch();
  };
  return [open, setOpen] as const;
}

/** A note's text, block after block, for its word count. */
export function noteText(node: unknown): string {
  if (Array.isArray(node)) return node.map(noteText).join('\n');
  if (!node || typeof node !== 'object') return '';
  const { children, text } = node as { children?: unknown; text?: unknown };
  return typeof text === 'string' ? text : noteText(children);
}

/** Words as the reader's language counts them (a CJK run is several). */
export function countWords(text: string) {
  let count = 0;
  for (const part of new Intl.Segmenter(undefined, {
    granularity: 'word',
  }).segment(text))
    if (part.isWordLike) count++;
  return count;
}

/**
 * The top of a note's body (Epo 2026-11-10, mocks P1 and I1), in both note
 * engines and every view of a note: the file's name as the title, and a
 * collapsed Info row with what the file carries.
 *
 * The title is the file's name, not text in the note: typing there and leaving
 * the field (or Enter) renames the file, and a rename from the header, the tree
 * or another tab shows here. `words` counts the note's words when Info opens.
 * A note painted before its read answers has only its `title`: the same box,
 * read-only, with nothing under Info yet.
 *
 * Its column is the body's: the BlockSuite editor's own (pageEditor.css, 16px
 * gutter once the note's box is 640px or narrower), or with `plate` the Plate
 * note's `note-column`, whose text has no 2px inset. Both cap at 912px unless
 * the note is full width.
 */
export const NoteHeading = memo(function NoteHeading({
  fullWidth,
  material,
  onEnter,
  plate = false,
  readonly,
  title,
  words,
}: {
  fullWidth: boolean;
  /** Undefined until the file's read answers. */
  material: Material | undefined;
  /** Enter in the title: the note takes the caret. */
  onEnter?: () => void;
  plate?: boolean;
  readonly: boolean;
  title: string;
  words: () => number;
}) {
  return (
    // `note-editor` gives the Plate note's title its body's font; its body
    // starts 16px lower than the BlockSuite note's, taken back here, with the
    // Info row kept above the editable that now reaches under it. Only the
    // title and the Info row take the pointer: the padding around them lies
    // over the note's corner buttons (NoteDisplayToggles) and the editable's
    // top edge, which keep their clicks.
    <div
      className={cn(
        plate
          ? 'note-editor pointer-events-none relative z-10 -mb-4'
          : '@container'
      )}
      data-note-heading=""
    >
      <div
        className={cn(
          // The Plate title declares no container (`note-column-head`).
          plate
            ? 'note-column note-column-head'
            : 'mx-auto w-full @min-[641px]:px-24 px-4 @min-[641px]:pt-16 pt-10',
          !fullWidth && 'max-w-[912px]'
        )}
      >
        <NoteTitle
          material={material}
          onEnter={onEnter}
          plate={plate}
          readonly={readonly}
          title={title}
        />
        <NoteInfo
          material={material}
          plate={plate}
          readonly={readonly}
          words={words}
        />
      </div>
    </div>
  );
});

function NoteTitle({
  material,
  onEnter,
  plate,
  readonly,
  title: name,
}: {
  material: Material | undefined;
  onEnter?: () => void;
  plate: boolean;
  readonly: boolean;
  title: string;
}) {
  const { mutate: update } = useUpdateMaterial(material?.workspaceId ?? '');
  const { getValues, register, reset, setValue, trigger } =
    useForm<TitleFields>({
      defaultValues: { title: name },
      resolver: zodResolver(titleSchema),
    });
  const field = useRef<HTMLTextAreaElement | null>(null);
  // Whether this field was typed in since it last showed the file's name: only
  // then does leaving it rename, so a rename from elsewhere is never undone.
  const typed = useRef(false);
  // Bumped when the field is given a name to show: a reset writes the field
  // on the render after it, and only then can its height be measured.
  const [shown, setShown] = useState(0);
  const show = (title: string) => {
    typed.current = false;
    reset({ title });
    setShown((count) => count + 1);
  };
  // A rename from elsewhere shows here, unless this field is being typed in.
  useEffect(() => {
    if (!typed.current) show(name);
  }, [name]);
  // The field's height follows its text: when a name is shown, as it is typed
  // (onInput) and when its column's width changes.
  useEffect(() => autosize(field.current), [shown]);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      autosize(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const save = async () => {
    if (!(typed.current && material)) return;
    // An empty or too long name is not saved: the file keeps its name.
    if (!(await trigger('title'))) {
      show(name);
      return;
    }
    const title = getValues('title').trim();
    typed.current = false;
    if (title === name) return;
    update(
      { id: material.id, patch: { title } },
      // A rename that fails shows the file's name again, not the one refused,
      // unless the field is being typed in again by then.
      {
        onError: () => {
          if (!typed.current) show(name);
        },
      }
    );
  };

  const editable = !readonly && !!material?.capabilities.canEdit;
  const { ref, ...title } = register('title', { onBlur: () => void save() });
  return (
    <textarea
      {...title}
      aria-label={m.common_title()}
      // 40px at 700 from 768px, shrinking as the note's headings do (note-fs).
      className={cn(
        'note-fs pointer-events-auto block w-full resize-none overflow-hidden bg-transparent py-[3px] font-bold text-fg leading-[1.2] outline-none placeholder:text-fg-muted',
        !plate && 'px-0.5'
      )}
      maxLength={updateMaterialBodyTitleMax}
      onInput={(event) => {
        typed.current = true;
        // A name is one line: pasted line breaks become spaces.
        const { value } = event.currentTarget;
        if (LINE_BREAKS.test(value))
          setValue('title', value.replace(LINE_BREAKS, ' '));
        autosize(event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onEnter?.();
      }}
      placeholder={m.note_title_placeholder()}
      readOnly={!editable}
      ref={(element) => {
        ref(element);
        field.current = element;
      }}
      rows={1}
      style={{ '--note-fs': 40 } as React.CSSProperties}
    />
  );
}

function NoteInfo({
  material,
  plate,
  readonly,
  words,
}: {
  material: Material | undefined;
  plate: boolean;
  readonly: boolean;
  words: () => number;
}) {
  const [open, setOpen] = useInfoOpen(material?.id);
  const [moving, setMoving] = useState(false);
  const [count, setCount] = useState(0);
  // Counted when Info opens, here or in another view of this note.
  useEffect(() => {
    if (open) setCount(words());
  }, [open]);
  const workspaceId = material?.workspaceId ?? '';
  // A failed topics read leaves Topic blank: it never takes the note down.
  const { data: topics } = useTopics(workspaceId, { errorBoundary: false });
  const { mutate: move } = useMoveMaterial(workspaceId);
  const topic = topics?.find(({ id }) => id === material?.topicId);
  const topicName = material?.topicId
    ? (topic?.name ?? '')
    : m.topic_other_files();
  // A standalone note has no topics to move between, as its header has no Move.
  const canMove =
    !readonly && !!material?.capabilities.canEdit && Boolean(workspaceId);
  return (
    <div className="pointer-events-auto mt-2 mb-2 border-divider border-y text-sm">
      <button
        aria-expanded={open}
        className={cn(
          'flex h-10 w-full items-center justify-between text-fg-secondary',
          !plate && 'px-0.5'
        )}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {m.note_info()}
        <Icon
          className={cn('transition-transform', open && 'rotate-180')}
          name="chevronDown"
        />
      </button>
      {open && material && (
        <dl
          className={cn(
            'grid grid-cols-[110px_1fr] gap-y-1.5 pb-3 sm:grid-cols-[140px_1fr]',
            !plate && 'px-0.5'
          )}
        >
          <dt className="text-fg-secondary">{m.source_upload_topic()}</dt>
          <dd>
            {canMove ? (
              <button
                className="rounded-sm text-left hover:bg-surface-hover-bg"
                onClick={() => setMoving(true)}
                type="button"
              >
                {topicName}
              </button>
            ) : (
              topicName
            )}
          </dd>
          <dt className="text-fg-secondary">{m.common_created()}</dt>
          <dd>{new Date(material.createdAt).toLocaleDateString()}</dd>
          <dt className="text-fg-secondary">{m.note_info_updated()}</dt>
          <dd>{new Date(material.updatedAt).toLocaleString()}</dd>
          <dt className="text-fg-secondary">{m.note_info_words()}</dt>
          <dd>{count.toLocaleString()}</dd>
        </dl>
      )}
      {moving && material && (
        <MoveToTopicDialog
          currentTopicId={material.topicId}
          onClose={() => setMoving(false)}
          onSelect={(topicId) => move({ id: material.id, topicId })}
          open
          topics={topics ?? []}
        />
      )}
    </div>
  );
}
