import { useNavigate } from '@tanstack/react-router';
import { useContinue, useHideContinue, useMe } from '@/api/hooks';
import type { HistoryRow } from '@/api/types';
import { CardActions } from '@/components/ui/CardActions';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import { PREF_KEYS, writePref } from '@/lib/localPrefs';
import { ContinueLink } from './ContinueLink';
import { groupName } from './reviewText';

const CONTINUE_SHOWN = 3;

/** Continue (Epo 2026-11-13, board B): up to three revisions and tries left
 * partway within the week, newest first, across workspaces or in
 * `workspaceId`'s Dashboard. Hidden while there are none. */
export function ContinueCards({ workspaceId }: { workspaceId?: string }) {
  const { data: rows = [] } = useContinue(workspaceId);
  const navigate = useNavigate();
  if (!rows.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="t-subtitle">{m.continue_title()}</h2>
        {/* Everything in progress, Continue's removed and older ones too: the
            account's History, or the workspace Study's. */}
        <UnderlineLink
          noArrow
          onClick={() =>
            workspaceId
              ? navigate({
                  search: { status: 'open', study: 'history' as const },
                  to: '.',
                })
              : navigate({
                  search: { status: 'open', tab: 'history' as const },
                  to: '/learning',
                })
          }
        >
          {m.action_see_all()}
        </UnderlineLink>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* The server sends spares: a removed card's place fills at once. */}
        {rows.slice(0, CONTINUE_SHOWN).map((row) => (
          <ContinueCard
            key={`${row.kind}-${row.id}`}
            row={row}
            showWorkspace={!workspaceId}
          />
        ))}
      </div>
    </section>
  );
}

function ContinueCard({
  row: r,
  showWorkspace,
}: {
  row: HistoryRow;
  showWorkspace: boolean;
}) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const { mutate: hide } = useHideContinue();
  const materialId = r.materialId ?? '';
  const workspaceId = r.workspaceId ?? '';
  const group = r.group ?? 'workspace';
  // A topic gone since leaves nothing to begin again.
  const restartable = r.kind !== 'revision' || group !== 'topic' || !!r.topicId;
  function startOver() {
    hide(r);
    if (r.kind === 'revision')
      return navigate({
        params: { workspaceId },
        search: { from: 'review' as const, group, topicId: r.topicId },
        to: '/learning/review/$workspaceId',
      });
    if (r.kind === 'quiz') {
      writePref(PREF_KEYS.quizAttempt('account', materialId), '');
      return navigate({
        params: { quizId: materialId },
        to: '/quizzes/$quizId/attempt',
      });
    }
    if (me) writePref(PREF_KEYS.flashcardRun(me.id, materialId), null);
    return navigate({
      params: { flashcardSetId: materialId },
      to: '/flashcards/$flashcardSetId',
    });
  }
  const title =
    r.kind === 'revision'
      ? m.learning_workspace_review({
          workspace:
            group === 'workspace'
              ? r.workspaceName
              : groupName(group, r.topics[0]),
        })
      : r.name;
  const progress = { answered: r.answered, total: r.items };
  return (
    <div className="group/card relative flex min-w-0 flex-col rounded-[10px] border border-divider px-4 py-3.5 hover:bg-surface-hover-bg">
      <div className="flex min-w-0 items-center gap-2 pr-7">
        {r.kind === 'revision' ? (
          <Icon
            className="shrink-0 text-tint-warning-fg"
            name="retry"
            size={18}
          />
        ) : (
          <FileIcon
            className="size-4.5 shrink-0"
            name={materialIconName(r.kind)}
          />
        )}
        {/* The whole card is the link. */}
        <ContinueLink
          className="truncate font-semibold after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-action"
          row={r}
        >
          {title}
        </ContinueLink>
      </div>
      {showWorkspace && (
        <p className="t-meta mt-1.5 truncate text-fg-muted">
          {r.workspaceName}
        </p>
      )}
      <ProgressBar
        className={showWorkspace ? 'mt-5' : 'mt-4'}
        height={4}
        tone="accent"
        value={r.items ? (100 * r.answered) / r.items : 0}
      />
      <p className="t-meta mt-2 flex justify-between gap-3 text-fg-muted">
        <span className="truncate">
          {r.kind === 'quiz'
            ? m.continue_checked(progress)
            : r.kind === 'flashcards'
              ? m.continue_cards(progress)
              : m.continue_answered(progress)}
        </span>
        <span className="shrink-0">{relativeTime(r.at)}</span>
      </p>
      <CardActions className="top-2 right-2">
        <Menu
          items={[
            { label: m.continue_remove(), onClick: () => hide(r) },
            ...(restartable
              ? [{ label: m.continue_start_over(), onClick: startOver }]
              : []),
          ]}
        />
      </CardActions>
    </div>
  );
}
