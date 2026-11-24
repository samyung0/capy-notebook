import { lazy, Suspense, useState } from 'react';
import type { Question, QuestionPart } from '@/api/types';
import { IconButton } from '@/components/ui/IconButton';
import { useResolvedAsset } from '@/features/materials/MediaAssetView';
import { fullPartLabel, questionItems } from '@/features/questions/groups';
import { stripMarks } from '@/features/questions/parseMarkedText';
import {
  CanvasPicture,
  marksText,
  QuestionBlockView,
} from '@/features/questions/QuestionView';
import type {
  LearnerPart,
  LearnerQuestion,
  QuestionBlock,
} from '@/features/questions/types';
import { m } from '@/i18n';
import type { PinnedQuestion } from './DrawingBoardScreen';

// The full-screen look loads on its first open.
const MediaPreview = lazy(() =>
  import('@/features/materials/MediaPreview').then((mod) => ({
    default: mod.MediaPreview,
  }))
);

type AnyQuestion = Question | LearnerQuestion;
type AnyPart = QuestionPart | LearnerPart;

/** A drawn canvas above the one answered (S3, Epo 2026-11-23): "The
 * question's canvas" over its picture, small in the pinned card, and an
 * enlarge button at its foot that opens it full screen. */
function PinnedCanvas({ image }: { image: string }) {
  const [asset] = useResolvedAsset(image);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="t-meta text-fg-muted">{m.question_canvas_above()}</p>
      <div className="relative">
        <CanvasPicture image={image} />
        {asset.status === 'ready' && (
          <IconButton
            className="absolute right-1.5 bottom-1.5"
            icon="maximize"
            label={m.question_canvas_above_open()}
            onClick={() => {
              setOpened(true);
              setOpen(true);
            }}
            size="sm"
            tooltip
            variant="outline"
          />
        )}
      </div>
      {opened && asset.status === 'ready' && (
        <Suspense fallback={null}>
          <MediaPreview
            onOpenChange={setOpen}
            open={open}
            title={m.question_canvas_above()}
          >
            <img
              alt={m.question_canvas_above()}
              className="max-h-full max-w-full rounded-card bg-white"
              src={asset.url}
            />
          </MediaPreview>
        </Suspense>
      )}
    </div>
  );
}

/** Blocks as the pinned card shows them: a drawn canvas as PinnedCanvas, an
 * empty one as nothing, `answered` (the canvas the board is) left out. */
function pinnedBlocks(blocks: QuestionBlock[], answered?: QuestionBlock) {
  return blocks.map((block, i) =>
    block === answered ? null : block.type === 'canvas' ? (
      'board' in block && <PinnedCanvas image={block.image} key={i} />
    ) : (
      <QuestionBlockView block={block} key={i} />
    )
  );
}

const questionTitle = (questionNumber: number | undefined) =>
  questionNumber === undefined
    ? m.drawing_answer_question()
    : m.quiz_editor_question({ number: questionNumber });

const firstText = (blocks: QuestionBlock[]) => {
  const first = blocks.find((block) => block.type === 'text');
  return first?.type === 'text' ? stripMarks(first.text) : '';
};

/** A canvas part's question as its board pins it: the stem's, its group's and
 * the part's text and figures, then the canvases above it as small pictures
 * that open larger (S3); its own canvas is left to the board. */
export function pinnedQuestion(
  question: AnyQuestion,
  part: AnyPart,
  questionNumber: number | undefined
): PinnedQuestion {
  const label =
    question.parts.length > 1 ? fullPartLabel(question, part.id) : '';
  const number = questionTitle(questionNumber);
  const group = question.groups?.find((item) => item.id === part.group);
  const above = [...question.stem, ...(group?.blocks ?? [])];
  const canvases = above.filter((block) => block.type === 'canvas');
  return {
    body: (
      <div className="flex flex-col gap-2 text-fg-secondary">
        {pinnedBlocks(
          [...above, ...part.blocks].filter((block) => block.type !== 'canvas')
        )}
        {pinnedBlocks(canvases)}
      </div>
    ),
    marks: marksText(part.marks),
    short: [questionNumber, label].filter(Boolean).join(' '),
    summary: firstText(part.blocks),
    title: label ? `${number} ${label}` : number,
  };
}

/** A stem's or group's canvas as its board pins it, answered for the parts
 * that share it (S1, Epo 2026-11-23): the stem, the group's text and
 * figures, then each of those parts with its label, text and marks, the
 * canvas itself left to the board. */
export function pinnedSharedQuestion(
  question: AnyQuestion,
  canvas: QuestionBlock,
  parts: AnyPart[],
  labels: string[],
  questionNumber: number | undefined,
  groupId?: string
): PinnedQuestion {
  const group = question.groups?.find((item) => item.id === groupId);
  const groupLabel = group
    ? (questionItems<AnyPart>(question).find(
        (item) => item.kind === 'group' && item.group.id === group.id
      )?.label ?? '')
    : '';
  const number = questionTitle(questionNumber);
  return {
    body: (
      <div className="flex flex-col gap-2 text-fg-secondary">
        {pinnedBlocks(question.stem, canvas)}
        {pinnedBlocks(group?.blocks ?? [], canvas)}
        {parts.map((part, i) => (
          <div className="flex flex-col gap-2" key={part.id}>
            <p className="flex items-baseline gap-2">
              <b className="text-fg">{labels[i]}</b>
              <span className="t-meta text-fg-muted">
                {marksText(part.marks)}
              </span>
            </p>
            {pinnedBlocks(
              part.blocks.filter((block) => block.type !== 'canvas')
            )}
          </div>
        ))}
      </div>
    ),
    marks: marksText(parts.reduce((sum, part) => sum + part.marks, 0)),
    short: [questionNumber, groupLabel].filter(Boolean).join(' '),
    summary:
      firstText(group?.blocks ?? question.stem) ||
      firstText(parts[0]?.blocks ?? []),
    title: groupLabel ? `${number} ${groupLabel}` : number,
  };
}
