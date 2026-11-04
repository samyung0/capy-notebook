import type { ReactNode } from 'react';
import { addTopicBodyNameMax } from '@/api/gen/validators';
import type { Topic } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const NO_TOPIC = '__none__';
const CREATE_TOPIC = '__create__';
const TYPED_TOPIC = '__typed__';

// Row pickers copy the code block language trigger: ghost, muted, no chevron.
export function RowPickerTrigger({ children }: { children: ReactNode }) {
  return (
    <SelectTrigger
      className="h-6.5 w-auto translate-y-px bg-transparent px-1.5 py-0 font-semibold text-fg-muted hover:text-fg"
      showDownIcon={false}
      size="sm"
      variant="ghost"
    >
      {children}
    </SelectTrigger>
  );
}

/** A form row's dropdown in the clone and copy dialogs: wider than a settings
 * row's (`layout="row"`), since the label beside it is short. Their workspace
 * dropdown matches it. */
export const FIELD_WIDTH = 'w-52 sm:w-72';

/** A row's topic: an existing one, none (Other files), or (with
 * onCreateRequest) New topic, which the caller swaps for NewTopicInput. topicName shows a
 * typed topic the server creates later. `field` draws a form dropdown
 * instead of the ghost row picker. */
export function TopicSelect({
  topics,
  value,
  topicName,
  current,
  disabled,
  field,
  onChange,
  onCreateRequest,
}: {
  topics: Topic[];
  value: string | null;
  topicName?: string | null;
  /** Tags the item's own topic (null: Other files) "Current" in the list. */
  current?: string | null;
  disabled?: boolean;
  /** A form dropdown; `full` spans its container (the Upload tab's Topic). */
  field?: boolean | 'full';
  onChange: (value: string | null) => void;
  onCreateRequest?: () => void;
}) {
  const label = (
    // Plain text for Other files: SelectValue would copy the option's muted
    // colour and cancel the trigger's hover colour.
    <span className={cn('line-clamp-1', !field && 'max-w-36')}>
      {topicName ?? (value ? <SelectValue /> : m.topic_other_files())}
    </span>
  );
  return (
    <Select
      disabled={disabled}
      onValueChange={(value) => {
        if (value === CREATE_TOPIC) {
          onCreateRequest?.();
          return;
        }
        if (value === TYPED_TOPIC) return;
        onChange(value === NO_TOPIC ? null : value);
      }}
      // A typed topic has no id yet; it gets its own item so the list
      // points at it rather than at Other files.
      value={topicName ? TYPED_TOPIC : (value ?? NO_TOPIC)}
    >
      {field ? (
        <SelectTrigger
          className={field === 'full' ? 'w-full' : FIELD_WIDTH}
          layout={field === 'full' ? undefined : 'row'}
        >
          {label}
        </SelectTrigger>
      ) : (
        <RowPickerTrigger>{label}</RowPickerTrigger>
      )}
      <SelectContent align="end" className={field ? undefined : 'max-w-47'}>
        <SelectGroup>
          {topicName && (
            <SelectItem size="sm" value={TYPED_TOPIC}>
              <span className="line-clamp-1 translate-y-px">{topicName}</span>
            </SelectItem>
          )}
          {topics.map((topic) => (
            <SelectItem
              hint={current === topic.id ? m.destination_current() : null}
              key={topic.id}
              size="sm"
              value={topic.id}
            >
              <span className="line-clamp-1 translate-y-px">{topic.name}</span>
            </SelectItem>
          ))}
          {/* Other files last, as the Files panel lists it (mock T4). */}
          <SelectItem
            hint={current === null ? m.destination_current() : null}
            size="sm"
            value={NO_TOPIC}
          >
            <span className="text-fg-muted">{m.topic_other_files()}</span>
          </SelectItem>
        </SelectGroup>
        {onCreateRequest && (
          <>
            <SelectSeparator />
            <SelectGroup className="scroll-my-0">
              <SelectItem size="sm" value={CREATE_TOPIC}>
                <span className="flex items-center gap-1.5">
                  <Icon className="-translate-y-px" name="plus" size={12} />
                  {m.source_new_topic()}
                </span>
              </SelectItem>
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/** The name field New topic opens: Enter or the check confirms a non-blank
 * name, Escape cancels. */
export function NewTopicInput({
  field,
  value,
  onChange,
  onConfirm,
  onCancel,
}: {
  /** Full-size input matching TopicSelect's `field` dropdown. */
  field?: boolean;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={cn('flex items-center', field && [FIELD_WIDTH, 'gap-1'])}>
      <Input
        autoFocus
        maxLength={addTopicBodyNameMax}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Inside a form dialog, Enter names the topic, not submits.
            event.preventDefault();
            onConfirm();
          }
          if (event.key === 'Escape') onCancel();
        }}
        placeholder={m.source_new_topic_name()}
        size={field ? 'md' : 'sm'}
        value={value}
        variant={field ? 'light' : 'underline'}
        wrapperClassName={field ? 'min-w-0 flex-1' : undefined}
      />
      <IconButton
        disabled={!value.trim()}
        icon="check"
        label={m.source_create_topic()}
        onClick={onConfirm}
        size={field ? 'sm' : 'xs'}
        variant="ghost-hover"
      />
    </div>
  );
}

/** A typed topic name as the server files it: an existing topic of that
 * name in any case, else a new one created with the item. */
export function topicByName(topics: Topic[] | undefined, name: string) {
  const existing = topics?.find(
    (topic) => topic.name.toLowerCase() === name.toLowerCase()
  );
  return {
    topicId: existing?.id ?? null,
    topicName: existing ? null : name,
  };
}
