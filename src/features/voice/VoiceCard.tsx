import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { recordingType } from '@/features/workspace/chat/voiceRecording';
import { m } from '@/i18n';
import { VoiceOverlay } from './VoiceOverlay';
import {
  askByVoice,
  setAccountVoiceOpen,
  useAccountVoiceOpen,
} from './voiceAsk';
import './voice.css';

/**
 * The sidebar's voice card, above Settings, inside a slowly turning rainbow
 * ring: it opens the account voice overlay (`onOpen` closes the phone
 * drawer). The mic sits where the rows' icons do, so the 70px rail shows only
 * the mic in its ring. Hidden where the browser cannot record.
 */
export function VoiceCard({ onOpen }: { onOpen?: () => void }) {
  const [supported] = useState(() => recordingType() !== null);
  if (!supported) return null;
  return (
    <button
      className="relative mb-2 flex w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-[14px] bg-surface frosted:bg-(--frost-fill) py-[7.5px] pr-3 pl-[7px] text-fg transition-transform frosted:hover:bg-page-hover hover:bg-page-hover active:scale-[0.98]"
      onClick={() => {
        onOpen?.();
        setAccountVoiceOpen(true);
      }}
      type="button"
    >
      <span aria-hidden className="voice-ring voice-edge" />
      {/* As tall as the two lines beside it, so the ring keeps its height
          on the rail. */}
      <span className="flex size-7 shrink-0 items-center justify-center">
        <Icon name="microphone" size={19} />
      </span>
      {/* data-label fades them with the rail's other labels. */}
      <span
        className="flex min-w-0 flex-col text-left leading-tight"
        data-label
      >
        <span className="voice-shimmer-text truncate font-semibold">
          {m.voice_card_title()}
        </span>
        <span className="t-meta truncate text-fg-muted">
          {m.voice_card_hint()}
        </span>
      </span>
    </button>
  );
}

/** The account voice overlay, once in the app shell: its question starts a
 * new account chat, shown on Chat's page. */
export function AccountVoiceOverlay() {
  const open = useAccountVoiceOpen();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <VoiceOverlay
      onOpenChange={setAccountVoiceOpen}
      onSend={(text) => {
        askByVoice(text);
        if (!pathname.startsWith('/chat'))
          void navigate({
            params: { conversationId: undefined },
            to: '/chat/{-$conversationId}',
          });
      }}
      open={open}
      workspaceId={null}
    />
  );
}

/** The workspace panel foot's voice button, in Search's old place: its
 * question starts a new chat in this workspace. */
export function VoiceFooterButton({
  workspaceId,
  onSend,
}: {
  workspaceId: string;
  onSend: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [supported] = useState(() => recordingType() !== null);
  if (!supported) return null;
  return (
    <>
      <ToolbarButton label={m.voice_card_title()} onClick={() => setOpen(true)}>
        <Icon name="microphone" />
      </ToolbarButton>
      <VoiceOverlay
        onOpenChange={setOpen}
        onSend={onSend}
        open={open}
        workspaceId={workspaceId}
      />
    </>
  );
}
