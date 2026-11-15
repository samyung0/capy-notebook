import { useParams } from '@tanstack/react-router';
import { createItemBankQuestionBodyTagsItemMax } from '@/api/gen/validators';
import { useItemBanks, useSaveItemBankQuestion } from '@/api/itemBanks';
import type { ItemBank, Question, Topic } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { Popover, PopoverTrigger } from '@/components/ui/Popover';
import {
  ToolbarPopoverButton,
  ToolbarPopoverContent,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { userToast } from '@/components/ui/userToast';
import { withTopics } from '@/features/questions/TopicField';
import { withoutBlanks } from '@/features/questions/types';
import { m } from '@/i18n';
import { bankName } from './bankText';

/** A topic's name as a bank tag: a tag holds no comma, so each becomes a
 * space, and it is cut to a tag's length by whole characters, never half an
 * emoji. */
export const topicTag = (name: string) => {
  let tag = '';
  for (const char of name.replaceAll(',', ' ').replace(/\s+/g, ' ').trim()) {
    if (tag.length + char.length > createItemBankQuestionBodyTagsItemMax) break;
    tag += char;
  }
  return tag.trim();
};

/** The copy a bank takes (Epo 2026-11-15): its class's own bank keeps the
 * topics it counts toward; any other bank (My bank) gets each topic's name as
 * a plain tag instead. */
export function bankCopy(question: Question, bank: ItemBank, topics: Topic[]) {
  const copy = withoutBlanks(question);
  if (bank.kind === 'workspace' && bank.id === topics[0]?.workspaceId)
    return {
      question: withTopics(
        copy,
        topics.map((topic) => topic.id)
      ),
      tags: [],
    };
  const tags = new Set(topics.map((topic) => topicTag(topic.name)));
  tags.delete('');
  return { question: withTopics(copy, []), tags: [...tags] };
}

/**
 * A quiz question's Add to bank (mock QuizMenus): a submenu of the banks the
 * editor may use, this class's bank and My bank, each taking a copy of the
 * question as it stands. Mounted with its menu, so the banks load on open.
 */
export function AddToBankItem({
  disabled,
  onDone,
  question,
  topics,
}: {
  /** Keys still loading, or the question isn't complete. */
  disabled?: boolean;
  /** Closes the question's menu. */
  onDone: () => void;
  question: Question;
  /** The topics it counts toward: its own, else its quiz's. */
  topics: Topic[];
}) {
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId?: string;
  };
  const { data: banks = [] } = useItemBanks(workspaceId, !disabled);
  const { mutateAsync: save } = useSaveItemBankQuestion();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <ToolbarPopoverButton disabled={disabled}>
          <span className="flex size-4.5 shrink-0 items-center justify-center">
            <Icon name="archive" />
          </span>
          <span className="min-w-0 flex-1">{m.bank_add_to()}</span>
          <Icon className="ml-auto" name="chevronRight" />
        </ToolbarPopoverButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-52" side="left">
        {banks.map((bank) => (
          <ToolbarPopoverItem
            key={bank.id}
            label={bankName(bank)}
            onClick={() => {
              onDone();
              void save({
                bank: bank.id,
                ...bankCopy(question, bank, topics),
              }).then(() =>
                userToast({ title: m.bank_added({ bank: bankName(bank) }) })
              );
            }}
          />
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}
