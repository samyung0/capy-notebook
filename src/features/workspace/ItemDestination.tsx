import { useState } from 'react';
import { useTopics, useWorkspaces } from '@/api/hooks';
import { SettingRow } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import {
  FIELD_WIDTH,
  NewTopicInput,
  TopicSelect,
  topicByName,
} from './TopicSelect';

const STANDALONE = '__standalone__';

type TopicPick = { topicId: string | null; topicName: string | null };

/**
 * Where Clone to… and Move to… put an item: a workspace the user edits (or,
 * with `standalone`, No workspace) and a topic there. The item's own
 * workspace is picked when the user edits it, and in it the item's topic;
 * else the first workspace they edit (a standalone clone stays standalone).
 */
export function useItemDestination({
  topicId,
  standalone,
  workspaceId: source,
}: {
  /** The item's topic, preselected while its workspace is picked. */
  topicId?: string | null;
  /** Offers No workspace (Clone to…). */
  standalone: boolean;
  /** The item's workspace; empty for a standalone item. */
  workspaceId: string;
}) {
  const { data: workspaces, isPending } = useWorkspaces();
  const editable = (workspaces ?? []).filter((ws) => ws.capabilities.canEdit);
  const [picked, setPicked] = useState('');
  const fallback = standalone && !source ? STANDALONE : (editable[0]?.id ?? '');
  const destination =
    picked ||
    (editable.some((ws) => ws.id === source)
      ? source
      : fallback || (standalone ? STANDALONE : ''));
  const workspaceId = destination === STANDALONE ? '' : destination;
  const { data: topics } = useTopics(workspaceId);
  // A topic the user chose, for the workspace it belongs to.
  const [chosen, setChosen] = useState<
    (TopicPick & { workspaceId: string }) | null
  >(null);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const topic: TopicPick =
    chosen?.workspaceId === workspaceId
      ? chosen
      : {
          topicId: workspaceId === source ? (topicId ?? null) : null,
          topicName: null,
        };

  return {
    destination,
    editable,
    newTopic,
    pending: isPending,
    /** Picks a workspace (or STANDALONE): its topic starts over. */
    pick(id: string) {
      setPicked(id);
      setNewTopic(null);
    },
    /** The chosen topic, a name still being typed included. */
    resolve(): TopicPick {
      const typed = newTopic?.trim();
      return typed ? topicByName(topics, typed) : topic;
    },
    setNewTopic,
    setTopic: (next: TopicPick) => setChosen({ ...next, workspaceId }),
    source,
    sourceTopicId: topicId ?? null,
    standalone,
    topic,
    topics,
    workspaceId,
  };
}

export type ItemDestination = ReturnType<typeof useItemDestination>;

/** The workspace and topic dropdowns. `markCurrent` (Move to…) tags the
 * item's own workspace and topic "Current". */
export function DestinationFields({
  dest,
  disabled,
  markCurrent = false,
  onPick,
}: {
  dest: ItemDestination;
  disabled: boolean;
  markCurrent?: boolean;
  /** After the user picks a workspace. */
  onPick?: () => void;
}) {
  const { workspaceId } = dest;
  const current = m.destination_current();
  return (
    <>
      <SettingRow title={m.question_ui_workspace()}>
        <Select
          onValueChange={(id) => {
            // The form's hidden native select reports '' while options load.
            if (!id) return;
            dest.pick(id);
            onPick?.();
          }}
          value={dest.destination}
        >
          <SelectTrigger
            aria-label={m.question_ui_workspace()}
            className={FIELD_WIDTH}
            disabled={dest.pending || disabled}
            layout="row"
            loading={dest.pending}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dest.standalone && (
              <SelectItem value={STANDALONE}>
                <span className="text-fg-muted">{m.clone_no_workspace()}</span>
              </SelectItem>
            )}
            {dest.editable.map((ws) => (
              <SelectItem
                hint={markCurrent && ws.id === dest.source ? current : null}
                key={ws.id}
                value={ws.id}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <img
                    alt=""
                    className="size-5 shrink-0 -translate-y-px rounded-md"
                    src={iconUrl(ws.iconId)}
                  />
                  <span className="truncate">{ws.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {/* Hidden, not removed, without a workspace: no layout shift. */}
      <div
        aria-hidden={!workspaceId}
        className={cn(!workspaceId && 'invisible')}
      >
        <SettingRow title={m.question_ui_topic()}>
          {dest.newTopic === null ? (
            <TopicSelect
              current={
                markCurrent && workspaceId === dest.source
                  ? dest.sourceTopicId
                  : undefined
              }
              disabled={!workspaceId || disabled}
              field
              onChange={(topicId) =>
                dest.setTopic({ topicId, topicName: null })
              }
              onCreateRequest={() => dest.setNewTopic('')}
              topicName={dest.topic.topicName}
              topics={dest.topics ?? []}
              value={dest.topic.topicId}
            />
          ) : (
            <NewTopicInput
              field
              onCancel={() => dest.setNewTopic(null)}
              onChange={dest.setNewTopic}
              onConfirm={() => {
                const name = dest.newTopic?.trim();
                if (!name) return;
                dest.setTopic(topicByName(dest.topics, name));
                dest.setNewTopic(null);
              }}
              value={dest.newTopic}
            />
          )}
        </SettingRow>
      </div>
    </>
  );
}
