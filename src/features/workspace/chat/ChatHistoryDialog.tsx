import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog, useIsPhone } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { ArchivedChatsDialog } from './ArchivedChatsDialog';
import { ConversationList } from './ConversationList';

const NEW_CHAT_TINT =
  'border-transparent bg-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1/80';

/** Chat history where the left panel is closed: the left panel's chat list
 * in a dialog (New chat moves into the header on phones), and See archived. */
export function ChatHistoryDialog({
  workspaceId,
  open,
  onClose,
  activeId,
  onOpen,
  onNew,
  onRemoved,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRemoved: (id: string) => void;
}) {
  const phone = useIsPhone();
  const [archivedOpen, setArchivedOpen] = useState(false);
  function startNew() {
    onNew();
    onClose();
  }
  return (
    <>
      <SimpleDialog
        action={
          phone && (
            <Button
              className={NEW_CHAT_TINT}
              iconLeft="newChat"
              onClick={startNew}
              type="button"
              variant="outline"
            >
              {m.chat_new()}
            </Button>
          )
        }
        onClose={onClose}
        open={open}
        title={m.chat_history()}
        width={500}
      >
        <div className="-mx-2.5 flex min-h-0 flex-col">
          <ConversationList
            activeId={activeId}
            listClassName="sm:max-h-[min(55dvh,380px)]"
            onNew={phone ? undefined : startNew}
            onOpen={(id) => {
              onOpen(id);
              onClose();
            }}
            onRemoved={onRemoved}
            workspaceId={workspaceId}
          />
        </div>
        <div className="-ml-2 flex">
          <Button
            iconLeft="archive"
            onClick={() => setArchivedOpen(true)}
            size="sm"
            type="button"
            variant="ghost-hover"
          >
            {m.chat_see_archived()}
          </Button>
        </div>
      </SimpleDialog>
      <ArchivedChatsDialog
        onClose={() => setArchivedOpen(false)}
        open={archivedOpen}
        workspaceId={workspaceId}
      />
    </>
  );
}
