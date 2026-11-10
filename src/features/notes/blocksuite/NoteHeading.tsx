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

/* The note's column, as the editor lays its own out (pageEditor.css): 912px
   with 96px margins, the 16px gutter on phones, no cap at full width. */
const COLUMN = 'mx-auto w-full px-4 sm:px-24';

/**
 * The top of a note's body (Epo 2026-11-10, mocks P1 and I1): the file's name
 * as the title, and a collapsed Info row with what the file carries.
 *
 * The title is the file's name, not text in the note: typing there and leaving
 * the field (or Enter) renames the file, and a rename from the header, the tree
 * or another tab shows here. `words` counts the note's words when Info opens.
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
    <div
      className={cn(COLUMN, 'pt-10 sm:pt-16', !fullWidth && 'max-w-[912px]')}
    >
      <NoteTitle material={material} onEnter={onEnter} readonly={readonly} />
      <NoteInfo material={material} readonly={readonly} words={words} />
    </div>
  );
}

/* 40px at 700 from 768px, shrinking as the note's headings do (note-fs). */
const TITLE =
  'note-fs block w-full resize-none overflow-hidden bg-transparent px-0.5 py-[3px] font-bold leading-[1.2] text-fg outline-none placeholder:text-fg-muted';

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
  const { getValues, register, reset, trigger } = useForm<TitleFields>({
    defaultValues: { title: material.title },
    resolver: zodResolver(titleSchema),
  });
  const field = useRef<HTMLTextAreaElement | null>(null);
  const grow = () => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  // A rename from elsewhere shows here, unless this field is being typed in.
  useEffect(() => {
    if (document.activeElement !== field.current)
      reset({ title: material.title });
    grow();
  }, [material.title, reset]);

  const save = async () => {
    // An empty or too long name is not saved: the file keeps its name.
    if (!(await trigger('title'))) {
      reset({ title: material.title });
      grow();
      return;
    }
    const title = getValues('title').trim();
    if (title !== material.title) update({ id: material.id, patch: { title } });
  };

  const style = { '--note-fs': 40 } as React.CSSProperties;
  if (readonly || !material.capabilities.canEdit)
    return (
      <div className={cn(TITLE, 'break-words')} style={style}>
        {material.title}
      </div>
    );
  const { ref, ...title } = register('title', { onBlur: () => void save() });
  return (
    <textarea
      {...title}
      aria-label={m.common_title()}
      className={TITLE}
      maxLength={updateMaterialBodyTitleMax}
      onInput={grow}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        onEnter();
      }}
      placeholder={m.note_title_placeholder()}
      ref={(element) => {
        ref(element);
        field.current = element;
      }}
      rows={1}
      style={style}
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
  const canMove = !readonly && material.capabilities.canEdit;
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
