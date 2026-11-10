import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
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

/**
 * The top of a note's body (Epo 2026-11-10, mocks P1 and I1): the file's name
 * as the title, and a collapsed Info row with what the file carries.
 *
 * The title is the file's name, not text in the note: typing there and leaving
 * the field (or Enter) renames the file, and a rename from the header, the tree
 * or another tab shows here. `words` counts the note's words when Info opens.
 *
 * Its column is the editor's own (pageEditor.css): 912px with 96px margins, the
 * 16px gutter once the note's box is 640px or narrower, no cap at full width.
 */
export function NoteHeading({
  fullWidth,
  material,
  onEnter,
  readonly,
  words,
}: {
  fullWidth: boolean;
  material: Material;
  /** Enter in the title: the note takes the caret. */
  onEnter: () => void;
  readonly: boolean;
  words: () => number;
}) {
  return (
    <div className="@container">
      <div
        className={cn(
          'mx-auto w-full @min-[641px]:px-24 px-4 @min-[641px]:pt-16 pt-10',
          !fullWidth && 'max-w-[912px]'
        )}
      >
        <NoteTitle material={material} onEnter={onEnter} readonly={readonly} />
        <NoteInfo material={material} readonly={readonly} words={words} />
      </div>
    </div>
  );
}

function NoteTitle({
  material,
  onEnter,
  readonly,
}: {
  material: Material;
  onEnter: () => void;
  readonly: boolean;
}) {
  const { mutate: update } = useUpdateMaterial(material.workspaceId);
  const { getValues, register, reset, setValue, trigger } =
    useForm<TitleFields>({
      defaultValues: { title: material.title },
      resolver: zodResolver(titleSchema),
    });
  const field = useRef<HTMLTextAreaElement | null>(null);
  // Whether this field was typed in since it last showed the file's name: only
  // then does leaving it rename, so a rename from elsewhere is never undone.
  const typed = useRef(false);
  const show = (title: string) => {
    typed.current = false;
    reset({ title });
  };
  // A rename from elsewhere shows here, unless this field is being typed in.
  useEffect(() => {
    if (!typed.current) show(material.title);
  }, [material.title]);
  // The field's height follows its text: after every render (a reset writes the
  // field on the render after it) and when its column's width changes.
  useEffect(() => autosize(field.current));
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
    if (!typed.current) return;
    // An empty or too long name is not saved: the file keeps its name.
    if (!(await trigger('title'))) {
      show(material.title);
      return;
    }
    const title = getValues('title').trim();
    typed.current = false;
    if (title === material.title) return;
    update(
      { id: material.id, patch: { title } },
      // A rename that fails shows the file's name again, not the one refused,
      // unless the field is being typed in again by then.
      {
        onError: () => {
          if (!typed.current) show(material.title);
        },
      }
    );
  };

  const editable = !readonly && material.capabilities.canEdit;
  const { ref, ...title } = register('title', { onBlur: () => void save() });
  return (
    <textarea
      {...title}
      aria-label={m.common_title()}
      // 40px at 700 from 768px, shrinking as the note's headings do (note-fs).
      className="note-fs block w-full resize-none overflow-hidden bg-transparent px-0.5 py-[3px] font-bold text-fg leading-[1.2] outline-none placeholder:text-fg-muted"
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
        onEnter();
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
  readonly,
  words,
}: {
  material: Material;
  readonly: boolean;
  words: () => number;
}) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [count, setCount] = useState(0);
  const { data: topics } = useTopics(material.workspaceId);
  const { mutate: move } = useMoveMaterial(material.workspaceId);
  const topic = topics?.find(({ id }) => id === material.topicId);
  const topicName = material.topicId
    ? (topic?.name ?? '')
    : m.topic_other_files();
  // A standalone note has no topics to move between, as its header has no Move.
  const canMove =
    !readonly && material.capabilities.canEdit && Boolean(material.workspaceId);
  return (
    <div className="mt-2 mb-2 border-divider border-y text-sm">
      <button
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between px-0.5 text-fg-secondary"
        onClick={() => {
          if (!open) setCount(words());
          setOpen(!open);
        }}
        type="button"
      >
        {m.note_info()}
        <Icon
          className={cn('transition-transform', open && 'rotate-180')}
          name="chevronDown"
        />
      </button>
      {open && (
        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 px-0.5 pb-3 sm:grid-cols-[140px_1fr]">
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
          <dt className="text-fg-secondary">{m.list_col_updated()}</dt>
          <dd>{new Date(material.updatedAt).toLocaleString()}</dd>
          <dt className="text-fg-secondary">{m.note_info_words()}</dt>
          <dd>{count.toLocaleString()}</dd>
        </dl>
      )}
      {moving && (
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
