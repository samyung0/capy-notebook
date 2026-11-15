import { useMaterial, useMe } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { SkeletonList } from '@/components/ui/feedback';
import {
  copyLabel,
  keepsCopyOf,
  type RoomCopy,
  useRoomSeed,
} from '@/features/collaboration/deviceCopy';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import { storedQuestions } from '@/features/materials/storedItems';
import type { NoteEditorStatus } from '@/features/notes/editorMode';
import { QuizEditor, QuizReadSplit } from '@/features/quizzes/QuizEditor';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';

/** A graded quiz's Questions tab (Epo 2026-11-15): its quiz edited in place
 * with the quiz page's editor, read only to someone who can't edit it. A
 * published one reaches members on Republish (Settings). */
export function GradedQuizQuestions({
  onStatusChange,
  quizId,
}: {
  onStatusChange: (status: NoteEditorStatus | null) => void;
  quizId: string;
}) {
  const {
    data: material,
    error,
    isError,
    isPending,
    refetch,
  } = useMaterial(quizId, { errorBoundary: false });
  const { data: me } = useMe({ errorBoundary: false });
  const seed = useRoomSeed(quizId, me?.id);
  if (isPending)
    return <SkeletonList className="mt-5" count={6} rowHeight={44} />;
  if (isError)
    return (
      <ErrorState
        className="h-auto py-20"
        errorId={unexpectedErrorId(error)}
        onRetry={() => void refetch()}
        title={m.assignment_load_failed()}
        variant="panel"
      />
    );
  const sources = (
    <SourcesLine className="pb-4" provenance={material.provenance} />
  );
  if (!material.capabilities.canEditContent)
    return (
      <QuizReadSplit
        questions={storedQuestions(material.content)}
        sources={sources}
      />
    );
  const copy: RoomCopy = {
    keep: me && keepsCopyOf(material) ? copyLabel(material, me.id) : undefined,
    seed,
  };
  return (
    <QuizEditor
      copy={copy}
      key={quizId}
      onStatusChange={onStatusChange}
      quizId={quizId}
      sources={sources}
      stored={storedQuestions(material.content)}
      title={material.title}
      topicId={material.topicId}
      workspaceId={material.workspaceId}
    />
  );
}
